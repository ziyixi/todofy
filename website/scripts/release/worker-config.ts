import { readFile } from "node:fs/promises";

import { parse } from "smol-toml";

export interface WorkerConfig {
  name: string;
  accountId: string;
  /**
   * The hostnames wrangler.toml attaches, in file order: Custom Domains (`<host>`) and whole-host zone
   * routes (`<host>/*` in the zone `zone_name`, on the zone's existing proxied DNS record).
   */
  hostnames: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const ROUTE_FORMS =
  'Website routes must be Custom Domains { pattern = "<host>", custom_domain = true } or whole-host zone routes { pattern = "<host>/*", zone_name = "<zone>" }.';

function sameKeys(route: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(route).sort().join(",") === [...keys].sort().join(",");
}

/**
 * One wrangler.toml route as the hostname it serves. A Custom Domain is a bare hostname. A zone route
 * must cover the whole host (`<host>/*`, no wildcard host, no path prefix) inside its `zone_name`, so
 * the hostname is exactly what the release can verify; anything else is refused.
 */
function routeHostname(route: unknown): string {
  if (!isRecord(route) || typeof route.pattern !== "string") throw new Error(ROUTE_FORMS);
  if (route.custom_domain === true && sameKeys(route, ["pattern", "custom_domain"])) {
    if (!HOSTNAME.test(route.pattern)) {
      throw new Error(`Custom Domain must be a bare hostname: ${route.pattern}`);
    }
    return route.pattern;
  }
  if (typeof route.zone_name === "string" && sameKeys(route, ["pattern", "zone_name"])) {
    const zone = route.zone_name;
    const host = route.pattern.endsWith("/*") ? route.pattern.slice(0, -2) : "";
    if (!HOSTNAME.test(host) || !HOSTNAME.test(zone)) {
      throw new Error(`A zone route must be "<host>/*" for one whole hostname: ${route.pattern}`);
    }
    if (host !== zone && !host.endsWith(`.${zone}`)) {
      throw new Error(`Route ${route.pattern} is outside its zone ${zone}.`);
    }
    return host;
  }
  throw new Error(ROUTE_FORMS);
}

/** Reads the facts a release needs from website/wrangler.toml, the single source of truth. */
export function parseWorkerConfig(text: string): WorkerConfig {
  const config = parse(text) as Record<string, unknown>;
  const name = config.name;
  const accountId = config.account_id;
  if (typeof name !== "string" || !/^[a-z0-9-]+$/.test(name)) {
    throw new Error("wrangler.toml needs a Worker name.");
  }
  if (typeof accountId !== "string" || !/^[0-9a-f]{32}$/.test(accountId)) {
    throw new Error("wrangler.toml needs the 32-character account_id.");
  }
  if (config.main !== undefined) {
    throw new Error("The website Worker is assets-only; wrangler.toml must not set main.");
  }
  if (config.workers_dev !== false || config.preview_urls !== false) {
    throw new Error("wrangler.toml must keep workers_dev = false and preview_urls = false.");
  }
  const routes = config.routes ?? [];
  if (!Array.isArray(routes)) throw new Error("wrangler.toml routes must be a list.");
  const hostnames = routes.map(routeHostname);
  const repeated = hostnames.find((host, index) => hostnames.indexOf(host) !== index);
  if (repeated) throw new Error(`wrangler.toml attaches ${repeated} twice.`);
  return { name, accountId, hostnames };
}

export async function readWorkerConfig(filename = "wrangler.toml"): Promise<WorkerConfig> {
  return parseWorkerConfig(await readFile(filename, "utf8"));
}

/**
 * Where a release verifies the live site: the canonical host once it is attached (as a Custom Domain
 * or a zone route), otherwise the first attached hostname, otherwise nowhere.
 */
export function liveOrigin(config: WorkerConfig, canonicalOrigin: string): string | null {
  const canonicalHost = new URL(canonicalOrigin).hostname;
  const host = config.hostnames.includes(canonicalHost) ? canonicalHost : config.hostnames[0];
  return host ? `https://${host}` : null;
}

/**
 * Every other hostname wrangler.toml attaches (today the apex next to www), in file order: after the
 * live hostname passed the whole route contract, each must serve the same build identity too, so a
 * release never leaves one of the Worker's hostnames on something else.
 */
export function otherOrigins(config: WorkerConfig, canonicalOrigin: string): string[] {
  const live = liveOrigin(config, canonicalOrigin);
  return config.hostnames.map((host) => `https://${host}`).filter((origin) => origin !== live);
}
