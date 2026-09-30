import { readFile } from "node:fs/promises";

import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import { CANONICAL_ORIGIN, HSTS, pathAndQuery } from "../src/redirect";

async function answer(url: string, init?: RequestInit) {
  const response = worker.fetch(new Request(url, init));
  return { response, body: await response.text() };
}

describe("apex redirect", () => {
  it("answers 308 to www with HSTS, no body and no other header", async () => {
    const { response, body } = await answer("https://ziyixi.science/");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://www.ziyixi.science/");
    expect(response.headers.get("strict-transport-security")).toBe("max-age=63072000");
    expect([...response.headers.keys()].sort()).toEqual(["location", "strict-transport-security"]);
    expect(body).toBe("");
    expect(HSTS).toBe("max-age=63072000");
    expect(CANONICAL_ORIGIN).toBe("https://www.ziyixi.science");
  });

  it("keeps the path and the query exactly", async () => {
    for (const [url, location] of [
      ["https://ziyixi.science", "https://www.ziyixi.science/"],
      ["https://ziyixi.science/blog", "https://www.ziyixi.science/blog"],
      ["https://ziyixi.science/blog/", "https://www.ziyixi.science/blog/"],
      [
        "https://ziyixi.science/blog/post?utm_source=x&b=2&b=1",
        "https://www.ziyixi.science/blog/post?utm_source=x&b=2&b=1",
      ],
      ["https://ziyixi.science/feed.xml?", "https://www.ziyixi.science/feed.xml?"],
      ["https://ziyixi.science/a?=&&x", "https://www.ziyixi.science/a?=&&x"],
      ["http://ziyixi.science/cv.pdf?download=1", "https://www.ziyixi.science/cv.pdf?download=1"],
    ] as const) {
      const { response } = await answer(url);
      expect(response.headers.get("location"), url).toBe(location);
    }
  });

  it("keeps percent-encoding as sent and encodes raw characters once", async () => {
    for (const [url, location] of [
      [
        "https://ziyixi.science/%E4%B8%AD%E6%96%87/a%20b%2Fc?q=%E4%B8%AD&r=a+b&s=%26%3D",
        "https://www.ziyixi.science/%E4%B8%AD%E6%96%87/a%20b%2Fc?q=%E4%B8%AD&r=a+b&s=%26%3D",
      ],
      [
        "https://ziyixi.science/中文?q=中 文",
        "https://www.ziyixi.science/%E4%B8%AD%E6%96%87?q=%E4%B8%AD%20%E6%96%87",
      ],
      // Dot segments (also encoded ones) resolve as the URL standard says, as the runtime's request.url.
      ["https://ziyixi.science/a/%2e%2E/x", "https://www.ziyixi.science/x"],
    ] as const) {
      const { response } = await answer(url);
      expect(response.headers.get("location"), url).toBe(location);
    }
  });

  it("drops a fragment and credentials, which are never part of the redirect", () => {
    expect(pathAndQuery("https://ziyixi.science/a?b=1#c")).toBe("/a?b=1");
    expect(pathAndQuery("https://user:pass@ziyixi.science/a")).toBe("/a");
  });

  it("answers HEAD, POST and every other method the same way", async () => {
    for (const method of ["HEAD", "GET", "POST", "PUT", "DELETE", "OPTIONS"]) {
      const { response, body } = await answer("https://ziyixi.science/x?y=1", { method });
      expect(response.status, method).toBe(308);
      expect(response.headers.get("location"), method).toBe("https://www.ziyixi.science/x?y=1");
      expect(response.headers.get("strict-transport-security"), method).toBe(HSTS);
      expect(body, method).toBe("");
    }
  });

  it("never sends a request anywhere but www.ziyixi.science", async () => {
    for (const url of [
      "https://evil.example/x",
      "https://ziyixi.science//evil.example/x",
      "https://ziyixi.science/\\evil.example",
      "https://ziyixi.science/@evil.example",
      "https://ziyixi.science/%2F%2Fevil.example",
      "https://ziyixi.science:8443/x?next=https://evil.example",
      "https://ziyixi.science/x?host=evil.example#@evil.example",
    ]) {
      const { response } = await answer(url, {
        headers: { Host: "evil.example", "X-Forwarded-Host": "evil.example" },
      });
      const location = response.headers.get("location") ?? "";
      expect(location.startsWith("https://www.ziyixi.science/"), url).toBe(true);
      const target = new URL(location);
      expect(target.protocol, url).toBe("https:");
      expect(target.host, url).toBe("www.ziyixi.science");
      expect(target.username + target.password, url).toBe("");
    }
  });
});

describe("apex-redirect Worker module", () => {
  it("exports only the fetch handler (helpers live in redirect.ts)", async () => {
    const entry = await import("../src/index");
    expect(Object.keys(entry)).toEqual(["default"]);
    expect(Object.keys(entry.default)).toEqual(["fetch"]);
  });
});

describe("apex-redirect/wrangler.toml", () => {
  it("is exactly the apex zone route, no workers.dev, no previews, no bindings", async () => {
    const config = parse(await readFile("apex-redirect/wrangler.toml", "utf8"));
    expect(config).toEqual({
      name: "ziyixi-apex-redirect",
      account_id: "f57937bd1d93bf59e737b6d8445fb7a3",
      main: "src/index.ts",
      compatibility_date: "2026-09-25",
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: "ziyixi.science/*", zone_name: "ziyixi.science" }],
    });
  });
});
