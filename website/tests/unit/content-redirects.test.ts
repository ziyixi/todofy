import { describe, expect, it } from "vitest";

import { resolveRedirects } from "../../scripts/content/redirects";
import { sha256 } from "../../src/lib/content/hash";
import {
  RedirectConfigSchema,
  type Post,
  type SnapshotRedirect,
} from "../../src/lib/content/schema";

function post(slug: string): Post {
  const sourceKey = sha256(slug);
  return {
    sourceKey,
    feedGuid: `urn:ziyixi:post:${sourceKey}`,
    slug,
    title: "Post",
    summary: "Post summary",
    language: "en",
    publishedAt: "2026-01-01T00:00:00.000Z",
    tags: [],
    blocks: [],
    toc: [],
    media: [],
  };
}

describe("literal redirect sources", () => {
  it("accepts a normalized literal path", () => {
    expect(RedirectConfigSchema.parse({ from: "/notes/旧文", to: "/blog" }).from).toBe(
      "/notes/旧文",
    );
  });

  it.each([
    "/notes/:path*",
    "/notes/(.*)",
    "/notes/%2e%2e/blog",
    "/notes\\old",
    "/notes//old",
    "/notes/../blog",
    "/notes/",
  ])("rejects matcher, encoding, or non-canonical source %s", (from) => {
    expect(() => RedirectConfigSchema.parse({ from, to: "/blog" })).toThrow(
      /normalized literal path/,
    );
  });

  it.each([
    "/",
    "/blog",
    "/publications",
    "/feed.xml",
    "/sitemap.xml",
    "/robots.txt",
    "/build-info.json",
    "/cv.pdf",
    "/_next/static/chunk.js",
    "/media/file.png",
    "/profile/photo.png",
    "/fonts/site.woff2",
  ])("protects application route %s", (from) => {
    expect(() => RedirectConfigSchema.parse({ from, to: "/blog" })).toThrow(/shadows/);
  });

  it("protects current article routes for configured and automatic redirects", () => {
    const posts = [post("current")];
    expect(() => resolveRedirects([{ from: "/blog/current", to: "/blog" }], posts, [])).toThrow(
      /shadows a public route/,
    );

    const automatic: SnapshotRedirect[] = [
      { from: "/blog/current", to: "/blog/current", status: 308 },
    ];
    expect(() => resolveRedirects([], posts, automatic)).toThrow(/shadows a public route/);
  });
});
