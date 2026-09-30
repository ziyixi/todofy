import { describe, expect, it } from "vitest";

import { hashContentSnapshot, sha256 } from "../../src/lib/content/hash";
import { buildCandidateRegistry, emptyContentRegistry } from "../../src/lib/content/registry";
import {
  CONTENT_SCHEMA_VERSION,
  type ContentSnapshot,
  type Post,
} from "../../src/lib/content/schema";

function makePost(slug: string, identity = "article-one", text = "Visible text"): Post {
  const sourceKey = sha256(identity);
  return {
    sourceKey,
    feedGuid: `urn:ziyixi:post:${sourceKey}`,
    slug,
    title: "Synthetic post",
    summary: "A summary for a synthetic post.",
    language: "en",
    publishedAt: "2025-02-03T00:00:00.000Z",
    tags: [],
    blocks: [
      {
        id: "synthetic-paragraph",
        type: "paragraph",
        richText: [{ text }],
        children: [],
      },
    ],
    toc: [],
    media: [],
  };
}

function snapshot(post: Post): ContentSnapshot {
  return {
    schemaVersion: CONTENT_SCHEMA_VERSION,
    sourceMode: "fixture",
    posts: [post],
    media: [],
    redirects: [],
  };
}

describe("content hash", () => {
  it("changes when visible content changes", () => {
    expect(hashContentSnapshot(snapshot(makePost("article", "same", "before")))).not.toBe(
      hashContentSnapshot(snapshot(makePost("article", "same", "after"))),
    );
  });

  it("is deterministic for an identical normalized snapshot", () => {
    const value = snapshot(makePost("article"));
    expect(hashContentSnapshot(value)).toBe(hashContentSnapshot(structuredClone(value)));
  });
});

describe("content registry", () => {
  it("preserves identity and makes a direct alias after a slug change", () => {
    const original = makePost("old-slug");
    const baseline = buildCandidateRegistry([original], emptyContentRegistry()).registry;
    const renamed = makePost("new-slug");
    const candidate = buildCandidateRegistry([renamed], baseline);

    expect(candidate.registry.posts[0]).toMatchObject({
      sourceKey: original.sourceKey,
      currentSlug: "new-slug",
      historicalSlugs: ["old-slug"],
      feedGuid: original.feedGuid,
      published: true,
    });
    expect(candidate.redirects).toEqual([
      {
        from: "/blog/old-slug",
        to: "/blog/new-slug",
        status: 308,
        sourceKey: original.sourceKey,
      },
    ]);
  });

  it("keeps withdrawn identity but emits no live aliases", () => {
    const original = makePost("old-slug");
    const baseline = buildCandidateRegistry([original], emptyContentRegistry()).registry;
    const withdrawn = buildCandidateRegistry([], baseline);
    expect(withdrawn.registry.posts[0]?.published).toBe(false);
    expect(withdrawn.redirects).toEqual([]);
  });

  it("does not allow another article to claim a historical slug", () => {
    const first = makePost("reserved-forever", "first");
    const baseline = buildCandidateRegistry([first], emptyContentRegistry()).registry;
    const impostor = makePost("reserved-forever", "second");
    expect(() => buildCandidateRegistry([impostor], baseline)).toThrow(/previously used/);
  });
});
