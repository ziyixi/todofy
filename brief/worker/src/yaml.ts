/**
 * The YAML subset content-config/sources.yaml is written in, read strictly (../../docs/design.md §3.1): block mappings
 * and block sequences by indentation (spaces only), plain, single- and double-quoted scalars, flow sequences and flow
 * mappings (which may continue over more deeply indented lines), and `#` comments. Anything else (anchors, aliases,
 * tags, block scalars, several documents, tabs, a duplicate key) is an error naming the line, so an owner's edit that
 * leaves the subset fails the registry's unit test in CI instead of a Worker at startup. Plain scalars read as
 * integers, decimals, booleans or null when they look exactly like one; everything else is a string.
 *
 * No dependency: the registry is parsed once per isolate (65 entries).
 */

export class YamlError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`sources.yaml line ${String(line)}: ${message}`);
    this.name = 'YamlError';
    this.line = line;
  }
}

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  readonly indent: number;
  readonly text: string;
  readonly no: number;
}

/** The line without its comment (a `#` outside quotes at the start or after whitespace) and trailing whitespace. */
export function stripComment(raw: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') quote = null;
    } else if (quote === "'") {
      if (c === "'") {
        if (raw[i + 1] === "'") i++;
        else quote = null;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || raw[i - 1] === ' ' || raw[i - 1] === '\t')) {
      return raw.slice(0, i).trimEnd();
    }
  }
  return raw.trimEnd();
}

function plain(text: string, line: number): YamlValue {
  if (/^[&*!|>%@`]/.test(text)) throw new YamlError(`unsupported syntax "${text.slice(0, 1)}"`, line);
  if (/^-?\d+$/.test(text)) {
    const value = Number(text);
    if (!Number.isSafeInteger(value)) throw new YamlError('integer out of range', line);
    return value;
  }
  if (/^-?\d+\.\d+$/.test(text)) return Number(text);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  return text;
}

/** A flow collection or a quoted scalar, character by character. */
class FlowReader {
  private i = 0;
  private readonly s: string;
  private readonly line: number;

  constructor(s: string, line: number) {
    this.s = s;
    this.line = line;
  }

  read(): YamlValue {
    const value = this.value('top');
    this.skip();
    if (this.i < this.s.length) throw new YamlError('unexpected text after a value', this.line);
    return value;
  }

  private skip(): void {
    while (this.i < this.s.length && (this.s[this.i] === ' ' || this.s[this.i] === '\t')) this.i++;
  }

  private fail(message: string): never {
    throw new YamlError(message, this.line);
  }

  private value(context: 'top' | 'seq' | 'map'): YamlValue {
    this.skip();
    const c = this.s[this.i];
    if (c === '[') return this.sequence();
    if (c === '{') return this.mapping();
    if (c === '"') return this.doubleQuoted();
    if (c === "'") return this.singleQuoted();
    if (c === undefined) this.fail('a value is missing');
    const start = this.i;
    while (this.i < this.s.length) {
      const ch = this.s[this.i];
      if (context !== 'top' && (ch === ',' || ch === ']' || ch === '}')) break;
      this.i++;
    }
    const text = this.s.slice(start, this.i).trim();
    if (text === '') this.fail('an empty value');
    return plain(text, this.line);
  }

  private sequence(): YamlValue[] {
    this.i++;
    const items: YamlValue[] = [];
    for (;;) {
      this.skip();
      if (this.s[this.i] === ']') {
        this.i++;
        return items;
      }
      items.push(this.value('seq'));
      this.skip();
      const c = this.s[this.i];
      if (c === ',') this.i++;
      else if (c === ']') {
        this.i++;
        return items;
      } else this.fail('expected , or ] in a flow sequence');
    }
  }

  private key(): string {
    this.skip();
    const c = this.s[this.i];
    if (c === '"') return this.doubleQuoted();
    if (c === "'") return this.singleQuoted();
    const start = this.i;
    while (this.i < this.s.length && this.s[this.i] !== ':' && this.s[this.i] !== ',' && this.s[this.i] !== '}') this.i++;
    const key = this.s.slice(start, this.i).trim();
    if (key === '') this.fail('an empty key');
    return key;
  }

  private mapping(): { [key: string]: YamlValue } {
    this.i++;
    const out: { [key: string]: YamlValue } = {};
    for (;;) {
      this.skip();
      if (this.s[this.i] === '}') {
        this.i++;
        return out;
      }
      const key = this.key();
      this.skip();
      if (this.s[this.i] !== ':') this.fail('expected : after a key');
      this.i++;
      if (Object.hasOwn(out, key)) this.fail(`duplicate key "${key}"`);
      out[key] = this.value('map');
      this.skip();
      const c = this.s[this.i];
      if (c === ',') this.i++;
      else if (c === '}') {
        this.i++;
        return out;
      } else this.fail('expected , or } in a flow mapping');
    }
  }

  private doubleQuoted(): string {
    this.i++;
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s.charAt(this.i++);
      if (c === '"') return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = this.s[this.i++];
      if (e === 'n') out += '\n';
      else if (e === 't') out += '\t';
      else if (e === 'r') out += '\r';
      else if (e === '"' || e === '\\' || e === '/') out += e;
      else if (e === 'u') {
        const hex = this.s.slice(this.i, this.i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('a bad \\u escape');
        out += String.fromCharCode(parseInt(hex, 16));
        this.i += 4;
      } else this.fail('an unsupported escape');
    }
    return this.fail('an unterminated double-quoted string');
  }

  private singleQuoted(): string {
    this.i++;
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s.charAt(this.i++);
      if (c === "'") {
        if (this.s[this.i] === "'") {
          out += "'";
          this.i++;
          continue;
        }
        return out;
      }
      out += c;
    }
    return this.fail('an unterminated single-quoted string');
  }
}

/** Whether a flow collection's brackets close within `text` (quotes respected). */
function balanced(text: string): boolean {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') quote = null;
    } else if (quote === "'") {
      if (c === "'") quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0;
}

/** The position of a block key's `:` (outside quotes, followed by a space or the end), or -1. */
function keyColon(text: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      if (i === 0) quote = c;
      continue;
    }
    if (c === '[' || c === '{') return -1;
    if (c === ':' && (i + 1 === text.length || text[i + 1] === ' ')) return i;
  }
  return -1;
}

function isItem(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

class BlockReader {
  private pos = 0;
  private readonly lines: Line[];

  constructor(lines: Line[]) {
    this.lines = lines;
  }

  read(): YamlValue {
    const first = this.lines[0];
    if (first === undefined) return null;
    if (first.indent !== 0) throw new YamlError('the document must start at column 0', first.no);
    const value = this.block(0);
    const rest = this.lines[this.pos];
    if (rest !== undefined) throw new YamlError('bad indentation', rest.no);
    return value;
  }

  private block(indent: number): YamlValue {
    const line = this.lines[this.pos];
    if (line === undefined) return null;
    return isItem(line.text) ? this.sequence(indent) : this.mapping(indent);
  }

  private inline(text: string, parentIndent: number, no: number): YamlValue {
    if (text.startsWith('[') || text.startsWith('{')) {
      let joined = text;
      while (!balanced(joined)) {
        const next = this.lines[this.pos];
        if (next === undefined || next.indent <= parentIndent) throw new YamlError('an unclosed flow collection', no);
        joined += ` ${next.text}`;
        this.pos++;
      }
      return new FlowReader(joined, no).read();
    }
    if (text.startsWith('"') || text.startsWith("'")) return new FlowReader(text, no).read();
    return plain(text, no);
  }

  private mapping(indent: number): { [key: string]: YamlValue } {
    const out: { [key: string]: YamlValue } = {};
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos] as Line;
      if (line.indent < indent) break;
      if (line.indent > indent) throw new YamlError('bad indentation', line.no);
      if (isItem(line.text)) throw new YamlError('a sequence item where a key was expected', line.no);
      const colon = keyColon(line.text);
      if (colon <= 0) throw new YamlError('expected "key: value"', line.no);
      const rawKey = line.text.slice(0, colon).trim();
      const key = rawKey.startsWith('"') || rawKey.startsWith("'") ? (new FlowReader(rawKey, line.no).read() as string) : rawKey;
      if (Object.hasOwn(out, key)) throw new YamlError(`duplicate key "${key}"`, line.no);
      const rest = line.text.slice(colon + 1).trim();
      this.pos++;
      if (rest !== '') {
        out[key] = this.inline(rest, indent, line.no);
        continue;
      }
      const next = this.lines[this.pos];
      if (next !== undefined && next.indent > indent) out[key] = this.block(next.indent);
      else if (next !== undefined && next.indent === indent && isItem(next.text)) out[key] = this.sequence(indent);
      else out[key] = null;
    }
    return out;
  }

  private sequence(indent: number): YamlValue[] {
    const items: YamlValue[] = [];
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos] as Line;
      if (line.indent < indent || !isItem(line.text)) break;
      if (line.indent > indent) throw new YamlError('bad indentation', line.no);
      const body = line.text === '-' ? '' : line.text.slice(1);
      const rest = body.trim();
      if (rest === '') {
        this.pos++;
        const next = this.lines[this.pos];
        items.push(next !== undefined && next.indent > indent ? this.block(next.indent) : null);
        continue;
      }
      if (keyColon(rest) > 0) {
        // A block mapping that starts on the item's line: its keys sit at the column of the first one.
        const column = indent + 1 + (body.length - body.trimStart().length);
        this.lines[this.pos] = { indent: column, text: rest, no: line.no };
        items.push(this.mapping(column));
        continue;
      }
      this.pos++;
      items.push(this.inline(rest, indent, line.no));
    }
    return items;
  }
}

/** The value of a document in the subset. */
export function parseYaml(text: string): YamlValue {
  const lines: Line[] = [];
  text.split(/\r\n|\r|\n/).forEach((raw, index) => {
    const no = index + 1;
    const leading = /^[ \t]*/.exec(raw)?.[0] ?? '';
    if (leading.includes('\t')) throw new YamlError('tabs are not allowed for indentation', no);
    const content = stripComment(raw).trim();
    if (content === '') return;
    if (content === '---' || content === '...' || content.startsWith('%')) throw new YamlError('document markers and directives are not supported', no);
    lines.push({ indent: leading.length, text: content, no });
  });
  return new BlockReader(lines).read();
}
