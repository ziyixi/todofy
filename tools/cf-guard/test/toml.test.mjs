// node --test tools/cf-guard/test/*.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseToml } from "../toml.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function wranglerConfigs(directory = REPO, found = []) {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === ".git" || entry.startsWith(".wrangler")) continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) wranglerConfigs(full, found);
    else if (/^wrangler(\..+)?\.toml$/.test(entry)) found.push(full);
  }
  return found;
}

/** A python3 with tomllib (3.11+), or null. CI's ubuntu-24.04 runner has one. */
function tomllibPython() {
  for (const candidate of [process.env.PYTHON, "python3"].filter(Boolean)) {
    try {
      execFileSync(candidate, ["-c", "import tomllib"], { stdio: "ignore" });
      return candidate;
    } catch {
      // try the next one
    }
  }
  return null;
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }
  return value;
}

test("reads every committed wrangler config exactly as Python's tomllib does", (t) => {
  const python = tomllibPython();
  const configs = wranglerConfigs();
  assert.ok(configs.length >= 7, "the production configs are found");
  if (!python) {
    if (process.env.CI) assert.fail("CI must have a python3 with tomllib");
    t.skip("no python3 with tomllib here");
    return;
  }
  for (const file of configs) {
    const expected = JSON.parse(
      execFileSync(python, ["-c", "import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1],'rb'))))", file], {
        encoding: "utf8",
      }),
    );
    assert.deepEqual(sorted(parseToml(readFileSync(file, "utf8"))), sorted(expected), path.relative(REPO, file));
  }
});

test("strings, numbers, arrays and tables", () => {
  const value = parseToml(`
# comment
name = "a\\tb \\u00e9" # trailing
literal = 'C:\\path'
multi = """
one \\
   two"""
lit = '''
x ''y'''
int = 1_000
hex = 0xff
neg = -3
float = 1.5e2
yes = true
when = 2026-09-30T10:00:00Z
list = [
  1,
  2, # inside
]
inline = { a = 1, b.c = "d" }
dotted.key = "v"
"quoted key" = 1
[table]
x = 1
[[items]]
n = 1
[[items]]
n = 2
[items.sub]
deep = true
`);
  assert.deepEqual(value, {
    name: "a\tb é",
    literal: "C:\\path",
    multi: "one two",
    lit: "x ''y",
    int: 1000,
    hex: 255,
    neg: -3,
    float: 150,
    yes: true,
    when: "2026-09-30T10:00:00Z",
    list: [1, 2],
    inline: { a: 1, b: { c: "d" } },
    dotted: { key: "v" },
    "quoted key": 1,
    table: { x: 1 },
    items: [{ n: 1 }, { n: 2, sub: { deep: true } }],
  });
});

test("routes in every form wrangler accepts", () => {
  assert.deepEqual(
    parseToml(`routes = [
  { pattern = "www.example.com", custom_domain = true },
  { pattern = "example.com/*", zone_name = "example.com" },
  "api.example.com/*",
]`).routes,
    [
      { pattern: "www.example.com", custom_domain: true },
      { pattern: "example.com/*", zone_name: "example.com" },
      "api.example.com/*",
    ],
  );
  assert.deepEqual(parseToml('[[routes]]\npattern = "a.example.com"\ncustom_domain = true\n').routes, [
    { pattern: "a.example.com", custom_domain: true },
  ]);
});

test("refuses what it cannot read instead of guessing", () => {
  for (const bad of [
    "a = 1\na = 2",
    "a = ",
    'a = "unterminated',
    "a = [1, 2",
    "a = { b = 1 }\na.c = 2",
    "[t]\n[t]",
    "a = 1 b = 2",
    "a = 01",
    "a = 1__0",
    "[[a]]\n[a]\nx=1\n[a]",
    'a = "\\q"',
  ]) {
    assert.throws(() => parseToml(bad), /TOML line \d+/, bad);
  }
});

test("a __proto__ key stays an ordinary key", () => {
  const value = parseToml('"__proto__" = { polluted = true }');
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(value), ["__proto__"]);
});
