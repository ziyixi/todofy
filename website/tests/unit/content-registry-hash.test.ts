import { describe, expect, it } from "vitest";

import { hashContentSnapshot, sha256 } from "../../src/lib/content/hash";
import { buildCandidateRegistry, emptyContentRegistry } from "../../src/lib/content/registry";
import type { Post } from "../../src/lib/content/schema";
import { makePost as buildPost, makeSnapshot } from "../support/deployment-contract";

function makePost(slug: string, identity = "article-one", text = "Visible text"): Post {
  return buildPost(slug, {
    sourceKey: sha256(identity),
    blocks: [
      {
        id: "synthetic-paragraph",
        type: "paragraph",
        richText: [{ text }],
        children: [],
      },
    ],
  });
}

describe("content hash", () => {
  it("changes when visible content changes", () => {
    expect(hashContentSnapshot(makeSnapshot([makePost("article", "same", "before")]))).not.toBe(
      hashContentSnapshot(makeSnapshot([makePost("article", "same", "after")])),
    );
  });

  it("is deterministic for an identical normalized snapshot", () => {
    const value = makeSnapshot([makePost("article")]);
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
