import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { CloudflareApi } from "../../scripts/release/cloudflare";
import { waitForIdentity } from "../../scripts/release/verify";
import { liveOrigin, parseWorkerConfig } from "../../scripts/release/worker-config";

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
  it("is an assets-only Worker without workers.dev or previews, on the cutover hostnames only", async () => {
    const config = parseWorkerConfig(await readFile("wrangler.toml", "utf8"));
    expect(config.name).toBe("ziyixi-website");
    expect(config.accountId).toBe("f57937bd1d93bf59e737b6d8445fb7a3");
    // docs/cutover.md: the preview hostname first, then www; nothing else is ever attached here.
    for (const host of config.hostnames) {
      expect(["website-preview.ziyixi.science", "www.ziyixi.science"]).toContain(host);
    }
    const origin = liveOrigin(config, "https://www.ziyixi.science");
    if (config.hostnames.length === 0) expect(origin).toBeNull();
    else
      expect(origin).toBe(
        `https://${config.hostnames.includes("www.ziyixi.science") ? "www.ziyixi.science" : config.hostnames[0]}`,
      );
    const text = await readFile("wrangler.toml", "utf8");
    expect(text).toContain('html_handling = "auto-trailing-slash"');
    expect(text).toContain('not_found_handling = "404-page"');
  });

  it("verifies the canonical host once attached, otherwise the first hostname", () => {
    const base = `name = "ziyixi-website"\naccount_id = "${"f".repeat(32)}"\nworkers_dev = false\npreview_urls = false\n`;
    const preview = parseWorkerConfig(
      `${base}routes = [{ pattern = "website-preview.ziyixi.science", custom_domain = true }]\n`,
    );
    expect(liveOrigin(preview, "https://www.ziyixi.science")).toBe(
      "https://website-preview.ziyixi.science",
    );
    const both = parseWorkerConfig(
      `${base}routes = [{ pattern = "website-preview.ziyixi.science", custom_domain = true }, { pattern = "www.ziyixi.science", custom_domain = true }]\n`,
    );
    expect(liveOrigin(both, "https://www.ziyixi.science")).toBe("https://www.ziyixi.science");
  });

  it("refuses zone routes, a script, or a workers.dev copy", () => {
    const base = `name = "ziyixi-website"\naccount_id = "${"f".repeat(32)}"\n`;
    expect(() => parseWorkerConfig(`${base}workers_dev = true\npreview_urls = false\n`)).toThrow();
    expect(() =>
      parseWorkerConfig(`${base}main = "x.js"\nworkers_dev = false\npreview_urls = false\n`),
    ).toThrow(/assets-only/);
    expect(() =>
      parseWorkerConfig(
        `${base}workers_dev = false\npreview_urls = false\nroutes = ["www.ziyixi.science/*"]\n`,
      ),
    ).toThrow(/Custom Domains/);
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
