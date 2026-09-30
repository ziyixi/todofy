import { readFile } from "node:fs/promises";

import { parse } from "smol-toml";

export interface WorkerConfig {
  name: string;
  accountId: string;
  /** Custom-domain hostnames in wrangler.toml, in file order. */
  hostnames: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const hostnames = routes.map((route) => {
    if (!isRecord(route) || route.custom_domain !== true || typeof route.pattern !== "string") {
      throw new Error(
        'Website routes must be Custom Domains: { pattern = "<host>", custom_domain = true }.',
      );
    }
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(route.pattern)) {
      throw new Error(`Custom Domain must be a bare hostname: ${route.pattern}`);
    }
    return route.pattern;
  });
  return { name, accountId, hostnames };
}

export async function readWorkerConfig(filename = "wrangler.toml"): Promise<WorkerConfig> {
  return parseWorkerConfig(await readFile(filename, "utf8"));
}

/**
 * Where a release verifies the live site: the canonical host once it is attached, otherwise the
 * first attached hostname (the preview host), otherwise nowhere.
 */
export function liveOrigin(config: WorkerConfig, canonicalOrigin: string): string | null {
  const canonicalHost = new URL(canonicalOrigin).hostname;
  const host = config.hostnames.includes(canonicalHost) ? canonicalHost : config.hostnames[0];
  return host ? `https://${host}` : null;
}
