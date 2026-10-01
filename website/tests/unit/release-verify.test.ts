import { readFile } from "node:fs/promises";

import { parse } from "smol-toml";
import { describe, expect, it, vi } from "vitest";

import { CloudflareApi } from "../../scripts/release/cloudflare";
import { waitForIdentity } from "../../scripts/release/verify";
import { liveOrigin, otherOrigins, parseWorkerConfig } from "../../scripts/release/worker-config";

const expected = {
  codeSha: "a".repeat(40),
  contentHash: "c".repeat(64),
  configHash: "b".repeat(64),
  schemaVersion: 1 as const,
};
const old = { ...expected, codeSha: "d".repeat(40) };

function answer(body: unknown, init: { status?: number; cacheControl?: string } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": init.cacheControl ?? "no-store, max-age=0",
    },
  });
}

function scripted(...responses: (Response | Error)[]) {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next instanceof Error) throw next;
    return next.clone();
  }) as unknown as typeof fetch;
}

const quiet = { sleep: async () => undefined, log: () => undefined };

describe("live identity verification", () => {
  it("needs the configured number of consecutive matches", async () => {
    const fetchImpl = scripted(answer(old), answer(expected), answer(old), answer(expected));
    await expect(
      waitForIdentity("https://example.test", expected, {
        ...quiet,
        fetchImpl,
        attempts: 6,
        consecutive: 3,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("fails after the bounded attempts without a stable match", async () => {
    const fetchImpl = scripted(answer(old));
    await expect(
      waitForIdentity("https://example.test", expected, { ...quiet, fetchImpl, attempts: 3 }),
    ).rejects.toThrow(/does not serve the expected build identity/);
  });

  it("waits for a new hostname to become reachable, then checks the answer", async () => {
    const fetchImpl = scripted(
      new Error("connect ECONNREFUSED"),
      answer({}, { status: 526 }),
      answer(expected),
    );
    await expect(
      waitForIdentity("https://example.test", expected, {
        ...quiet,
        fetchImpl,
        reachAttempts: 3,
      }),
    ).resolves.toBeUndefined();
    await expect(
      waitForIdentity("https://example.test", expected, {
        ...quiet,
        fetchImpl: scripted(new Error("no route")),
        reachAttempts: 2,
      }),
    ).rejects.toThrow(/never became reachable/);
  });

  it("refuses a cacheable, redirected or malformed identity", async () => {
    for (const response of [
      answer(expected, { cacheControl: "public, max-age=14400" }),
      answer(expected, { status: 308 }),
      answer({ codeSha: "x" }),
    ]) {
      await expect(
        waitForIdentity("https://example.test", expected, {
          ...quiet,
          fetchImpl: scripted(response),
        }),
      ).rejects.toThrow();
    }
  });
});

describe("website wrangler.toml", () => {
  it("is an assets-only Worker without workers.dev or previews, on the Custom Domains www and the apex", async () => {
    const text = await readFile("wrangler.toml", "utf8");
    const config = parseWorkerConfig(text);
    expect(config.name).toBe("ziyixi-website");
    expect(config.accountId).toBe("f57937bd1d93bf59e737b6d8445fb7a3");
    // Exactly the live state (docs/architecture.md "Hostnames"): wrangler replaces the Worker's Custom
    // Domains with this list at every release, so anything else would attach or detach a hostname.
    // No zone route and no preview host.
    expect(config.hostnames).toEqual(["www.ziyixi.science", "ziyixi.science"]);
    expect((parse(text) as { routes: unknown }).routes).toEqual([
      { pattern: "www.ziyixi.science", custom_domain: true },
      { pattern: "ziyixi.science", custom_domain: true },
    ]);
    expect(text).not.toMatch(/zone_name|website-preview/);
    // The full route contract runs on www; the apex must serve the same identity.
    expect(liveOrigin(config, "https://www.ziyixi.science")).toBe("https://www.ziyixi.science");
    expect(otherOrigins(config, "https://www.ziyixi.science")).toEqual(["https://ziyixi.science"]);
    expect(text).toContain('html_handling = "auto-trailing-slash"');
    expect(text).toContain('not_found_handling = "404-page"');
  });

  const base = `name = "ziyixi-website"\naccount_id = "${"f".repeat(32)}"\nworkers_dev = false\npreview_urls = false\n`;

  it("relies on wrangler replacing the Worker's Custom Domains with the listed set (docs: wrangler.toml)", async () => {
    // wrangler.toml says its Custom Domains are the complete set: `wrangler triggers deploy` sends the
    // replace_state changeset and then PUTs the listed domains with override_scope, but only when at
    // least one Custom Domain is listed (and the route PUT only when a zone route is). After a wrangler
    // upgrade, re-read publishCustomDomains and triggersDeploy and update the comment if this changed.
    const cli = await readFile("node_modules/wrangler/wrangler-dist/cli.js", "utf8");
    expect(cli).toContain("if (customDomainsOnly.length > 0) {");
    expect(cli).toContain("if (routesOnly.length > 0) {");
    expect(cli).toContain("/domains/changeset?replace_state=true");
    expect(cli).toMatch(/override_scope: true,[\s\S]{0,8000}?\$\{workerUrl\}\/domains\/records`/);
    const config = await readFile("wrangler.toml", "utf8");
    expect(config).toContain("complete set of Custom Domains");
    expect(config).toMatch(/Removing a\s+(#\s+)?line detaches that hostname/);
  });

  it("verifies the canonical host once attached, otherwise the first hostname", () => {
    const none = parseWorkerConfig(base);
    expect(none.hostnames).toEqual([]);
    expect(liveOrigin(none, "https://www.ziyixi.science")).toBeNull();
    expect(otherOrigins(none, "https://www.ziyixi.science")).toEqual([]);
    const apex = parseWorkerConfig(
      `${base}routes = [{ pattern = "ziyixi.science", custom_domain = true }]\n`,
    );
    expect(liveOrigin(apex, "https://www.ziyixi.science")).toBe("https://ziyixi.science");
    expect(otherOrigins(apex, "https://www.ziyixi.science")).toEqual([]);
    // The file order does not matter: www is the live hostname whenever it is listed.
    const both = parseWorkerConfig(
      `${base}routes = [{ pattern = "ziyixi.science", custom_domain = true }, { pattern = "www.ziyixi.science", custom_domain = true }]\n`,
    );
    expect(liveOrigin(both, "https://www.ziyixi.science")).toBe("https://www.ziyixi.science");
    expect(otherOrigins(both, "https://www.ziyixi.science")).toEqual(["https://ziyixi.science"]);
  });

  it("reads a whole-host zone route as its hostname", () => {
    const route = parseWorkerConfig(
      `${base}routes = [{ pattern = "ziyixi.science", custom_domain = true }, { pattern = "www.ziyixi.science/*", zone_name = "ziyixi.science" }]\n`,
    );
    expect(route.hostnames).toEqual(["ziyixi.science", "www.ziyixi.science"]);
    expect(liveOrigin(route, "https://www.ziyixi.science")).toBe("https://www.ziyixi.science");
    expect(otherOrigins(route, "https://www.ziyixi.science")).toEqual(["https://ziyixi.science"]);
    const onlyRoute = parseWorkerConfig(
      `${base}routes = [{ pattern = "www.ziyixi.science/*", zone_name = "ziyixi.science" }]\n`,
    );
    expect(liveOrigin(onlyRoute, "https://www.ziyixi.science")).toBe("https://www.ziyixi.science");
    const apexZone = parseWorkerConfig(
      `${base}routes = [{ pattern = "ziyixi.science/*", zone_name = "ziyixi.science" }]\n`,
    );
    expect(apexZone.hostnames).toEqual(["ziyixi.science"]);
    expect(liveOrigin(apexZone, "https://www.ziyixi.science")).toBe("https://ziyixi.science");
  });

  it("refuses partial or wildcard routes, a script, or a workers.dev copy", () => {
    const head = `name = "ziyixi-website"\naccount_id = "${"f".repeat(32)}"\n`;
    expect(() => parseWorkerConfig(`${head}workers_dev = true\npreview_urls = false\n`)).toThrow();
    expect(() =>
      parseWorkerConfig(`${head}main = "x.js"\nworkers_dev = false\npreview_urls = false\n`),
    ).toThrow(/assets-only/);
    const refused: [string, RegExp][] = [
      ['"www.ziyixi.science/*"', /Custom Domains .* or whole-host zone routes/],
      ['{ pattern = "www.ziyixi.science/*" }', /whole-host zone routes/],
      ['{ pattern = "www.ziyixi.science/*", zone_id = "abc" }', /whole-host zone routes/],
      [
        '{ pattern = "www.ziyixi.science/*", zone_name = "ziyixi.science", custom_domain = false }',
        /whole-host zone routes/,
      ],
      ['{ pattern = "www.ziyixi.science", custom_domain = true, zone_name = "x" }', /zone routes/],
      ['{ pattern = "www.ziyixi.science/*", custom_domain = true }', /bare hostname/],
      ['{ pattern = "www.ziyixi.science", zone_name = "ziyixi.science" }', /"<host>\/\*"/],
      ['{ pattern = "www.ziyixi.science/blog/*", zone_name = "ziyixi.science" }', /"<host>\/\*"/],
      ['{ pattern = "*.ziyixi.science/*", zone_name = "ziyixi.science" }', /"<host>\/\*"/],
      ['{ pattern = "*ziyixi.science/*", zone_name = "ziyixi.science" }', /"<host>\/\*"/],
      [
        '{ pattern = "https://www.ziyixi.science/*", zone_name = "ziyixi.science" }',
        /"<host>\/\*"/,
      ],
      ['{ pattern = "www.example.com/*", zone_name = "ziyixi.science" }', /outside its zone/],
      ['{ pattern = "wwwziyixi.science/*", zone_name = "ziyixi.science" }', /outside its zone/],
      [
        '{ pattern = "www.ziyixi.science/*", zone_name = "ziyixi.science" }, { pattern = "www.ziyixi.science", custom_domain = true }',
        /twice/,
      ],
    ];
    for (const [routes, message] of refused) {
      expect(
        () =>
          parseWorkerConfig(
            `${head}workers_dev = false\npreview_urls = false\nroutes = [${routes}]\n`,
          ),
        routes,
      ).toThrow(message);
    }
  });
});

describe("Cloudflare production state", () => {
  const config = { name: "ziyixi-website", accountId: "f".repeat(32), hostnames: [] };
  const version = "11111111-1111-4111-8111-111111111111";

  it("reads the version serving all traffic, or null before the first deploy", async () => {
    const live = new CloudflareApi({
      config,
      token: "t",
      fetchImpl: scripted(
        answer({
          success: true,
          result: { deployments: [{ versions: [{ version_id: version, percentage: 100 }] }] },
        }),
      ),
    });
    await expect(live.activeVersion()).resolves.toBe(version);
    const missing = new CloudflareApi({
      config,
      token: "t",
      fetchImpl: scripted(answer({ success: false, errors: [{ code: 10007 }] }, { status: 404 })),
    });
    await expect(missing.activeVersion()).resolves.toBeNull();
  });

  it("refuses a split deployment and API failures", async () => {
    const split = new CloudflareApi({
      config,
      token: "t",
      fetchImpl: scripted(
        answer({
          success: true,
          result: {
            deployments: [
              {
                versions: [
                  { version_id: version, percentage: 50 },
                  { version_id: version, percentage: 50 },
                ],
              },
            ],
          },
        }),
      ),
    });
    await expect(split.activeVersion()).rejects.toThrow(/splits traffic/);
    const denied = new CloudflareApi({
      config,
      token: "t",
      fetchImpl: scripted(answer({ success: false, errors: [{ code: 10000 }] }, { status: 403 })),
    });
    await expect(denied.activeVersion()).rejects.toThrow(/HTTP 403/);
  });
});
