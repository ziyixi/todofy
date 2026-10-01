// A small TOML 1.0 reader for wrangler.toml, so the guard has no dependency (it runs before any install).
// It reads every construct TOML 1.0 defines; offset date-times and times stay strings (the guard never
// reads them). Anything it cannot read is an error, never a guess. test/toml.test.mjs compares it with
// Python's tomllib on every committed wrangler config.

class TomlError extends Error {}

const BARE_KEY = /[A-Za-z0-9_-]/;
const ESCAPES = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
const DATE_TIME =
  /^(\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?)/;

/** Tables defined by a header or a key, and inline tables/arrays that later keys must not extend. */
const DEFINED = Symbol("defined");
const FROZEN = Symbol("frozen");

function isTable(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function newTable() {
  return Object.create(null);
}

export function parseToml(text) {
  if (typeof text !== "string") throw new TomlError("TOML input must be a string.");
  let pos = 0;
  let line = 1;
  const root = newTable();
  let current = root;

  const fail = (message) => {
    throw new TomlError(`TOML line ${line}: ${message}`);
  };
  const peek = (offset = 0) => text[pos + offset];
  const startsWith = (token) => text.startsWith(token, pos);
  const advance = (count = 1) => {
    for (let index = 0; index < count; index += 1) {
      if (text[pos] === "\n") line += 1;
      pos += 1;
    }
  };

  function skipSpaces() {
    while (peek() === " " || peek() === "\t") advance();
  }
  function skipComment() {
    if (peek() !== "#") return;
    while (pos < text.length && peek() !== "\n") {
      const code = text.charCodeAt(pos);
      if ((code < 0x20 && code !== 0x09) || code === 0x7f) fail("control character in a comment");
      advance();
    }
  }
  function skipNewline() {
    if (startsWith("\r\n")) advance(2);
    else if (peek() === "\n") advance();
    else return false;
    return true;
  }
  /** Whitespace, comments and newlines (inside arrays). */
  function skipBlank() {
    for (;;) {
      skipSpaces();
      skipComment();
      if (!skipNewline()) return;
    }
  }
  function endOfLine() {
    skipSpaces();
    skipComment();
    if (pos >= text.length) return;
    if (!skipNewline()) fail(`unexpected ${JSON.stringify(peek())}`);
  }

  function parseBasicString() {
    advance(); // "
    let value = "";
    for (;;) {
      if (pos >= text.length || peek() === "\n" || peek() === "\r") fail("unterminated string");
      const char = peek();
      if (char === '"') {
        advance();
        return value;
      }
      if (char === "\\") {
        value += parseEscape();
        continue;
      }
      checkStringChar(char);
      value += char;
      advance();
    }
  }
  function parseEscape() {
    advance(); // backslash
    const char = peek();
    if (char in ESCAPES) {
      advance();
      return ESCAPES[char];
    }
    if (char === "u" || char === "U") {
      const length = char === "u" ? 4 : 8;
      const hex = text.slice(pos + 1, pos + 1 + length);
      if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(hex)) fail("invalid unicode escape");
      const code = Number.parseInt(hex, 16);
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail("invalid unicode scalar");
      advance(1 + length);
      return String.fromCodePoint(code);
    }
    return fail(`invalid escape \\${char}`);
  }
  function checkStringChar(char) {
    const code = char.charCodeAt(0);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) fail("control character in a string");
  }
  function parseMultilineBasicString() {
    advance(3);
    skipNewline();
    let value = "";
    for (;;) {
      if (pos >= text.length) fail("unterminated multi-line string");
      if (startsWith('"""')) {
        // Up to two quotes may sit right before the closing delimiter.
        let quotes = 3;
        while (peek(quotes) === '"' && quotes < 5) quotes += 1;
        value += '"'.repeat(quotes - 3);
        advance(quotes);
        return value;
      }
      const char = peek();
      if (char === "\\") {
        // A line-ending backslash trims the newline and the whitespace after it.
        let look = pos + 1;
        while (text[look] === " " || text[look] === "\t") look += 1;
        if (text[look] === "\n" || (text[look] === "\r" && text[look + 1] === "\n")) {
          advance(look - pos);
          while (peek() === " " || peek() === "\t" || peek() === "\n" || peek() === "\r") advance();
          continue;
        }
        value += parseEscape();
        continue;
      }
      if (char === "\r" && peek(1) === "\n") {
        value += "\n";
        advance(2);
        continue;
      }
      if (char !== "\n") checkStringChar(char);
      value += char;
      advance();
    }
  }
  function parseLiteralString() {
    advance();
    const start = pos;
    while (peek() !== "'") {
      if (pos >= text.length || peek() === "\n" || peek() === "\r") fail("unterminated literal string");
      checkStringChar(peek());
      advance();
    }
    const value = text.slice(start, pos);
    advance();
    return value;
  }
  function parseMultilineLiteralString() {
    advance(3);
    skipNewline();
    let value = "";
    for (;;) {
      if (pos >= text.length) fail("unterminated multi-line literal string");
      if (startsWith("'''")) {
        let quotes = 3;
        while (peek(quotes) === "'" && quotes < 5) quotes += 1;
        value += "'".repeat(quotes - 3);
        advance(quotes);
        return value;
      }
      const char = peek();
      if (char === "\r" && peek(1) === "\n") {
        value += "\n";
        advance(2);
        continue;
      }
      if (char !== "\n") checkStringChar(char);
      value += char;
      advance();
    }
  }

  function parseKeyPart() {
    if (peek() === '"') return parseBasicString();
    if (peek() === "'") return parseLiteralString();
    const start = pos;
    while (pos < text.length && BARE_KEY.test(peek())) advance();
    if (start === pos) fail("expected a key");
    return text.slice(start, pos);
  }
  function parseKey() {
    const parts = [];
    for (;;) {
      skipSpaces();
      parts.push(parseKeyPart());
      skipSpaces();
      if (peek() !== ".") return parts;
      advance();
    }
  }

  function parseNumberOrDate() {
    const rest = text.slice(pos);
    const date = DATE_TIME.exec(rest);
    if (date && /^\d{4}-|^\d{2}:/.test(rest)) {
      advance(date[0].length);
      return date[0];
    }
    const special = /^[+-]?(inf|nan)\b/.exec(rest);
    if (special) {
      advance(special[0].length);
      if (special[1] === "nan") return Number.NaN;
      return special[0].startsWith("-") ? -Infinity : Infinity;
    }
    const prefixed = /^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|^0o[0-7](?:_?[0-7])*|^0b[01](?:_?[01])*/.exec(rest);
    if (prefixed) {
      advance(prefixed[0].length);
      const digits = prefixed[0].slice(2).replaceAll("_", "");
      return Number.parseInt(digits, { x: 16, o: 8, b: 2 }[prefixed[0][1]]);
    }
    const decimal = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?/.exec(rest);
    if (!decimal || decimal[0] === "" || /^[+-]$/.test(decimal[0])) fail("invalid value");
    advance(decimal[0].length);
    if (/^[0-9A-Za-z_.]/.test(peek() ?? "")) fail("invalid number");
    return Number(decimal[0].replaceAll("_", ""));
  }

  function parseArray() {
    advance(); // [
    const values = [];
    for (;;) {
      skipBlank();
      if (peek() === "]") {
        advance();
        break;
      }
      values.push(parseValue());
      skipBlank();
      if (peek() === ",") {
        advance();
        continue;
      }
      if (peek() === "]") {
        advance();
        break;
      }
      fail("expected , or ] in an array");
    }
    values[FROZEN] = true;
    return values;
  }

  function parseInlineTable() {
    advance(); // {
    const table = newTable();
    skipSpaces();
    if (peek() === "}") {
      advance();
      table[FROZEN] = true;
      return table;
    }
    for (;;) {
      const key = parseKey();
      if (peek() !== "=") fail("expected = in an inline table");
      advance();
      skipSpaces();
      assign(table, key, parseValue(), true);
      skipSpaces();
      if (peek() === ",") {
        advance();
        skipSpaces();
        continue;
      }
      if (peek() === "}") {
        advance();
        break;
      }
      fail("expected , or } in an inline table");
    }
    freeze(table);
    return table;
  }
  function freeze(table) {
    table[FROZEN] = true;
    for (const value of Object.values(table)) if (isTable(value)) freeze(value);
  }

  function parseValue() {
    if (startsWith('"""')) return parseMultilineBasicString();
    if (startsWith("'''")) return parseMultilineLiteralString();
    const char = peek();
    if (char === '"') return parseBasicString();
    if (char === "'") return parseLiteralString();
    if (char === "[") return parseArray();
    if (char === "{") return parseInlineTable();
    if (startsWith("true") && !BARE_KEY.test(peek(4) ?? "")) {
      advance(4);
      return true;
    }
    if (startsWith("false") && !BARE_KEY.test(peek(5) ?? "")) {
      advance(5);
      return false;
    }
    return parseNumberOrDate();
  }

  /** Sets a dotted key in a table, creating the intermediate tables a key may define. */
  function assign(table, key, value, inline = false) {
    let target = table;
    for (const part of key.slice(0, -1)) {
      if (!(part in target)) {
        target[part] = newTable();
      } else if (!isTable(target[part]) || target[part][FROZEN] || (!inline && target[part][DEFINED] === "header")) {
        fail(`key ${key.join(".")} extends a value that is already defined`);
      }
      target = target[part];
      if (!target[DEFINED]) target[DEFINED] = "dotted";
    }
    const last = key[key.length - 1];
    if (last in target) fail(`duplicate key ${key.join(".")}`);
    target[last] = value;
  }

  function parseHeader() {
    const array = startsWith("[[");
    advance(array ? 2 : 1);
    const key = parseKey();
    if (!startsWith(array ? "]]" : "]")) fail("unterminated table header");
    advance(array ? 2 : 1);
    let target = root;
    for (const [index, part] of key.entries()) {
      const last = index === key.length - 1;
      if (last && array) {
        if (!(part in target)) {
          const list = [];
          list.arrayOfTables = true;
          target[part] = list;
        }
        const list = target[part];
        if (!Array.isArray(list) || list[FROZEN] || !list.arrayOfTables) {
          fail(`[[${key.join(".")}]] redefines a value`);
        }
        const table = newTable();
        table[DEFINED] = "header";
        list.push(table);
        return table;
      }
      if (!(part in target)) target[part] = newTable();
      let next = target[part];
      if (Array.isArray(next) && next.arrayOfTables) next = next[next.length - 1];
      if (!isTable(next) || next[FROZEN]) fail(`[${key.join(".")}] redefines a value`);
      if (last) {
        if (next[DEFINED] === "header" || next[DEFINED] === "dotted") fail(`[${key.join(".")}] is defined twice`);
        next[DEFINED] = "header";
      }
      target = next;
    }
    return target;
  }

  if (text.charCodeAt(0) === 0xfeff) pos = 1;
  for (;;) {
    skipBlank();
    if (pos >= text.length) break;
    if (peek() === "[") {
      current = parseHeader();
      endOfLine();
      continue;
    }
    const key = parseKey();
    if (peek() !== "=") fail("expected =");
    advance();
    skipSpaces();
    if (pos >= text.length || peek() === "\n" || peek() === "\r" || peek() === "#") fail("missing value");
    assign(current, key, parseValue());
    endOfLine();
  }
  return plain(root);
}

/** Plain objects and arrays (the internal markers removed). */
function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  // fromEntries defines own properties, so a key such as "__proto__" stays an ordinary key.
  if (isTable(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plain(entry)]));
  return value;
}

export { TomlError };
