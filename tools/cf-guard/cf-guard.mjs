#!/usr/bin/env node
// Deploy-time hostname guard (README.md). Before a deploy that applies wrangler.toml's routes, it computes
// what wrangler would change for that Worker and fails when a live hostname would be detached or taken over:
//
//   node tools/cf-guard/cf-guard.mjs --config <wrangler.toml> [--config <another>] ...
//
// wrangler applies each category of `routes` as a complete set when the category is non-empty
// (Custom Domains: POST domains/changeset?replace_state=true, then PUT domains/records with override_scope,
// and in CI override_existing_origin/override_existing_dns_record; zone routes: PUT .../routes, which
// deletes the script's other routes) and leaves an empty category alone. So, per non-empty category:
//   - removed:  live on this Worker, not listed -> fail, unless allowed (CF_GUARD_ALLOW_REMOVE)
//   - conflict: listed, but a Custom Domain of another Worker, a zone route of another script, or (for a
//               hostname new to this Worker) an existing A/AAAA/CNAME record wrangler would overwrite
//               -> fail, unless allowed (CF_GUARD_ALLOW_CONFLICT)
// Read-only: only GET requests (the changeset endpoint is not used; the live state comes from the list
// endpoints). Output: Worker names, the hostnames and route patterns of the checked config and of the allow
// lists (both committed), counts and PASS/FAIL. A live hostname or pattern that neither lists is only counted:
// the log of a public repository must not publish an unlisted hostname or its drift. Never a response body,
// an id, a token or another Worker's name; API errors print the HTTP status and Cloudflare error codes.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseToml } from "./toml.mjs";

export const API_URL = "https://api.cloudflare.com/client/v4";
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const ZONE_ID = /^[0-9a-f]{32}$/;
/** DNS record types a Custom Domain replaces (wrangler's override_existing_dns_record). */
const ADDRESS_TYPES = new Set(["A", "AAAA", "CNAME"]);

export class GuardError extends Error {}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------------------------
// wrangler.toml -> what `wrangler deploy` / `wrangler triggers deploy` applies

/**
 * The Worker name, account and the two route categories, read the way wrangler splits them: a route with
 * custom_domain = true is a Custom Domain, every other route (a string or { pattern, zone_id|zone_name })
 * is a zone route. Top-level `route` and `routes` are both read (wrangler refuses both at once).
 */
export function triggersFromConfig(config, source = "wrangler.toml") {
  if (!isRecord(config)) throw new GuardError(`${source}: not a TOML table.`);
  if (config.env !== undefined) {
    throw new GuardError(`${source}: [env.*] sections are not supported (the top level is production).`);
  }
  const name = config.name;
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new GuardError(`${source}: needs a Worker name.`);
  }
  const accountId = config.account_id;
  if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)) {
    throw new GuardError(`${source}: needs the 32-character account_id.`);
  }
  if (config.route !== undefined && config.routes !== undefined) {
    throw new GuardError(`${source}: set either route or routes, not both.`);
  }
  let entries = [];
  if (config.route !== undefined) entries = [config.route];
  else if (config.routes !== undefined) {
    if (!Array.isArray(config.routes)) throw new GuardError(`${source}: routes must be a list.`);
    entries = config.routes;
  }
  const customDomains = [];
  const routes = [];
  for (const entry of entries) {
    const route = typeof entry === "string" ? { pattern: entry } : entry;
    if (!isRecord(route) || typeof route.pattern !== "string" || route.pattern === "") {
      throw new GuardError(`${source}: every route needs a pattern.`);
    }
    if (route.zone_id !== undefined && (typeof route.zone_id !== "string" || !ZONE_ID.test(route.zone_id))) {
      throw new GuardError(`${source}: route ${route.pattern} has an invalid zone_id.`);
    }
    if (route.zone_name !== undefined && (typeof route.zone_name !== "string" || !HOSTNAME.test(route.zone_name))) {
      throw new GuardError(`${source}: route ${route.pattern} has an invalid zone_name.`);
    }
    const target = { zoneId: route.zone_id, zoneName: route.zone_name };
    if (route.custom_domain === true) {
      const hostname = route.pattern.toLowerCase();
      if (!HOSTNAME.test(hostname)) {
        throw new GuardError(`${source}: Custom Domain ${route.pattern} must be a bare hostname.`);
      }
      customDomains.push({ hostname, ...target });
    } else {
      routes.push({ pattern: route.pattern, ...target });
    }
  }
  for (const [label, list, key] of [
    ["Custom Domain", customDomains, "hostname"],
    ["route", routes, "pattern"],
  ]) {
    const seen = new Set();
    for (const item of list) {
      if (seen.has(item[key])) throw new GuardError(`${source}: ${label} ${item[key]} is listed twice.`);
      seen.add(item[key]);
    }
  }
  return { name, accountId, customDomains, routes };
}

export async function readTriggers(file) {
  const text = await readFile(file, "utf8");
  let config;
  try {
    config = parseToml(text);
  } catch (error) {
    throw new GuardError(`${file}: ${error instanceof Error ? error.message : "invalid TOML"}`);
  }
  return triggersFromConfig(config, file);
}

// ---------------------------------------------------------------------------------------------------------
// Cloudflare API: GET only, results without bodies in errors

export class CloudflareClient {
  constructor({ token, fetchImpl = globalThis.fetch, apiUrl = API_URL }) {
    if (typeof token !== "string" || token.trim() === "") {
      throw new GuardError("CLOUDFLARE_API_TOKEN is unset; the guard needs the deploy job's token.");
    }
    this.token = token.trim();
    this.fetchImpl = fetchImpl;
    this.apiUrl = apiUrl;
  }

  /**
   * Every result of a list endpoint (pages followed while result_info says there are more).
   * `label` names the request in errors instead of its path, which may contain ids.
   */
  async list(pathname, params, label) {
    const results = [];
    for (let page = 1; page <= 50; page += 1) {
      const query = new URLSearchParams(params);
      if (page > 1) query.set("page", String(page));
      const body = await this.get(`${pathname}${query.size ? `?${query}` : ""}`, label);
      if (!Array.isArray(body.result)) throw new GuardError(`${label}: unexpected response.`);
      results.push(...body.result);
      const info = isRecord(body.result_info) ? body.result_info : {};
      const totalPages = Number(info.total_pages ?? 0);
      if (!Number.isFinite(totalPages) || page >= totalPages) return results;
    }
    throw new GuardError(`${label}: more than 50 pages.`);
  }

  async get(pathname, label) {
    let response;
    try {
      response = await this.fetchImpl(`${this.apiUrl}${pathname}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new GuardError(`${label}: request failed (network).`);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const codes = isRecord(body) && Array.isArray(body.errors)
      ? body.errors.map((error) => (isRecord(error) && Number.isInteger(error.code) ? error.code : "?"))
      : [];
    if (!response.ok || !isRecord(body) || body.success !== true) {
      throw new GuardError(`${label}: HTTP ${response.status}, Cloudflare error codes [${codes.join(", ")}].`);
    }
    return body;
  }
}

// ---------------------------------------------------------------------------------------------------------
// The plan

/** Entries of an allow-list variable: hostnames or route patterns, separated by commas or whitespace. */
export function parseAllowList(value) {
  return new Set(
    String(value ?? "")
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => (item.includes("/") || item.includes("*") ? item : item.toLowerCase())),
  );
}

/** The zone of a hostname: the longest suffix (at least two labels) that is a zone of the account. */
async function zoneForHost(client, accountId, host, cache) {
  const labels = host.split(".");
  for (let index = 0; index <= labels.length - 2; index += 1) {
    const candidate = labels.slice(index).join(".");
    const zone = await zoneByName(client, accountId, candidate, cache);
    if (zone) return zone;
  }
  return null;
}

async function zoneByName(client, accountId, name, cache) {
  if (!cache.has(name)) {
    const zones = await client.list(
      "/zones",
      { name, "account.id": accountId, per_page: "50" },
      "zone lookup",
    );
    const match = zones.find((zone) => isRecord(zone) && zone.name === name && typeof zone.id === "string");
    cache.set(name, match ? { id: match.id, name } : null);
  }
  return cache.get(name);
}

/** The host part of a zone route pattern ("*.example.com/x*" -> "example.com"), as wrangler infers zones. */
export function patternHost(pattern) {
  let host = pattern.replace(/^[a-z]+:\/\//i, "").split("/", 1)[0].toLowerCase();
  host = host.replace(/^\*\.?/, "");
  return HOSTNAME.test(host) ? host : null;
}

async function zoneForTarget(client, accountId, target, host, cache) {
  if (target.zoneId) return { id: target.zoneId, name: target.zoneName ?? null };
  if (target.zoneName) {
    const zone = await zoneByName(client, accountId, target.zoneName, cache);
    if (!zone) throw new GuardError(`zone ${target.zoneName} is not a zone of this account (or not readable).`);
    return zone;
  }
  return host ? zoneForHost(client, accountId, host, cache) : null;
}

/** Where to look up live entries that are not printed (they are not in the repository). */
const UNLISTED_HINT =
  "they are not printed here (not in the repository); see the dashboard's 配置漂移 panel or the Worker's " +
  "Domains & Routes in the Cloudflare dashboard";

/**
 * What wrangler would change for one Worker. Returns { lines, failures }: lines are printable (listed or
 * allow-listed hostnames and patterns, counts), failures are the printable reasons the deploy must stop.
 * A live entry that is neither listed nor allowed is counted, never named.
 */
export async function planWorker(client, triggers, { allowRemove = new Set(), allowConflict = new Set() } = {}) {
  const { name, accountId } = triggers;
  const lines = [];
  const failures = [];
  const zoneCache = new Map();
  const account = `/accounts/${accountId}`;

  // Custom Domains
  if (triggers.customDomains.length === 0) {
    lines.push("custom domains: none listed (wrangler leaves this Worker's Custom Domains alone)");
  } else {
    const listed = new Set(triggers.customDomains.map((domain) => domain.hostname));
    const live = (await client.list(`${account}/workers/domains`, { service: name }, "list Custom Domains"))
      .filter((domain) => isRecord(domain) && domain.service === name && typeof domain.hostname === "string")
      .map((domain) => domain.hostname.toLowerCase());
    const liveSet = new Set(live);
    lines.push(`custom domains: ${listed.size} listed, ${liveSet.size} live`);
    let unlisted = 0;
    for (const host of [...liveSet].sort()) {
      if (listed.has(host)) {
        lines.push(`  keep    ${host}`);
      } else if (allowRemove.has(host)) {
        lines.push(`  remove  ${host} (allowed by CF_GUARD_ALLOW_REMOVE)`);
      } else {
        unlisted += 1;
      }
    }
    if (unlisted > 0) {
      lines.push(`  REMOVE  ${unlisted} live Custom Domain(s) not in wrangler.toml`);
      failures.push(
        `${unlisted} live Custom Domain(s) of ${name} are not in wrangler.toml; the deploy would detach them (${UNLISTED_HINT}).`,
      );
    }
    for (const domain of triggers.customDomains) {
      const host = domain.hostname;
      const holders = (await client.list(`${account}/workers/domains`, { hostname: host }, "look up a Custom Domain"))
        .filter((item) => isRecord(item) && typeof item.hostname === "string" && item.hostname.toLowerCase() === host);
      const elsewhere = holders.some((item) => item.service !== name);
      if (elsewhere) {
        conflict(`Custom Domain ${host} belongs to a different Worker; the deploy would move it to ${name}.`, host);
        continue;
      }
      if (liveSet.has(host)) continue;
      lines.push(`  add     ${host}`);
      // A hostname new to this Worker: wrangler (in CI) overwrites an existing address record for it.
      let records;
      try {
        const zone = await zoneForTarget(client, accountId, domain, host, zoneCache);
        if (!zone) throw new GuardError(`no zone of this account contains ${host}`);
        records = await client.list(`/zones/${zone.id}/dns_records`, { name: host, per_page: "100" }, "list DNS records");
      } catch (error) {
        conflict(
          `cannot check the DNS records of the new Custom Domain ${host} (${error instanceof Error ? error.message : "error"}); check by hand, then allow it with CF_GUARD_ALLOW_CONFLICT.`,
          host,
        );
        continue;
      }
      const types = [
        ...new Set(
          records
            .filter((record) => isRecord(record) && String(record.name).toLowerCase() === host)
            .map((record) => String(record.type))
            .filter((type) => ADDRESS_TYPES.has(type)),
        ),
      ].sort();
      if (types.length > 0) {
        conflict(`new Custom Domain ${host} already has a DNS ${types.join("/")} record that the deploy would overwrite.`, host);
      }
    }
  }

  // Zone routes
  if (triggers.routes.length === 0) {
    lines.push("zone routes: none listed (wrangler leaves this Worker's zone routes alone)");
  } else {
    const zones = new Map();
    for (const route of triggers.routes) {
      const zone = await zoneForTarget(client, accountId, route, patternHost(route.pattern), zoneCache);
      if (!zone) {
        failures.push(`no zone of this account matches route ${route.pattern}.`);
        continue;
      }
      zones.set(zone.id, zone);
    }
    // PUT /workers/scripts/<name>/routes replaces the script's routes in every zone, not only these.
    const accountZones = await client.list("/zones", { "account.id": accountId, per_page: "50" }, "list zones");
    for (const zone of accountZones) {
      if (isRecord(zone) && typeof zone.id === "string") zones.set(zone.id, { id: zone.id, name: zone.name });
    }
    const listed = new Set(triggers.routes.map((route) => route.pattern));
    const mine = new Set();
    const others = new Set();
    for (const zone of zones.values()) {
      for (const route of await client.list(`/zones/${zone.id}/workers/routes`, {}, "list zone routes")) {
        if (!isRecord(route) || typeof route.pattern !== "string") continue;
        (route.script === name ? mine : others).add(route.pattern);
      }
    }
    lines.push(`zone routes: ${listed.size} listed, ${mine.size} live`);
    let unlisted = 0;
    for (const pattern of [...mine].sort()) {
      if (listed.has(pattern)) {
        lines.push(`  keep    ${pattern}`);
      } else if (allowRemove.has(pattern)) {
        lines.push(`  remove  ${pattern} (allowed by CF_GUARD_ALLOW_REMOVE)`);
      } else {
        unlisted += 1;
      }
    }
    if (unlisted > 0) {
      lines.push(`  REMOVE  ${unlisted} live zone route(s) not in wrangler.toml`);
      failures.push(
        `${unlisted} live zone route(s) of ${name} are not in wrangler.toml; the deploy would delete them (${UNLISTED_HINT}).`,
      );
    }
    for (const pattern of [...listed].sort()) {
      if (mine.has(pattern)) continue;
      if (others.has(pattern)) {
        conflict(`zone route ${pattern} belongs to a different Worker.`, pattern);
      } else {
        lines.push(`  add     ${pattern}`);
      }
    }
  }
  return { lines, failures };

  function conflict(message, key) {
    if (allowConflict.has(key)) {
      lines.push(`  allowed conflict (CF_GUARD_ALLOW_CONFLICT): ${message}`);
    } else {
      lines.push(`  CONFLICT ${key}`);
      failures.push(message);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// CLI

export function parseArgs(argv) {
  const configs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config" && argv[index + 1]) {
      configs.push(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith("--config=")) {
      configs.push(arg.slice("--config=".length));
    } else {
      throw new GuardError(`unknown argument ${arg}; usage: cf-guard.mjs --config <wrangler.toml> [--config ...]`);
    }
  }
  if (configs.length === 0) throw new GuardError("usage: cf-guard.mjs --config <wrangler.toml> [--config ...]");
  return configs;
}

/** The API base: Cloudflare, or a loopback test server (never another host that would receive the token). */
export function apiUrlFrom(env) {
  const value = env.CF_GUARD_API_URL;
  if (!value) return API_URL;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new GuardError("CF_GUARD_API_URL is not a URL.");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new GuardError("CF_GUARD_API_URL may only point at a loopback test server.");
  }
  return value.replace(/\/$/, "");
}

export async function main(argv, env, { log = console.log, fetchImpl } = {}) {
  let failed = false;
  try {
    const configs = parseArgs(argv);
    const allowRemove = parseAllowList(env.CF_GUARD_ALLOW_REMOVE);
    const allowConflict = parseAllowList(env.CF_GUARD_ALLOW_CONFLICT);
    const workers = [];
    for (const file of configs) workers.push({ file, triggers: await readTriggers(file) });
    // No request (and no token needed) when no config lists a route of either kind.
    const needed = workers.some(({ triggers }) => triggers.customDomains.length + triggers.routes.length > 0);
    const client = needed
      ? new CloudflareClient({ token: env.CLOUDFLARE_API_TOKEN, fetchImpl, apiUrl: apiUrlFrom(env) })
      : null;
    for (const { file, triggers } of workers) {
      log(`cf-guard: ${triggers.name} (${path.relative(process.cwd(), path.resolve(file)) || file})`);
      if (!client || triggers.customDomains.length + triggers.routes.length === 0) {
        log("  no routes or Custom Domains listed; wrangler changes none: skipped");
        continue;
      }
      const { lines, failures } = await planWorker(client, triggers, { allowRemove, allowConflict });
      for (const line of lines) log(`  ${line}`);
      for (const failure of failures) log(`  FAIL: ${failure}`);
      failed ||= failures.length > 0;
    }
    if (failed) {
      log(
        "cf-guard: FAIL. Fix wrangler.toml (it must list every live hostname), or for an intentional change set " +
          "CF_GUARD_ALLOW_REMOVE / CF_GUARD_ALLOW_CONFLICT on this deploy step to the exact hostnames or patterns.",
      );
      return 1;
    }
    log("cf-guard: PASS");
    return 0;
  } catch (error) {
    // Our messages carry no body or id; anything else is named by its type only.
    const detail = error instanceof GuardError ? error.message : `unexpected ${error?.name ?? "failure"}`;
    log(`cf-guard: ERROR: ${detail}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
