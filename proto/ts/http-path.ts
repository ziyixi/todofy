/**
 * Path templates of google.api.http (google/api/http.proto), shared by the HTTP transcoder (matching a request
 * path and binding its variables) and the HTTP client (expanding a request message into a path):
 *
 *   Template = "/" Segments [ Verb ] ;
 *   Segments = Segment { "/" Segment } ;
 *   Segment  = "*" | "**" | LITERAL | Variable ;
 *   Variable = "{" FieldPath [ "=" Segments ] "}" ;
 *   FieldPath = IDENT { "." IDENT } ;
 *   Verb     = ":" LITERAL ;
 *
 * `*` matches one path segment, `**` the rest of the path (zero or more segments; it must come last), and a
 * variable without `= Segments` is `{var=*}`. As http.proto specifies, a variable of exactly one segment is
 * percent-decoded entirely (the client encodes everything but [-_.~0-9a-zA-Z]); a variable of several
 * segments is decoded except `%2F`, which stays encoded (the client keeps `/` and encodes the rest).
 *
 * Choices this implementation makes where http.proto is silent, so both ends (and a later Python twin, which
 * runs the same cases: testdata/http-cases.json) agree:
 *
 * - A verb is split off the last segment at its last unencoded `:`. A template with a verb matches only a
 *   path with that verb, and a template without one only a path whose last segment has no unencoded `:`
 *   (a client encodes `:` inside a variable), so `decks/x:send` never reads as a deck named `x:send`.
 * - Literals and segments compare as sent (no decoding); an empty segment (`//`, a trailing `/`) matches
 *   nothing; so one path has one spelling.
 * - When several templates match, the one with a literal at the first position where they differ wins
 *   over `*`, and `*` over `**` (most specific first). Two templates of one HTTP method that match exactly
 *   the same paths are an error when the routes are built.
 * - The client refuses a variable value with a `.` or `..` segment (a whole single-segment value, or one
 *   segment of a multi-segment one): fetch would send another path, which the server cannot detect.
 */

/** One segment of a template. */
export type TemplateSegment = { readonly kind: 'literal'; readonly value: string } | { readonly kind: 'wildcard' } | { readonly kind: 'rest' };

/** A variable: the field path it binds and the template segments it covers. */
export interface TemplateVariable {
  /** Proto field names from the request message, e.g. ['settings', 'name']. */
  readonly fieldPath: readonly string[];
  /** Index of its first segment in `segments`. */
  readonly start: number;
  /** One past its last segment. */
  readonly end: number;
}

export interface PathTemplate {
  /** The template as written. */
  readonly source: string;
  readonly segments: readonly TemplateSegment[];
  readonly variables: readonly TemplateVariable[];
  /** The custom verb without its `:`, or undefined. */
  readonly verb: string | undefined;
}

export class PathTemplateError extends Error {}

const IDENT = /^[a-z_][a-z0-9_]*$/;
/** Characters a template literal may use: RFC 3986 unreserved, plus the sub-delims that need no encoding in a path. */
const LITERAL = /^[A-Za-z0-9\-._~!$&'()+,;=@]+$/;

/** Splits on `sep` outside braces. */
function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth < 0 || depth > 1) throw new PathTemplateError('unbalanced or nested braces');
    if (char === sep && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (depth !== 0) throw new PathTemplateError('unbalanced braces');
  parts.push(current);
  return parts;
}

function plainSegment(text: string): TemplateSegment {
  if (text === '*') return { kind: 'wildcard' };
  if (text === '**') return { kind: 'rest' };
  if (!LITERAL.test(text)) throw new PathTemplateError(`not a literal segment: ${JSON.stringify(text)}`);
  return { kind: 'literal', value: text };
}

/** Parses a google.api.http path template. Throws PathTemplateError for anything outside the grammar. */
export function parseTemplate(source: string): PathTemplate {
  if (!source.startsWith('/')) throw new PathTemplateError(`a template starts with "/": ${source}`);
  let body = source.slice(1);
  let verb: string | undefined;
  // The verb: a ":" after the last top-level "/", outside braces.
  const lastSlash = splitTop(body, '/').slice(0, -1).join('/').length;
  const tail = splitTop(body.slice(lastSlash), ':');
  if (tail.length > 2) throw new PathTemplateError(`more than one verb: ${source}`);
  if (tail.length === 2) {
    verb = tail[1] ?? '';
    if (!LITERAL.test(verb)) throw new PathTemplateError(`not a verb: ${source}`);
    body = body.slice(0, body.length - verb.length - 1);
  }
  const segments: TemplateSegment[] = [];
  const variables: TemplateVariable[] = [];
  for (const part of splitTop(body, '/')) {
    if (part === '') throw new PathTemplateError(`an empty segment: ${source}`);
    if (!part.startsWith('{')) {
      segments.push(plainSegment(part));
      continue;
    }
    if (!part.endsWith('}')) throw new PathTemplateError(`a variable is a whole segment: ${source}`);
    const inner = part.slice(1, -1);
    const equals = inner.indexOf('=');
    const path = equals === -1 ? inner : inner.slice(0, equals);
    const fieldPath = path.split('.');
    if (!fieldPath.every((name) => IDENT.test(name))) throw new PathTemplateError(`not a field path: ${JSON.stringify(path)}`);
    if (variables.some((v) => v.fieldPath.join('.') === path)) throw new PathTemplateError(`${path} is bound twice: ${source}`);
    const start = segments.length;
    const sub = equals === -1 ? ['*'] : inner.slice(equals + 1).split('/');
    for (const text of sub) {
      if (text === '' || text.includes('{') || text.includes('}')) throw new PathTemplateError(`not a variable pattern: ${source}`);
      segments.push(plainSegment(text));
    }
    variables.push({ fieldPath, start, end: segments.length });
  }
  const rest = segments.findIndex((s) => s.kind === 'rest');
  if (rest !== -1 && rest !== segments.length - 1) throw new PathTemplateError(`"**" must be the last segment: ${source}`);
  return { source, segments, variables, verb };
}

/** Decodes one raw path segment's percent-escapes (UTF-8); keeps `%2F` encoded when `keepSlash`. Null when malformed. */
function decode(raw: string, keepSlash: boolean): string | null {
  try {
    if (!keepSlash) return decodeURIComponent(raw);
    return raw
      .split(/(%2[Ff])/)
      .map((piece, i) => (i % 2 === 1 ? piece : decodeURIComponent(piece)))
      .join('');
  } catch {
    return null;
  }
}

/** A path split for matching: its raw segments and its verb. */
export interface SplitPath {
  readonly segments: readonly string[];
  readonly verb: string | undefined;
}

/** Splits a raw (still percent-encoded) URL path, e.g. `URL.pathname`. Null when it cannot match any template. */
export function splitPath(pathname: string): SplitPath | null {
  if (!pathname.startsWith('/')) return null;
  const body = pathname.slice(1);
  const lastSlash = body.lastIndexOf('/');
  const colon = body.lastIndexOf(':');
  let verb: string | undefined;
  let rest = body;
  if (colon > lastSlash) {
    verb = body.slice(colon + 1);
    rest = body.slice(0, colon);
  }
  const segments = rest === '' ? [] : rest.split('/');
  if (segments.some((segment) => segment === '')) return null;
  return { segments, verb };
}

export type Bindings = ReadonlyMap<string, string>;

/**
 * Matches a split path against a template: the variables' decoded values by dotted field path, or null when
 * the path does not match. Throws PathTemplateError when it matches but a variable's escapes are malformed.
 */
export function matchTemplate(template: PathTemplate, path: SplitPath): Bindings | null {
  if (template.verb !== path.verb) return null;
  const { segments } = template;
  const last = segments[segments.length - 1];
  const rest = last?.kind === 'rest';
  const fixed = rest ? segments.length - 1 : segments.length;
  if (rest ? path.segments.length < fixed : path.segments.length !== fixed) return null;
  for (let i = 0; i < fixed; i++) {
    const segment = segments[i];
    if (segment?.kind === 'literal' && segment.value !== path.segments[i]) return null;
  }
  const bindings = new Map<string, string>();
  for (const variable of template.variables) {
    const endsWithRest = rest && variable.end === segments.length;
    const raw = path.segments.slice(variable.start, endsWithRest ? path.segments.length : variable.end);
    const single = !endsWithRest && variable.end - variable.start === 1;
    const value = single ? decode(raw[0] ?? '', false) : decode(raw.join('/'), true);
    if (value === null) throw new PathTemplateError(`malformed escapes in ${variable.fieldPath.join('.')}`);
    bindings.set(variable.fieldPath.join('.'), value);
  }
  return bindings;
}

/** Orders two templates for matching: negative when `a` is more specific (tried first). */
export function compareSpecificity(a: PathTemplate, b: PathTemplate): number {
  const rank = (s: TemplateSegment | undefined) => (s === undefined ? -1 : s.kind === 'literal' ? 2 : s.kind === 'wildcard' ? 1 : 0);
  for (let i = 0; i < Math.max(a.segments.length, b.segments.length); i++) {
    const diff = rank(b.segments[i]) - rank(a.segments[i]);
    if (diff !== 0) return diff;
    const left = a.segments[i];
    const right = b.segments[i];
    if (left?.kind === 'literal' && right?.kind === 'literal' && left.value !== right.value) return left.value < right.value ? -1 : 1;
  }
  return 0;
}

/** Whether two templates match exactly the same paths. */
export function sameShape(a: PathTemplate, b: PathTemplate): boolean {
  return a.verb === b.verb && compareSpecificity(a, b) === 0 && a.segments.length === b.segments.length;
}

/** Percent-encodes everything but [-_.~0-9a-zA-Z] (and `/` when `keepSlash`), as http.proto asks of a client. */
function encode(value: string, keepSlash: boolean): string {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? encoded.replace(/%2F/g, '/') : encoded;
}

/**
 * A segment fetch() would not send as written: the WHATWG URL parser removes `.` and resolves `..` (also when
 * spelled `%2e`), so `/v1/{parent=shelves/*}/books` with parent `shelves/..` would reach `/v1/books`.
 */
function dotSegment(part: string): boolean {
  return part === '.' || part === '..';
}

/** Whether `value` fits a variable's pattern (its segments split on `/`). */
function fits(template: PathTemplate, variable: TemplateVariable, value: string): boolean {
  const pattern = template.segments.slice(variable.start, variable.end);
  // A single-segment variable takes any value but a dot segment: its `/` is encoded.
  if (pattern.length === 1 && pattern[0]?.kind === 'wildcard') return value !== '' && !dotSegment(value);
  const parts = value.split('/');
  const rest = pattern[pattern.length - 1]?.kind === 'rest';
  if (rest ? parts.length < pattern.length - 1 : parts.length !== pattern.length) return false;
  return parts.every((part, i) => {
    const segment = pattern[Math.min(i, pattern.length - 1)];
    if (part === '' || dotSegment(part)) return false;
    return segment?.kind === 'literal' ? segment.value === part : true;
  });
}

/**
 * Expands a template with the values of its variables (by dotted field path). Throws PathTemplateError when a
 * value is missing or does not fit its pattern (the request would reach another route, or none), and for a
 * `.` or `..` segment, which the URL parser would remove or resolve before the request is sent.
 */
export function expandTemplate(template: PathTemplate, values: Bindings): string {
  const out: string[] = [];
  let next = 0;
  for (const variable of template.variables) {
    for (; next < variable.start; next++) out.push(literalOf(template, next));
    const path = variable.fieldPath.join('.');
    const value = values.get(path);
    if (value === undefined || value === '') throw new PathTemplateError(`${path} is required by ${template.source}`);
    if (!fits(template, variable, value)) throw new PathTemplateError(`${path} does not fit ${template.source}`);
    const single = variable.end - variable.start === 1 && template.segments[variable.start]?.kind === 'wildcard';
    out.push(encode(value, !single));
    next = variable.end;
  }
  for (; next < template.segments.length; next++) out.push(literalOf(template, next));
  return `/${out.join('/')}${template.verb === undefined ? '' : `:${template.verb}`}`;
}

function literalOf(template: PathTemplate, index: number): string {
  const segment = template.segments[index];
  if (segment?.kind !== 'literal') throw new PathTemplateError(`an unnamed wildcard cannot be expanded: ${template.source}`);
  return segment.value;
}
