/**
 * The HTTP/JSON transcoder: serves a generated service over HTTP on a Worker, routed and decoded from its
 * google.api.http bindings (http-rule.ts), in the wire JSON profile (wire-json.ts), with google.rpc.Status
 * errors (rpc-status.ts). An app hands it the service descriptor and one typed handler per rpc:
 *
 *   const api = new HttpTranscoder(LabUiService, { getDeck: (request, ctx) => ..., ... }, {
 *     domain: 'lab.ziyixi.science', maxBodyBytes: 16 * 1024, authorize: (request, route, ctx) => ...,
 *   });
 *   const result = await api.handle(request, ctx, requestId); // null: no route has this path
 *
 * For each request it:
 *
 * 1. matches the path against every binding (http-path.ts: literals before `*` before `**`); no path match
 *    is null (the app's other routes), a path match with another method is 405 METHOD_NOT_ALLOWED with Allow,
 *    OPTIONS is 204 with Allow (and no CORS headers: these APIs are same-origin only), HEAD is GET without
 *    the body;
 * 2. calls `authorize` before reading anything else, so the app's CSRF and Origin checks (packages/edge-auth)
 *    stay in front of every mutation. Authentication itself (Cloudflare Access) runs in the app before
 *    `handle`, for every path;
 * 3. builds the request message: the body (JSON, `application/json`, at most `maxBodyBytes`, UTF-8; `*` or
 *    one field), the path variables and, unless the body is `*`, query parameters (`a.b=1`, repeated keys for
 *    repeated fields; form encoding, so `+` is a space; a malformed or non-UTF-8 escape is refused, as in a
 *    path or body); a field set twice (path and body, or a repeated singular query parameter) is refused.
 *    The result is read with the wire profile's strict mode: an unknown field, query parameter or enum
 *    name, a wrong type or a missing REQUIRED field is INVALID_ARGUMENT. For an AIP-134 update with a field
 *    mask (http-rule.ts `updateMask`), the resource's REQUIRED fields bind only where the mask names them
 *    (an absent mask, an empty one or `*` names every field); a mask path that is malformed, unknown or
 *    leads through a non-message field is INVALID_ARGUMENT, and one naming an OUTPUT_ONLY field is ignored
 *    with that field (the handler reads the paths with field-mask.ts `updatePaths`);
 * 4. applies the field annotations every handler would otherwise repeat: a `(google.api.field_info).format =
 *    UUID4` string must be a UUID v4 (it is lower-cased), and OUTPUT_ONLY fields of the input are cleared
 *    (AIP-203: ignored on input);
 * 5. calls the handler and writes its message with the wire profile (200, `application/json`, `no-store`), or the
 *    PreEncoded answer it returned as it is: wire JSON the handler already holds (a view a Durable Object serialized
 *    once), with extra headers such as an ETag, or 304 Not Modified for a GET whose validator still matches.
 *
 * Errors: a handler throws an RpcError; the transcoder's own reasons (TRANSCODER_REASONS, values of
 * common.errors.v1.CommonReason) are BAD_REQUEST (INVALID_ARGUMENT), METHOD_NOT_ALLOWED (UNIMPLEMENTED, sent
 * as 405) and INTERNAL, and an app answers NOT_FOUND for a path no route has. Anything else thrown (a bug, an
 * answer the wire profile refuses to write) goes through `onUnexpected`, default INTERNAL (500): an app maps
 * only the failures it knows to be transient (a storage call) to UNAVAILABLE itself, so a deterministic bug
 * is never answered as "repeat the request". Error messages are fixed English text: nothing from the request
 * (no field name, value or path) is echoed back.
 */
import {
  getOption,
  ScalarType,
  type DescField,
  type DescMessage,
  type DescMethod,
  type JsonObject,
  type JsonValue,
  type Message,
  type MessageShape,
} from '@bufbuild/protobuf';
import type { GenService, GenServiceMethods } from '@bufbuild/protobuf/codegenv2';
import { reflect, type ReflectMessage } from '@bufbuild/protobuf/reflect';
import { FieldMaskError, parseFieldMask, updatePaths } from './field-mask.ts';
import { field_behavior, FieldBehavior } from './google/api/field_behavior_pb.ts';
import { field_info, FieldInfo_Format } from './google/api/field_info_pb.ts';
import { compareSpecificity, matchTemplate, PathTemplateError, sameShape, splitPath, type Bindings } from './http-path.ts';
import { httpBindings, isTextField, resolveField, type HttpBinding, type HttpMethod } from './http-rule.ts';
import { Code, RpcError, statusBody, type StatusOptions } from './rpc-status.ts';
import { fromWire, toWire, WireJsonError } from './wire-json.ts';

/** A matched route, as `authorize` and the result see it. */
export interface RouteInfo {
  readonly method: DescMethod;
  readonly httpMethod: HttpMethod;
  /** The binding's path template as written in the .proto file. */
  readonly template: string;
  /** GET (and HEAD): reads. Every other method changes state: CSRF and Origin checks apply. */
  readonly safe: boolean;
}

export interface TranscoderOptions<C> {
  /** ErrorInfo.domain of every error, e.g. `lab.ziyixi.science`. */
  readonly domain: string;
  /** The largest request body read (a larger one is BAD_REQUEST before it is parsed). */
  readonly maxBodyBytes: number;
  /** Runs after the route matched and before the body is read; throws an RpcError to refuse. */
  readonly authorize: (request: Request, route: RouteInfo, context: C) => void | Promise<void>;
  /** The user-facing message of a reason (google.rpc.LocalizedMessage), if the API has one. */
  readonly localize?: (reason: string) => StatusOptions['localized'];
  /** Maps anything thrown that is not an RpcError (default: INTERNAL, a bug; never a retryable reason). */
  readonly onUnexpected?: (error: unknown) => RpcError;
}

type MessageOf<D> = D extends DescMessage ? MessageShape<D> : never;

/** The method shapes of a generated service (`ShapeOf<typeof LabUiService>`), for naming its handler types. */
export type ShapeOf<T> = T extends GenService<infer S> ? S : never;

/**
 * An answer a handler already holds as wire JSON text, written as it is instead of encoding a message: a body a Durable
 * Object serialized once, which the Worker passes through without decoding it (Workers Free gives a request 10 ms of
 * CPU), with extra response headers (an ETag). `body: null` answers 304 Not Modified without a body, for a GET whose
 * If-None-Match names the current validator; any other method answering null is a bug (INTERNAL). The transcoder does
 * not check the text: the app's tests prove that it is exactly what toWire writes for the method's output (a strict
 * read of it, written back byte for byte).
 */
export class PreEncoded {
  readonly body: string | null;
  readonly headers: Readonly<Record<string, string>>;

  constructor(body: string | null, headers: Readonly<Record<string, string>> = {}) {
    this.body = body;
    this.headers = headers;
  }
}

/**
 * One typed handler per rpc, keyed as protobuf-es names the methods (`rpc GetDeck` is `getDeck`); it answers the
 * output message, or a PreEncoded answer.
 */
export type ServiceHandlers<S extends GenServiceMethods, C> = {
  readonly [K in keyof S]: (request: MessageOf<S[K]['input']>, context: C) => Promise<MessageOf<S[K]['output']> | PreEncoded>;
};

export interface Transcoded {
  readonly response: Response;
  /** The route that matched; undefined for OPTIONS, 405 and a malformed path. */
  readonly route: RouteInfo | undefined;
  /** The error answered, for the app's log line (reason and status only). */
  readonly error: RpcError | undefined;
}

/** The transcoder's own reasons: values of common.errors.v1.CommonReason, as is NOT_FOUND (unknown paths). */
export const TRANSCODER_REASONS = {
  badRequest: 'BAD_REQUEST',
  notFound: 'NOT_FOUND',
  methodNotAllowed: 'METHOD_NOT_ALLOWED',
  internal: 'INTERNAL',
} as const;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const;
const METHOD_ORDER: readonly string[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INTEGER = /^-?(0|[1-9][0-9]*)$/;
const DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;
const MEDIA_TYPE = /^application\/json\s*(;\s*charset\s*=\s*"?utf-8"?\s*)?$/i;
const TIMESTAMP = 'google.protobuf.Timestamp';
const FIELD_MASK = 'google.protobuf.FieldMask';

function badRequest(message: string): RpcError {
  return new RpcError(Code.INVALID_ARGUMENT, TRANSCODER_REASONS.badRequest, message);
}

/** Per input message: its UUID4 fields, its OUTPUT_ONLY fields and its message fields to walk, found once. */
interface InputPlan {
  readonly uuid: readonly DescField[];
  readonly outputOnly: readonly DescField[];
  readonly nested: readonly DescField[];
}

const plans = new WeakMap<DescMessage, InputPlan>();

function planOf(message: DescMessage): InputPlan {
  let plan = plans.get(message);
  if (plan === undefined) {
    const uuid: DescField[] = [];
    const outputOnly: DescField[] = [];
    const nested: DescField[] = [];
    plan = { uuid, outputOnly, nested };
    plans.set(message, plan); // before recursing: a message may contain itself
    for (const field of message.fields) {
      if (getOption(field, field_behavior).includes(FieldBehavior.OUTPUT_ONLY)) {
        outputOnly.push(field);
        continue;
      }
      if (field.fieldKind === 'scalar' && field.scalar === ScalarType.STRING && getOption(field, field_info).format === FieldInfo_Format.UUID4) {
        uuid.push(field);
      }
      const target =
        field.fieldKind === 'message' || (field.fieldKind === 'list' && field.listKind === 'message') || (field.fieldKind === 'map' && field.mapKind === 'message')
          ? field.message
          : undefined;
      if (target !== undefined && target.typeName !== TIMESTAMP && target.typeName !== FIELD_MASK) {
        planOf(target);
        nested.push(field);
      }
    }
  }
  return plan;
}

/** AIP-203 and AIP-202 on a decoded input: OUTPUT_ONLY fields cleared, UUID4 fields checked and lower-cased. */
function normalizeInput(r: ReflectMessage): void {
  const plan = planOf(r.desc);
  for (const field of plan.outputOnly) r.clear(field);
  for (const field of plan.uuid) {
    if (!r.isSet(field)) continue;
    const value = (r.get(field) as string).toLowerCase();
    if (!UUID4.test(value)) throw badRequest('a UUID4 field is not a UUID v4');
    r.set(field, value);
  }
  for (const field of plan.nested) {
    if (!r.isSet(field)) continue;
    const value = r.get(field);
    if (field.fieldKind === 'message') normalizeInput(value as ReflectMessage);
    else if (field.fieldKind === 'map') for (const [, item] of value as Iterable<[unknown, ReflectMessage]>) normalizeInput(item);
    else for (const item of value as Iterable<ReflectMessage>) normalizeInput(item);
  }
}

/** How a field (or a repeated field's items) is written in a path or query; undefined when it cannot be. */
type TextKind = 'enum' | 'timestamp' | 'fieldmask' | ScalarType;

/** The kind of a message-typed field written as text: Timestamp and FieldMask are strings in the profile. */
function textMessageKind(message: DescMessage): TextKind | undefined {
  if (message.typeName === TIMESTAMP) return 'timestamp';
  return message.typeName === FIELD_MASK ? 'fieldmask' : undefined;
}

function textKind(field: DescField): TextKind | undefined {
  switch (field.fieldKind) {
    case 'enum':
      return 'enum';
    case 'scalar':
      return isTextField(field) ? field.scalar : undefined;
    case 'message':
      return textMessageKind(field.message);
    case 'list':
      if (field.listKind === 'enum') return 'enum';
      if (field.listKind === 'message') return textMessageKind(field.message);
      return isTextField({ fieldKind: 'scalar', scalar: field.scalar } as DescField) ? field.scalar : undefined;
    default:
      return undefined;
  }
}

/** A path variable's or query parameter's text as a wire JSON value (the strict read checks it further). */
function textValue(kind: TextKind, text: string): JsonValue {
  switch (kind) {
    case 'enum':
    case 'timestamp':
    case 'fieldmask':
    case ScalarType.STRING:
      return text;
    case ScalarType.BOOL:
      if (text === 'true') return true;
      if (text === 'false') return false;
      break;
    case ScalarType.DOUBLE:
      if (DECIMAL.test(text)) return Number(text);
      break;
    default:
      if (INTEGER.test(text)) return Number(text);
  }
  throw badRequest('a path or query value is not of its field type');
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Sets `value` at a dotted field path of the wire object; a different value already there is a conflict. */
function setPath(wire: JsonObject, path: readonly string[], value: JsonValue): void {
  let node = wire;
  for (const name of path.slice(0, -1)) {
    const child = node[name];
    if (child === undefined) {
      const created: JsonObject = {};
      node[name] = created;
      node = created;
    } else if (isObject(child)) {
      node = child;
    } else {
      throw badRequest('a field is set twice');
    }
  }
  const last = path[path.length - 1] ?? '';
  if (Object.hasOwn(node, last) && node[last] !== value) throw badRequest('a field is set twice');
  node[last] = value;
}

/**
 * The parameters of a raw query (`URL.search`), in order: `&`-separated, `+` is a space, keys and values
 * percent-decoded as UTF-8; empty pieces are skipped. Throws BAD_REQUEST for a malformed or non-UTF-8 escape,
 * which URLSearchParams would turn into U+FFFD (different data) instead.
 */
function queryParameters(search: string): [string, string][] {
  const out: [string, string][] = [];
  for (const piece of search.replace(/^\?/, '').split('&')) {
    if (piece === '') continue;
    const equals = piece.indexOf('=');
    const [key, value] = equals === -1 ? [piece, ''] : [piece.slice(0, equals), piece.slice(equals + 1)];
    try {
      out.push([decodeURIComponent(key.replaceAll('+', ' ')), decodeURIComponent(value.replaceAll('+', ' '))]);
    } catch {
      throw badRequest('the query has malformed percent-escapes');
    }
  }
  return out;
}

/**
 * The paths of an AIP-134 update's mask (the wire value of `update_mask`) when they name some fields only;
 * undefined for a full replacement (no mask, an empty one or `*`).
 */
function partialPaths(value: JsonValue | undefined): readonly string[] | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const paths = updatePaths({ paths: parseFieldMask(value) });
    return paths === '*' ? undefined : paths;
  } catch (error) {
    if (error instanceof FieldMaskError) throw badRequest('the update_mask is malformed');
    throw error;
  }
}

/** AIP-134 with a mask: every path names a field of the resource, and each REQUIRED one it names is present. */
function checkMasked(resource: DescMessage, json: JsonValue | undefined, paths: readonly string[]): void {
  for (const path of paths) {
    let desc = resource;
    let node = json;
    const names = path.split('.');
    for (const [i, name] of names.entries()) {
      const field = desc.fields.find((f) => f.name === name);
      if (field === undefined) throw badRequest('the update_mask names an unknown field');
      const value = isObject(node) ? node[name] : undefined;
      if (i < names.length - 1) {
        if (field.fieldKind !== 'message') throw badRequest('the update_mask leads through a field that is not a message');
        desc = field.message;
        node = value;
        continue;
      }
      if (value === undefined && getOption(field, field_behavior).includes(FieldBehavior.REQUIRED)) {
        throw badRequest('a REQUIRED field the update_mask names is missing');
      }
      // A masked message is replaced whole, so its own REQUIRED fields bind (the first read skipped them).
      if (value !== undefined && field.fieldKind === 'message' && textMessageKind(field.message) === undefined) {
        try {
          fromWire(field.message, value, { strict: true });
        } catch (error) {
          if (error instanceof WireJsonError) throw badRequest(`the request is not a valid ${resource.typeName}`);
          throw error;
        }
      }
    }
  }
}

/** The request body's bytes (at most `limit`); null when it is larger. */
async function readLimited(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && !(/^[0-9]{1,10}$/.test(declared.trim()) && Number(declared.trim()) <= limit)) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** The response of a PreEncoded answer: its text with the JSON headers and its own, or 304 without a body. */
function preEncodedResponse(answer: PreEncoded, route: RouteInfo, head: boolean): Response {
  if (answer.body === null) {
    if (!route.safe) throw new TypeError('only a GET answers 304');
    return new Response(null, { status: 304, headers: { 'cache-control': JSON_HEADERS['cache-control'], 'x-content-type-options': 'nosniff', ...answer.headers } });
  }
  return new Response(head ? null : answer.body, { status: 200, headers: { ...JSON_HEADERS, ...answer.headers } });
}

export class HttpTranscoder<S extends GenServiceMethods, C> {
  readonly #service: GenService<S>;
  readonly #handlers: ServiceHandlers<S, C>;
  readonly #options: TranscoderOptions<C>;
  #routes: readonly HttpBinding[] | undefined;

  /**
   * Builds and checks the route table at once, so a Worker that constructs its transcoder at global scope pays
   * for reading the descriptors' options during startup (outside any request's CPU time), and a binding this
   * transcoder does not support fails the Worker's startup (the deploy) instead of a request. Throws as
   * routes() does.
   */
  constructor(service: GenService<S>, handlers: ServiceHandlers<S, C>, options: TranscoderOptions<C>) {
    this.#service = service;
    this.#handlers = handlers;
    this.#options = options;
    for (const route of this.routes()) planOf(route.method.input);
  }

  /**
   * Every binding, most specific first; built and checked once. Throws HttpRuleError for a binding this
   * transcoder does not support, and TypeError for a missing handler or two bindings of one HTTP method that
   * match the same paths.
   */
  routes(): readonly HttpBinding[] {
    if (this.#routes === undefined) {
      const routes = httpBindings(this.#service as never).sort((a, b) => compareSpecificity(a.template, b.template));
      for (const [i, a] of routes.entries()) {
        if (typeof (this.#handlers as Record<string, unknown>)[a.method.localName] !== 'function') throw new TypeError(`no handler for ${a.method.name}`);
        for (const b of routes.slice(i + 1)) {
          if (a.httpMethod === b.httpMethod && sameShape(a.template, b.template)) {
            throw new TypeError(`${a.method.name} and ${b.method.name} bind the same ${a.httpMethod} paths`);
          }
        }
      }
      this.#routes = routes;
    }
    return this.#routes;
  }

  /** The Status response of `error` (also for the app's own failures, e.g. authentication). */
  errorResponse(error: RpcError, requestId?: string, head = false): Response {
    const body = statusBody(error, { domain: this.#options.domain, requestId, localized: this.#options.localize?.(error.reason) });
    const response = new Response(head ? null : JSON.stringify(body), { status: error.httpStatus, headers: JSON_HEADERS });
    for (const [name, value] of Object.entries(error.headers)) response.headers.set(name, value);
    return response;
  }

  /** The response for `request`, or null when no binding's path matches it. */
  async handle(request: Request, context: C, requestId?: string): Promise<Transcoded | null> {
    const url = new URL(request.url);
    const split = splitPath(url.pathname);
    if (split === null) return null;
    const head = request.method === 'HEAD';
    const matches: { route: HttpBinding; bindings: Bindings }[] = [];
    let malformed = false;
    for (const route of this.routes()) {
      try {
        const bindings = matchTemplate(route.template, split);
        if (bindings !== null) matches.push({ route, bindings });
      } catch (error) {
        if (!(error instanceof PathTemplateError)) throw error;
        malformed = true;
      }
    }
    if (matches.length === 0 && !malformed) return null;
    if (matches.length === 0) {
      const error = badRequest('the path has malformed percent-escapes');
      return { response: this.errorResponse(error, requestId, head), route: undefined, error };
    }
    const allowed = new Set<string>(matches.map((m) => m.route.httpMethod));
    if (allowed.has('GET')) allowed.add('HEAD');
    allowed.add('OPTIONS');
    const allow = METHOD_ORDER.filter((m) => allowed.has(m)).join(', ');
    if (request.method === 'OPTIONS') {
      return { response: new Response(null, { status: 204, headers: { allow, 'cache-control': 'no-store' } }), route: undefined, error: undefined };
    }
    const match = matches.find((m) => m.route.httpMethod === (head ? 'GET' : request.method));
    if (match === undefined) {
      const error = new RpcError(Code.UNIMPLEMENTED, TRANSCODER_REASONS.methodNotAllowed, 'this method is not allowed on this path', {
        httpStatus: 405,
        headers: { allow },
      });
      return { response: this.errorResponse(error, requestId, head), route: undefined, error };
    }
    const route: RouteInfo = { method: match.route.method, httpMethod: match.route.httpMethod, template: match.route.template.source, safe: match.route.httpMethod === 'GET' };
    try {
      await this.#options.authorize(request, route, context);
      const input = await this.#decode(match.route, request, url, match.bindings);
      const handler = (this.#handlers as unknown as Record<string, ((request: Message, context: C) => Promise<Message>) | undefined>)[route.method.localName];
      if (handler === undefined) throw new TypeError(`no handler for ${route.method.name}`);
      const output = await handler(input, context);
      if (output instanceof PreEncoded) return { response: preEncodedResponse(output, route, head), route, error: undefined };
      const body = JSON.stringify(toWire(route.method.output, output as never));
      return { response: new Response(head ? null : body, { status: 200, headers: JSON_HEADERS }), route, error: undefined };
    } catch (thrown) {
      const error = thrown instanceof RpcError ? thrown : (this.#options.onUnexpected?.(thrown) ?? new RpcError(Code.INTERNAL, TRANSCODER_REASONS.internal, 'internal error'));
      return { response: this.errorResponse(error, requestId, head), route, error };
    }
  }

  async #decode(route: HttpBinding, request: Request, url: URL, bindings: Bindings): Promise<Message> {
    const input = route.method.input;
    let wire: JsonObject = {};
    const bytes = await readLimited(request, this.#options.maxBodyBytes);
    if (bytes === null) throw badRequest('the request body is too large');
    if (route.body === '') {
      if (bytes.byteLength > 0) throw badRequest('this method takes no request body');
    } else {
      if (!MEDIA_TYPE.test((request.headers.get('content-type') ?? '').trim())) throw badRequest('the request body must be application/json');
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
      } catch {
        throw badRequest('the request body is not UTF-8 JSON');
      }
      if (!isObject(json)) throw badRequest('the request body is not a JSON object');
      wire = route.body === '*' ? json : { [route.body]: json };
    }
    const bound = new Set<string>();
    for (const [path, text] of bindings) {
      const fieldPath = path.split('.');
      // http-rule.ts checked, when the routes were built, that every variable is a singular text field.
      setPath(wire, fieldPath, textValue(textKind(resolveField(input, fieldPath, input.typeName)) ?? ScalarType.STRING, text));
      bound.add(path);
    }
    if (route.body === '*') {
      if (url.search !== '') throw badRequest('this method takes no query parameters');
    } else {
      this.#query(route, url, wire, bound);
    }
    const mask = route.updateMask;
    const partial = mask === undefined ? undefined : partialPaths(wire[mask.name]);
    let message: Message;
    try {
      message = fromWire(input, wire, { strict: true, ...(partial === undefined ? {} : { partial: route.body }) }).message;
    } catch (error) {
      if (error instanceof WireJsonError) throw badRequest(`the request is not a valid ${input.typeName}`);
      throw error;
    }
    if (partial !== undefined) {
      const resource = input.fields.find((f) => f.name === route.body);
      if (resource?.fieldKind === 'message') checkMasked(resource.message, wire[route.body], partial);
    }
    normalizeInput(reflect(input, message as never));
    return message;
  }

  /** Query parameters into the wire object: singular and repeated scalars, enums and timestamps, at any depth. */
  #query(route: HttpBinding, url: URL, wire: JsonObject, bound: ReadonlySet<string>): void {
    const input = route.method.input;
    const seen = new Set<string>();
    for (const [key, text] of queryParameters(url.search)) {
      const fieldPath = key.split('.');
      let field: DescField;
      try {
        field = resolveField(input, fieldPath, input.typeName);
      } catch {
        throw badRequest('an unknown query parameter');
      }
      if (bound.has(key) || fieldPath[0] === route.body) throw badRequest('a field is set twice');
      const kind = textKind(field);
      if (kind === undefined) throw badRequest('this field cannot be a query parameter');
      const value = textValue(kind, text);
      if (field.fieldKind === 'list') {
        const existing = fieldPath.reduce<JsonValue | undefined>((node, name) => (isObject(node) ? node[name] : undefined), wire);
        if (Array.isArray(existing)) existing.push(value);
        else setPath(wire, fieldPath, [value]);
        continue;
      }
      if (seen.has(key)) throw badRequest('a field is set twice');
      seen.add(key);
      setPath(wire, fieldPath, value);
    }
  }
}
