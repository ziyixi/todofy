/**
 * The google.api.http bindings of a generated service, read once from its descriptors and checked, for the
 * HTTP transcoder (http-transcoder.ts) and the HTTP client (http-client.ts). Both ends therefore route,
 * bind and encode from the same rule, the one written in the .proto file.
 *
 * Supported, as google/api/http.proto defines them: get/put/post/delete/patch patterns (http-path.ts
 * grammar), `body: "*"` or a top-level message field, no body on GET and DELETE, additional_bindings (one
 * level), and variables bound to singular scalar or enum fields (nested field paths included). Not
 * supported, so a binding that needs them fails when the routes are built rather than at request time:
 * `custom` patterns, `response_body`, a scalar or repeated body field, and maps or messages in a path.
 */
import { getOption, ScalarType, type DescField, type DescMessage, type DescMethod, type DescService } from '@bufbuild/protobuf';
import { http } from './google/api/annotations_pb.ts';
import type { HttpRule } from './google/api/http_pb.ts';
import { parseTemplate, type PathTemplate } from './http-path.ts';

export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'DELETE' | 'PATCH';

/** One binding of one rpc. */
export interface HttpBinding {
  readonly method: DescMethod;
  readonly httpMethod: HttpMethod;
  readonly template: PathTemplate;
  /** '' (no body), '*' (the whole request but the path fields) or a top-level field name. */
  readonly body: string;
  /** False for additional_bindings: the client always uses the primary one. */
  readonly primary: boolean;
}

export class HttpRuleError extends Error {}

/** The scalar kinds a path variable or query parameter can carry (the wire profile's scalars). */
const TEXT_SCALARS = new Set<ScalarType>([ScalarType.STRING, ScalarType.BOOL, ScalarType.INT32, ScalarType.UINT32, ScalarType.SINT32, ScalarType.FIXED32, ScalarType.SFIXED32, ScalarType.DOUBLE]);

/** The field at a dotted path of `message`, through singular message fields; throws when there is none. */
export function resolveField(message: DescMessage, path: readonly string[], where: string): DescField {
  let current = message;
  for (const [i, name] of path.entries()) {
    const field = current.fields.find((f) => f.name === name);
    if (field === undefined) throw new HttpRuleError(`${where}: ${current.typeName} has no field ${name}`);
    if (i === path.length - 1) return field;
    if (field.fieldKind !== 'message') throw new HttpRuleError(`${where}: ${path.slice(0, i + 1).join('.')} is not a singular message`);
    current = field.message;
  }
  throw new HttpRuleError(`${where}: an empty field path`);
}

/** Whether a singular field can be written as text (a path variable or a query parameter). */
export function isTextField(field: DescField): boolean {
  return (field.fieldKind === 'scalar' && TEXT_SCALARS.has(field.scalar)) || field.fieldKind === 'enum';
}

function patternOf(rule: HttpRule, where: string): { httpMethod: HttpMethod; path: string } {
  switch (rule.pattern.case) {
    case 'get':
      return { httpMethod: 'GET', path: rule.pattern.value };
    case 'put':
      return { httpMethod: 'PUT', path: rule.pattern.value };
    case 'post':
      return { httpMethod: 'POST', path: rule.pattern.value };
    case 'delete':
      return { httpMethod: 'DELETE', path: rule.pattern.value };
    case 'patch':
      return { httpMethod: 'PATCH', path: rule.pattern.value };
    default:
      throw new HttpRuleError(`${where}: only get, put, post, delete and patch patterns are supported`);
  }
}

function binding(method: DescMethod, rule: HttpRule, primary: boolean): HttpBinding {
  const where = `${method.parent.typeName}.${method.name}`;
  const { httpMethod, path } = patternOf(rule, where);
  if (rule.responseBody !== '') throw new HttpRuleError(`${where}: response_body is not supported`);
  let template: PathTemplate;
  try {
    template = parseTemplate(path);
  } catch (error) {
    throw new HttpRuleError(`${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const variable of template.variables) {
    const field = resolveField(method.input, variable.fieldPath, where);
    if (!isTextField(field)) throw new HttpRuleError(`${where}: path variable ${variable.fieldPath.join('.')} must be a singular scalar or enum`);
  }
  const body = rule.body;
  if (body !== '') {
    if (httpMethod === 'GET' || httpMethod === 'DELETE') throw new HttpRuleError(`${where}: ${httpMethod} takes no body`);
    if (body !== '*') {
      const field = method.input.fields.find((f) => f.name === body);
      if (field?.fieldKind !== 'message') throw new HttpRuleError(`${where}: body ${body} must be a top-level singular message field`);
      if (template.variables.some((v) => v.fieldPath.length === 1 && v.fieldPath[0] === body)) throw new HttpRuleError(`${where}: the body field is also a path variable`);
    }
  }
  return { method, httpMethod, template, body, primary };
}

/** Every binding of every rpc of `service` (an rpc without google.api.http has none). */
export function httpBindings(service: DescService): HttpBinding[] {
  const out: HttpBinding[] = [];
  for (const method of service.methods) {
    if (method.methodKind !== 'unary') throw new HttpRuleError(`${service.typeName}.${method.name}: only unary methods map to HTTP`);
    const rule = getOption(method, http);
    if (rule.pattern.case === undefined) continue;
    out.push(binding(method, rule, true));
    for (const extra of rule.additionalBindings) {
      if (extra.additionalBindings.length > 0) throw new HttpRuleError(`${service.typeName}.${method.name}: additional_bindings nest one level only`);
      out.push(binding(method, extra, false));
    }
  }
  return out;
}
