// node --test tools/cf-guard/test/*.test.mjs
// Synthetic only: example.com hosts, made-up ids and a sentinel token; no real account state.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  apiUrlFrom,
  main,
  parseAllowList,
  patternHost,
  readTriggers,
  triggersFromConfig,
} from "../cf-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const CLI = path.join(HERE, "..", "cf-guard.mjs");
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ZONE = "fedcba9876543210fedcba9876543210";
const OTHER_ZONE = "11111111111111111111111111111111";
const TOKEN = "SENTINEL-TOKEN-never-printed-0123456789";
const SECRET_ID = "deadbeefdeadbeefdeadbeefdeadbeef";

/** A fake Cloudflare API: GET list endpoints over an in-memory account; anything else is a test failure. */
function fakeCloudflare(state) {
  const requests = [];
  const respond = (status, body) => new Response(JSON.stringify(body), { status });
  const ok = (result, info) => respond(200, { success: true, errors: [], result, ...(info ? { result_info: info } : {}) });
  async function fetchImpl(url, init) {
    const parsed = new URL(url);
    requests.push({ method: init.method, path: parsed.pathname, query: parsed.search, auth: init.headers.Authorization });
    if (init.method !== "GET") return respond(405, { success: false, errors: [{ code: 1 }] });
    if (state.fail?.(parsed)) return respond(403, { success: false, errors: [{ code: 10000, message: `secret ${SECRET_ID}` }] });
    const params = parsed.searchParams;
    const p = parsed.pathname.replace(/^\/client\/v4/, "");
    if (p === `/accounts/${ACCOUNT}/workers/domains`) {
      return ok(
        state.domains.filter(
          (d) => (!params.get("service") || d.service === params.get("service")) && (!params.get("hostname") || d.hostname === params.get("hostname")),
        ),
      );
    }
    if (p === "/zones") {
      const zones = state.zones.filter((z) => !params.get("name") || z.name === params.get("name"));
      // Paged: one zone per page, to exercise result_info.total_pages.
      const page = Number(params.get("page") ?? 1);
      return ok(zones.slice(page - 1, page), { page, total_pages: zones.length });
    }
    const routes = /^\/zones\/([0-9a-f]{32})\/workers\/routes$/.exec(p);
    if (routes) return ok(state.routes[routes[1]] ?? []);
    const dns = /^\/zones\/([0-9a-f]{32})\/dns_records$/.exec(p);
    if (dns) return ok((state.dns[dns[1]] ?? []).filter((r) => r.name === params.get("name")));
    return respond(404, { success: false, errors: [{ code: 7003 }] });
  }
  return { fetchImpl, requests };
}

function baseState() {
  return {
    zones: [
      { id: ZONE, name: "example.com" },
      { id: OTHER_ZONE, name: "example.net" },
    ],
    domains: [
      { id: SECRET_ID, hostname: "www.example.com", service: "site", zone_id: ZONE },
      { id: "a1".repeat(16), hostname: "example.com", service: "site", zone_id: ZONE },
      { id: "b2".repeat(16), hostname: "app.example.com", service: "hidden-worker", zone_id: ZONE },
    ],
    routes: {
      [ZONE]: [{ id: "c3".repeat(16), pattern: "old.example.com/*", script: "router" }],
      [OTHER_ZONE]: [{ id: "d4".repeat(16), pattern: "example.net/*", script: "router" }],
    },
    dns: {
      [ZONE]: [
        { id: "e5".repeat(16), name: "tunnel.example.com", type: "CNAME" },
        { id: "f6".repeat(16), name: "example.com", type: "MX" },
      ],
    },
  };
}

function writeConfig(directory, name, body) {
  const file = path.join(directory, `${name}.toml`);
  writeFileSync(file, `name = "${name}"\naccount_id = "${ACCOUNT}"\n${body}\n`);
  return file;
}

/** Whether `text` names `host` as a whole hostname or pattern (not as the suffix of a longer name). */
function names(text, host) {
  const escaped = host.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`(?<![\\w.*-])${escaped}(?![\\w.-])`).test(text);
}

/**
 * Runs the guard. `unprinted`: live hostnames or patterns that are in neither the config nor an allow list;
 * the output (a public Actions log) must not name them.
 */
async function run(state, files, env = {}, unprinted = []) {
  const api = fakeCloudflare(state);
  const output = [];
  const code = await main(
    files.flatMap((file) => ["--config", file]),
    { CLOUDFLARE_API_TOKEN: TOKEN, ...env },
    { log: (line) => output.push(line), fetchImpl: api.fetchImpl },
  );
  const text = output.join("\n");
  // Never an id, a token, a response body or another Worker's name.
  for (const secret of [TOKEN, SECRET_ID, ZONE, OTHER_ZONE, "hidden-worker", "e5e5", "message"]) {
    assert.ok(!text.includes(secret), `output must not contain ${secret}:\n${text}`);
  }
  for (const host of unprinted) assert.ok(!names(text, host), `output must not name the unlisted ${host}:\n${text}`);
  for (const request of api.requests) {
    assert.equal(request.method, "GET");
    assert.equal(request.auth, `Bearer ${TOKEN}`);
  }
  return { code, text, requests: api.requests };
}

function withDir(fn) {
  return async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "cf-guard-"));
    try {
      await fn(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

const SITE = 'routes = [\n  { pattern = "www.example.com", custom_domain = true },\n  { pattern = "example.com", custom_domain = true },\n]';

test(
  "passes when the listed Custom Domains equal the live ones",
  withDir(async (dir) => {
    const { code, text, requests } = await run(baseState(), [writeConfig(dir, "site", SITE)]);
    assert.equal(code, 0, text);
    assert.match(text, /custom domains: 2 listed, 2 live/);
    assert.match(text, /keep {4}example\.com/);
    assert.match(text, /keep {4}www\.example\.com/);
    assert.match(text, /zone routes: none listed/);
    assert.match(text, /cf-guard: PASS$/);
    // An empty category is never read: no zone route request.
    assert.ok(!requests.some((r) => r.path.endsWith("/workers/routes")));
  }),
);

test(
  "fails when a live Custom Domain would be detached, counting it without naming it, unless allowed",
  withDir(async (dir) => {
    const file = writeConfig(dir, "site", 'routes = [{ pattern = "www.example.com", custom_domain = true }]');
    const failed = await run(baseState(), [file], {}, ["example.com"]);
    assert.equal(failed.code, 1);
    assert.match(failed.text, /custom domains: 1 listed, 2 live/);
    assert.match(failed.text, /keep {4}www\.example\.com/);
    assert.match(failed.text, /REMOVE {2}1 live Custom Domain\(s\) not in wrangler\.toml/);
    assert.match(failed.text, /FAIL: 1 live Custom Domain\(s\) of site are not in wrangler\.toml; the deploy would detach them \(they are not printed here/);
    assert.match(failed.text, /cf-guard: FAIL/);
    // An allow-listed removal is named: the allow list is committed on the deploy step.
    const allowed = await run(baseState(), [file], { CF_GUARD_ALLOW_REMOVE: "other.example.com, EXAMPLE.com" });
    assert.equal(allowed.code, 0, allowed.text);
    assert.match(allowed.text, /remove {2}example\.com \(allowed by CF_GUARD_ALLOW_REMOVE\)/);
  }),
);

test(
  "a hostname attached by hand outside wrangler.toml never reaches the log, only its count",
  withDir(async (dir) => {
    const state = baseState();
    state.domains.push(
      { id: "a7".repeat(16), hostname: "private-admin.example.com", service: "site", zone_id: ZONE },
      { id: "a8".repeat(16), hostname: "staging.example.net", service: "site", zone_id: OTHER_ZONE },
    );
    const file = writeConfig(dir, "site", SITE);
    const hidden = ["private-admin.example.com", "staging.example.net", "private-admin", "staging"];
    const failed = await run(state, [file], {}, hidden);
    assert.equal(failed.code, 1);
    assert.match(failed.text, /custom domains: 2 listed, 4 live/);
    assert.match(failed.text, /REMOVE {2}2 live Custom Domain\(s\) not in wrangler\.toml/);
    // Allowing one names only that one; the other stays a count and still fails.
    const partly = await run(state, [file], { CF_GUARD_ALLOW_REMOVE: "staging.example.net" }, ["private-admin.example.com"]);
    assert.equal(partly.code, 1);
    assert.match(partly.text, /remove {2}staging\.example\.net \(allowed by CF_GUARD_ALLOW_REMOVE\)/);
    assert.match(partly.text, /REMOVE {2}1 live Custom Domain\(s\) not in wrangler\.toml/);
  }),
);

test(
  "fails when a listed hostname is another Worker's Custom Domain, without naming that Worker",
  withDir(async (dir) => {
    const file = writeConfig(dir, "site", `${SITE.slice(0, -2)}\n  { pattern = "app.example.com", custom_domain = true },\n]`);
    const failed = await run(baseState(), [file]);
    assert.equal(failed.code, 1);
    assert.match(failed.text, /CONFLICT app\.example\.com/);
    assert.match(failed.text, /belongs to a different Worker/);
    const allowed = await run(baseState(), [file], { CF_GUARD_ALLOW_CONFLICT: "app.example.com" });
    assert.equal(allowed.code, 0, allowed.text);
  }),
);

test(
  "a new Custom Domain passes on a free name and fails on an existing address record",
  withDir(async (dir) => {
    const fresh = writeConfig(dir, "site", `${SITE.slice(0, -2)}\n  { pattern = "new.example.com", custom_domain = true },\n]`);
    const added = await run(baseState(), [fresh]);
    assert.equal(added.code, 0, added.text);
    assert.match(added.text, /add {5}new\.example\.com/);
    const taken = writeConfig(dir, "site", `${SITE.slice(0, -2)}\n  { pattern = "tunnel.example.com", custom_domain = true },\n]`);
    const failed = await run(baseState(), [taken]);
    assert.equal(failed.code, 1);
    assert.match(failed.text, /new Custom Domain tunnel\.example\.com already has a DNS CNAME record/);
    // MX/TXT at a name are not what a Custom Domain replaces (the apex keeps its mail records).
    const apexOnly = writeConfig(dir, "mailer", 'routes = [{ pattern = "example.com", custom_domain = true }]');
    const state = baseState();
    state.domains = state.domains.filter((d) => d.hostname !== "example.com");
    const apex = await run(state, [apexOnly]);
    assert.equal(apex.code, 0, apex.text);
  }),
);

test(
  "moving a Worker from its staging host onto a tunnel's CNAME needs both allowances (FlowDay's F4 cutover)",
  withDir(async (dir) => {
    const state = baseState();
    state.domains.push({ id: "a9".repeat(16), hostname: "staging.example.com", service: "app", zone_id: ZONE });
    const file = writeConfig(dir, "app", 'routes = [{ pattern = "tunnel.example.com", custom_domain = true }]');
    const removeOnly = await run(state, [file], { CF_GUARD_ALLOW_REMOVE: "staging.example.com" });
    assert.equal(removeOnly.code, 1);
    assert.match(removeOnly.text, /remove {2}staging\.example\.com \(allowed by CF_GUARD_ALLOW_REMOVE\)/);
    assert.match(removeOnly.text, /new Custom Domain tunnel\.example\.com already has a DNS CNAME record/);
    const conflictOnly = await run(state, [file], { CF_GUARD_ALLOW_CONFLICT: "tunnel.example.com" }, ["staging.example.com"]);
    assert.equal(conflictOnly.code, 1);
    assert.match(conflictOnly.text, /REMOVE {2}1 live Custom Domain\(s\) not in wrangler\.toml/);
    const both = await run(state, [file], {
      CF_GUARD_ALLOW_REMOVE: "staging.example.com",
      CF_GUARD_ALLOW_CONFLICT: "tunnel.example.com",
    });
    assert.equal(both.code, 0, both.text);
    assert.match(both.text, /allowed conflict \(CF_GUARD_ALLOW_CONFLICT\): new Custom Domain tunnel\.example\.com already has a DNS CNAME record/);
  }),
);

test(
  "an unreadable DNS zone makes a new Custom Domain a conflict, printing only status and codes",
  withDir(async (dir) => {
    const state = { ...baseState(), fail: (url) => url.pathname.endsWith("/dns_records") };
    const file = writeConfig(dir, "site", `${SITE.slice(0, -2)}\n  { pattern = "new.example.com", custom_domain = true },\n]`);
    const failed = await run(state, [file]);
    assert.equal(failed.code, 1);
    assert.match(failed.text, /cannot check the DNS records of the new Custom Domain new\.example\.com \(list DNS records: HTTP 403, Cloudflare error codes \[10000\]\.\)/);
    const allowed = await run(state, [file], { CF_GUARD_ALLOW_CONFLICT: "new.example.com" });
    assert.equal(allowed.code, 0, allowed.text);
  }),
);

test(
  "zone routes: the script's routes in every zone are compared with the listed patterns",
  withDir(async (dir) => {
    const same = writeConfig(dir, "router", 'routes = [\n  { pattern = "old.example.com/*", zone_name = "example.com" },\n  "example.net/*",\n]');
    const passed = await run(baseState(), [same]);
    assert.equal(passed.code, 0, passed.text);
    assert.match(passed.text, /zone routes: 2 listed, 2 live/);
    assert.match(passed.text, /custom domains: none listed/);
    // Dropping example.net/* would delete it (PUT replaces the script's routes in every zone).
    const dropped = writeConfig(dir, "router", 'routes = [{ pattern = "old.example.com/*", zone_name = "example.com" }]');
    const failed = await run(baseState(), [dropped], {}, ["example.net/*", "example.net"]);
    assert.equal(failed.code, 1);
    assert.match(failed.text, /REMOVE {2}1 live zone route\(s\) not in wrangler\.toml/);
    assert.match(failed.text, /FAIL: 1 live zone route\(s\) of router are not in wrangler\.toml; the deploy would delete them/);
    const allowed = await run(baseState(), [dropped], { CF_GUARD_ALLOW_REMOVE: "example.net/*" });
    assert.equal(allowed.code, 0, allowed.text);
    assert.match(allowed.text, /remove {2}example\.net\/\* \(allowed by CF_GUARD_ALLOW_REMOVE\)/);
    // Another script's pattern is a conflict.
    const stolen = writeConfig(dir, "thief", 'route = "old.example.com/*"');
    const conflict = await run(baseState(), [stolen]);
    assert.equal(conflict.code, 1);
    assert.match(conflict.text, /zone route old\.example\.com\/\* belongs to a different Worker/);
  }),
);

test(
  "a config without routes needs no token and sends no request",
  withDir(async (dir) => {
    const file = writeConfig(dir, "core", "");
    const output = [];
    const code = await main(["--config", file], {}, { log: (line) => output.push(line), fetchImpl: () => assert.fail("no request") });
    assert.equal(code, 0);
    assert.match(output.join("\n"), /no routes or Custom Domains listed; wrangler changes none: skipped/);
  }),
);

test(
  "a missing token or an API failure is an error (exit 2) without a body",
  withDir(async (dir) => {
    const file = writeConfig(dir, "site", SITE);
    const output = [];
    assert.equal(await main(["--config", file], {}, { log: (line) => output.push(line) }), 2);
    assert.match(output.join("\n"), /CLOUDFLARE_API_TOKEN is unset/);
    const failed = await run({ ...baseState(), fail: () => true }, [file]);
    assert.equal(failed.code, 2);
    assert.match(failed.text, /ERROR: list Custom Domains: HTTP 403, Cloudflare error codes \[10000\]\./);
  }),
);

test("reads the route categories as wrangler splits them", () => {
  const triggers = triggersFromConfig({
    name: "w",
    account_id: ACCOUNT,
    routes: [
      { pattern: "A.example.com", custom_domain: true },
      { pattern: "b.example.com/*", zone_name: "example.com" },
      { pattern: "c.example.com/*", custom_domain: false, zone_id: ZONE },
      "d.example.com/*",
    ],
  });
  assert.deepEqual(triggers.customDomains, [{ hostname: "a.example.com", zoneId: undefined, zoneName: undefined }]);
  assert.deepEqual(
    triggers.routes.map((r) => r.pattern),
    ["b.example.com/*", "c.example.com/*", "d.example.com/*"],
  );
  for (const bad of [
    { account_id: ACCOUNT },
    { name: "w" },
    { name: "w", account_id: ACCOUNT, route: "a/*", routes: [] },
    { name: "w", account_id: ACCOUNT, routes: [{ pattern: "a.example.com/*", custom_domain: true }] },
    { name: "w", account_id: ACCOUNT, routes: ["a.example.com/*", "a.example.com/*"] },
    { name: "w", account_id: ACCOUNT, env: { staging: {} } },
  ]) {
    assert.throws(() => triggersFromConfig(bad));
  }
});

test("the committed production configs: the hostnames each deploy guards", async () => {
  const expected = {
    "mail-hero/wrangler.toml": ["mail-hero", ["mail-hero.ziyixi.science"]],
    "todofy/gateway/wrangler.toml": ["todofy", ["todofy.ziyixi.science", "todofy-hooks.ziyixi.science", "daily.ziyixi.science"]],
    "todofy/wrangler.toml": ["todofy-core", []],
    "dashboard/wrangler.toml": ["home", ["home.ziyixi.science"]],
    "lab/wrangler.toml": ["lab", ["lab.ziyixi.science"]],
    "website/wrangler.toml": ["ziyixi-website", ["www.ziyixi.science", "ziyixi.science"]],
    "website/relay/wrangler.toml": ["ziyixi-notion-publish", []],
    // The staging host only (flowday/docs/design.md section 11, F3); flowday.ziyixi.science is the F4 cutover's.
    "flowday/wrangler.toml": ["flowday", ["flowday-next.ziyixi.science"]],
  };
  for (const [file, [name, hosts]] of Object.entries(expected)) {
    const triggers = await readTriggers(path.join(REPO, file));
    assert.equal(triggers.name, name, file);
    assert.deepEqual(triggers.customDomains.map((d) => d.hostname), hosts, file);
    assert.deepEqual(triggers.routes, [], `${file} has no zone routes`);
  }
});

test("helpers", () => {
  assert.deepEqual([...parseAllowList(" A.example.com,b.example.com/*  c.example.com ")], [
    "a.example.com",
    "b.example.com/*",
    "c.example.com",
  ]);
  assert.equal(patternHost("*.example.com/api/*"), "example.com");
  assert.equal(patternHost("https://x.example.com/*"), "x.example.com");
  assert.equal(patternHost("*/*"), null);
  assert.equal(apiUrlFrom({}), "https://api.cloudflare.com/client/v4");
  assert.equal(apiUrlFrom({ CF_GUARD_API_URL: "http://127.0.0.1:9/client/v4/" }), "http://127.0.0.1:9/client/v4");
  assert.throws(() => apiUrlFrom({ CF_GUARD_API_URL: "https://evil.example.com" }), /loopback/);
});

test("the CLI end to end against a loopback server", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cf-guard-cli-"));
  const api = fakeCloudflare(baseState());
  const server = createServer(async (request, response) => {
    const answer = await api.fetchImpl(`http://127.0.0.1${request.url}`, {
      method: request.method,
      headers: { Authorization: request.headers.authorization },
    });
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(await answer.text());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const file = writeConfig(directory, "site", 'routes = [{ pattern = "www.example.com", custom_domain = true }]');
    const env = {
      PATH: process.env.PATH,
      CLOUDFLARE_API_TOKEN: TOKEN,
      CF_GUARD_API_URL: `http://127.0.0.1:${server.address().port}/client/v4`,
    };
    const failed = await promisify(execFile)(process.execPath, [CLI, "--config", file], { env }).catch((error) => error);
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /REMOVE {2}1 live Custom Domain\(s\) not in wrangler\.toml/);
    assert.ok(!names(failed.stdout, "example.com") && !names(failed.stderr, "example.com"));
    assert.ok(!failed.stdout.includes(TOKEN) && !failed.stderr.includes(TOKEN));
    const { stdout } = await promisify(execFile)(process.execPath, [CLI, "--config", file], {
      env: { ...env, CF_GUARD_ALLOW_REMOVE: "example.com" },
    });
    assert.match(stdout, /cf-guard: PASS/);
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
