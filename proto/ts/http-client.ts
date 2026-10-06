/**
 * The HTTP/JSON client of a generated service: the other end of http-transcoder.ts, built from the same
 * google.api.http bindings (http-rule.ts). Each rpc becomes a typed method that takes the request message (or
 * its init shape) and resolves to the response message:
 *
 *   const api = createHttpClient(WatchUiService, (call) => fetch(call.url, { method: call.httpMethod, body: call.body }));
 *   const watch = await api.getWatch({ name: 'watches/w1' }); // GET /api/v1/watches/w1
 *
 * The request is written with the wire JSON profile and laid out by the rpc's primary binding: path variables
 * are expanded (http-path.ts encodes them as http.proto asks) and taken out of the message; the body is the
 * rest of the message (`body: "*"`) or one field; the remaining set fields go to the query string (GET,
 * DELETE and body-field methods), in field-number order, nested fields as `a.b`, repeated fields as repeated
 * keys. A map, or a message other than Timestamp and FieldMask, cannot be a query parameter: such a request
 * throws before anything is sent. An AIP-134 update with a field mask (http-rule.ts `updateMask`) sends only
 * the fields its mask names in the body (all of them without a mask, or with `*`), so a REQUIRED field the
 * mask leaves out is not sent as null.
 *
 * A 2xx response is read leniently (an output: unknown fields and enum names are skipped and reported to
 * `onUnrecognized`). Any other response throws RpcStatusError with its google.rpc.Status, or HttpResponseError
 * when the body is not one (a proxy's HTML, an Access login page). The transport is the caller's: it adds
 * credentials, headers (CSRF) and retries, and it may throw for network failures.
 */
import { create, type DescField, type DescMessage, type DescMethod, type JsonObject, type JsonValue, type Message, type MessageInitShape, type MessageShape } from '@bufbuild/protobuf';
import type { GenService, GenServiceMethods } from '@bufbuild/protobuf/codegenv2';
import { FieldMaskError, updatePaths } from './field-mask.ts';
import { expandTemplate, PathTemplateError } from './http-path.ts';
import { httpBindings, type HttpBinding, type HttpMethod } from './http-rule.ts';
import { parseStatus, type Status } from './rpc-status.ts';
import { fromWire, toWire, WireJsonError } from './wire-json.ts';

/** The HTTP request of one call, before transport. */
export interface HttpRequestParts {
  readonly httpMethod: HttpMethod;
  /** The expanded path, without the query. */
  readonly path: string;
  /** Query parameters in order (keys are field paths). */
  readonly query: readonly (readonly [string, string])[];
  /** The JSON body, or undefined for none. */
  readonly body: JsonValue | undefined;
}

/** What the transport sends. */
export interface HttpCall {
  readonly method: DescMethod;
  readonly httpMethod: HttpMethod;
  /** Path and query, relative to the API's origin. */
  readonly url: string;
  /** The JSON text of the body (send it as application/json), or undefined. */
  readonly body: string | undefined;
}

export type HttpSend = (call: HttpCall) => Promise<Response>;

/** A response with a google.rpc.Status body. */
export class RpcStatusError extends Error {
  readonly status: Status;

  constructor(status: Status) {
    super(status.message === '' ? `HTTP ${String(status.httpStatus)}` : status.message);
    this.name = 'RpcStatusError';
    this.status = status;
  }
}

/** A response that is not what the API answers: a non-JSON or non-Status error body, or an unreadable 2xx. */
export class HttpResponseError extends Error {
  readonly httpStatus: number;

  constructor(httpStatus: number, message: string) {
    super(message);
    this.name = 'HttpResponseError';
    this.httpStatus = httpStatus;
  }
}

/** Thrown before anything is sent when a request message cannot be laid out by its binding. */
export class HttpEncodeError extends Error {}

const TIMESTAMP = 'google.protobuf.Timestamp';
const FIELD_MASK = 'google.protobuf.FieldMask';

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: JsonValue | undefined, where: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new HttpEncodeError(`${where} is not a text value`);
}

/** Removes and returns the value at a field path of a wire object (undefined when absent). */
function take(wire: JsonObject, path: readonly string[]): JsonValue | undefined {
  let node: JsonObject = wire;
  for (const name of path.slice(0, -1)) {
    const child = node[name];
    if (!isObject(child)) return undefined;
    node = child;
  }
  const last = path[path.length - 1] ?? '';
  const value = node[last];
  delete node[last];
  return value;
}

/** Appends the set fields of `wire` (a message of `desc`) as query parameters, in field-number order. */
function flatten(desc: DescMessage, wire: JsonObject, prefix: string, out: [string, string][]): void {
  const fields = [...desc.fields].sort((a, b) => a.number - b.number);
  for (const field of fields) {
    const value = wire[field.name];
    if (value === undefined || value === null) continue;
    const key = prefix + field.name;
    if (queryKind(field) === 'message') {
      if (!isObject(value)) throw new HttpEncodeError(`${key} is not a message`);
      flatten(field.message as DescMessage, value, `${key}.`, out);
    } else if (queryKind(field) === 'text') {
      if (Array.isArray(value)) for (const item of value) out.push([key, text(item, key)]);
      else out.push([key, text(value, key)]);
    } else {
      throw new HttpEncodeError(`${key} cannot be a query parameter`);
    }
  }
}

function queryKind(field: DescField): 'text' | 'message' | undefined {
  switch (field.fieldKind) {
    case 'scalar':
    case 'enum':
      return 'text';
    case 'message':
      return field.message.typeName === TIMESTAMP || field.message.typeName === FIELD_MASK ? 'text' : 'message';
    case 'list':
      return field.listKind !== 'message' || field.message.typeName === TIMESTAMP || field.message.typeName === FIELD_MASK ? 'text' : undefined;
    default:
      return undefined;
  }
}

/** The masked paths of a wire object: a new object with only the values at `paths` (dotted field names). */
function pick(wire: JsonObject, paths: readonly string[]): JsonObject {
  const out: JsonObject = {};
  for (const path of paths) {
    const names = path.split('.');
    let from: JsonValue | undefined = wire;
    let to = out;
    for (const [i, name] of names.entries()) {
      if (!isObject(from)) break;
      const value: JsonValue | undefined = from[name];
      if (value === undefined) break;
      if (i === names.length - 1) {
        to[name] = value;
        break;
      }
      const next = isObject(to[name]) ? to[name] : {};
      to[name] = next;
      to = next;
      from = value;
    }
  }
  return out;
}

/** The fields of an update's body that its mask names ('*': all of them). */
function maskedPaths(binding: HttpBinding, message: Message): '*' | readonly string[] {
  const field = binding.updateMask;
  if (field === undefined) return '*';
  try {
    return updatePaths((message as unknown as Record<string, { paths: string[] } | undefined>)[field.localName]);
  } catch (error) {
    if (error instanceof FieldMaskError) throw new HttpEncodeError(`${field.name}: ${error.message}`);
    throw error;
  }
}

/** The HTTP request of `message` by `binding` (the rpc's primary binding unless a test passes another). */
export function encodeHttpRequest(binding: HttpBinding, message: Message): HttpRequestParts {
  const input = binding.method.input;
  let wire: JsonObject;
  try {
    wire = toWire(input, message as never);
  } catch (error) {
    // A value the wire profile cannot write (an int32 out of range, a malformed field mask): nothing is sent.
    if (error instanceof WireJsonError) throw new HttpEncodeError(error.message);
    throw error;
  }
  const values = new Map<string, string>();
  for (const variable of binding.template.variables) {
    const path = variable.fieldPath.join('.');
    values.set(path, text(take(wire, variable.fieldPath), path));
  }
  let path: string;
  try {
    path = expandTemplate(binding.template, values);
  } catch (error) {
    if (error instanceof PathTemplateError) throw new HttpEncodeError(error.message);
    throw error;
  }
  let body: JsonValue | undefined;
  if (binding.body === '*') {
    body = wire;
  } else if (binding.body !== '') {
    body = take(wire, [binding.body]) ?? {};
    const paths = maskedPaths(binding, message);
    if (paths !== '*' && isObject(body)) body = pick(body, paths);
  }
  const query: [string, string][] = [];
  if (binding.body !== '*') flatten(input, wire, '', query);
  return { httpMethod: binding.httpMethod, path, query, body };
}

/** Path and query as one relative URL. */
export function urlOf(parts: Pick<HttpRequestParts, 'path' | 'query'>): string {
  if (parts.query.length === 0) return parts.path;
  return `${parts.path}?${parts.query.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`;
}

export interface HttpClientOptions {
  /** Called with the paths a lenient read skipped (unknown fields and enum names; never values). */
  readonly onUnrecognized?: (method: DescMethod, paths: readonly string[]) => void;
}

type InitOf<D> = D extends DescMessage ? MessageInitShape<D> : never;
type MessageOf<D> = D extends DescMessage ? MessageShape<D> : never;

/** One method per rpc with an HTTP binding, named as protobuf-es names it (`rpc GetWatch` is `getWatch`). */
export type HttpClient<S extends GenServiceMethods> = {
  readonly [K in keyof S]: (request: InitOf<S[K]['input']>) => Promise<MessageOf<S[K]['output']>>;
};

async function readError(response: Response): Promise<Error> {
  let json: unknown;
  try {
    json = JSON.parse(await response.text());
  } catch {
    return new HttpResponseError(response.status, `HTTP ${String(response.status)} without a JSON body`);
  }
  const status = parseStatus(response.status, json);
  return status === null ? new HttpResponseError(response.status, `HTTP ${String(response.status)} without a Status body`) : new RpcStatusError(status);
}

/** A typed client of `service` over `send`. */
export function createHttpClient<S extends GenServiceMethods>(service: GenService<S>, send: HttpSend, options: HttpClientOptions = {}): HttpClient<S> {
  const primary = new Map(httpBindings(service as never).filter((b) => b.primary).map((b) => [b.method.localName, b]));
  const client: Record<string, (request: unknown) => Promise<unknown>> = {};
  for (const [name, binding] of primary) {
    const method = binding.method;
    client[name] = async (init) => {
      const message = create(method.input, init as never);
      const parts = encodeHttpRequest(binding, message);
      const response = await send({ method, httpMethod: parts.httpMethod, url: urlOf(parts), body: parts.body === undefined ? undefined : JSON.stringify(parts.body) });
      if (!response.ok) throw await readError(response);
      let json: unknown;
      try {
        json = JSON.parse(await response.text());
      } catch {
        throw new HttpResponseError(response.status, 'the response is not JSON');
      }
      try {
        const read = fromWire(method.output, json);
        if (read.unrecognized.length > 0) options.onUnrecognized?.(method, read.unrecognized);
        return read.message;
      } catch {
        throw new HttpResponseError(response.status, `the response is not a ${method.output.typeName}`);
      }
    };
  }
  return client as HttpClient<S>;
}
