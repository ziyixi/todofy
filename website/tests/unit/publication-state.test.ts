import { describe, expect, it } from "vitest";

import { hashContentSnapshot, sha256, sourceKeyForNotionPage } from "../../src/lib/content/hash";
import {
  createPublicationState,
  hashPostContent,
  PublicationStateSchema,
  type PublicationIdentity,
} from "../../src/lib/content/publication-state";
import { validateLiteralRedirectSource } from "../../src/lib/content/redirect-path";
import {
  CONTENT_SCHEMA_VERSION,
  type ContentSnapshot,
  type Post,
} from "../../src/lib/content/schema";
import { validateSlug } from "../../src/lib/content/slug";
import { validateContentSnapshot } from "../../src/lib/content/validate";

function makePost(slug = "published-note", key = sha256(slug)): Post {
  return {
    sourceKey: key,
    feedGuid: `urn:ziyixi:post:${key}`,
    slug,
    title: "A published note",
    summary: "Public article metadata.",
    language: "en",
    publishedAt: "2026-01-01T00:00:00.000Z",
    tags: [],
    blocks: [
      {
        id: "public-paragraph",
        type: "paragraph",
        richText: [{ text: "Public article body." }],
        children: [],
      },
    ],
    toc: [],
    media: [],
  };
}

function snapshot(posts: Post[] = []): ContentSnapshot {
  return {
    schemaVersion: CONTENT_SCHEMA_VERSION,
    sourceMode: posts.length ? "fixture" : "empty",
    posts,
    media: [],
    redirects: [],
  };
}

function identity(value: ContentSnapshot): PublicationIdentity {
  return {
    codeSha: "a".repeat(40),
    contentHash: hashContentSnapshot(value),
    configHash: sha256("public-config"),
    schemaVersion: CONTENT_SCHEMA_VERSION,
  };
}

describe("per-article publication identity", () => {
  it("hashes normalized content independently of object key order", () => {
    const post = makePost();
    const reversed = Object.fromEntries(Object.entries(post).reverse()) as Post;
    expect(hashPostContent(reversed)).toBe(hashPostContent(post));
    expect(hashPostContent({ ...post, title: `  ${post.title}  ` })).toBe(hashPostContent(post));
  });

  it("changes for published body, metadata, translation and media changes", () => {
    const post = makePost();
    const baseHash = hashPostContent(post);
    const imageHash = sha256("image bytes");
    const imagePath = `/media/${imageHash}.png`;
    const variants: Post[] = [
      { ...post, title: "A renamed note" },
      { ...post, summary: "A revised summary." },
      { ...post, slug: "renamed-note" },
      { ...post, language: "zh-CN" },
      { ...post, translationKey: "related-notes" },
      { ...post, updatedAt: "2026-01-02T00:00:00.000Z" },
      { ...post, tags: ["systems"] },
      {
        ...post,
        blocks: [
          {
            id: "public-paragraph",
            type: "paragraph",
            richText: [{ text: "A revised article body." }],
            children: [],
          },
        ],
      },
      {
        ...post,
        media: [imagePath],
        blocks: [
          ...post.blocks,
          {
            id: "public-image",
            type: "image",
            mediaPath: imagePath,
            sha256: imageHash,
            width: 20,
            height: 20,
            alt: "An example diagram",
            caption: [],
          },
        ],
      },
    ];
    for (const changed of variants) expect(hashPostContent(changed)).not.toBe(baseHash);
  });

  it("keeps an unchanged article hash when another article or the code release changes", () => {
    const first = makePost("first");
    const second = makePost("second");
    const before = snapshot([first, second]);
    const after = snapshot([first, { ...second, title: "Changed second article" }]);
    const initial = createPublicationState(before, identity(before));
    const next = createPublicationState(after, { ...identity(after), codeSha: "b".repeat(40) });
    expect(next.identity).not.toEqual(initial.identity);
    expect(next.posts.find((post) => post.sourceKey === first.sourceKey)).toEqual(
      initial.posts.find((post) => post.sourceKey === first.sourceKey),
    );
    expect(next.posts.find((post) => post.sourceKey === second.sourceKey)?.contentHash).not.toBe(
      initial.posts.find((post) => post.sourceKey === second.sourceKey)?.contentHash,
    );
  });

  it("rejects operations fields instead of silently hashing or publishing them", () => {
    const post = { ...makePost(), syncStatus: "Published", notionPageId: "private-source-id" };
    expect(() => hashPostContent(post)).toThrow();
  });
});

describe("public publication state", () => {
  it("exposes only the published keys, slugs and hashes, with no original source IDs or bodies", () => {
    const rawId = "12345678-1234-1234-1234-123456789abc";
    const post = makePost("public-note", sourceKeyForNotionPage(rawId));
    const withdrawn = makePost("withdrawn-draft");
    const previous = snapshot([post, withdrawn]);
    const current = snapshot([post]);
    const before = createPublicationState(previous, identity(previous));
    const result = createPublicationState(current, identity(current));
    expect(result.posts).toEqual([
      { sourceKey: post.sourceKey, slug: post.slug, contentHash: hashPostContent(post) },
    ]);
    expect(before.posts).toHaveLength(2);
    const serialized = JSON.stringify(result);
    for (const privateValue of [rawId, "withdrawn-draft", withdrawn.sourceKey, post.title]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(PublicationStateSchema.parse(result)).toEqual(result);
  });

  it("pairs the state with the exact snapshot and rejects a different manifest identity", () => {
    const value = snapshot([makePost()]);
    expect(createPublicationState(value, identity(value)).identity).toEqual(identity(value));
    expect(() =>
      createPublicationState(value, { ...identity(value), contentHash: sha256("other snapshot") }),
    ).toThrow(/must describe the snapshot/);
  });

  it("produces a legal empty state and rejects duplicate entries or private fields", () => {
    const empty = snapshot();
    expect(createPublicationState(empty, identity(empty)).posts).toEqual([]);
    const value = snapshot([makePost()]);
    const state = createPublicationState(value, identity(value));
    expect(() =>
      PublicationStateSchema.parse({ ...state, posts: [...state.posts, ...state.posts] }),
    ).toThrow(/duplicate/);
    expect(() => PublicationStateSchema.parse({ ...state, token: "private" })).toThrow();
    expect(() =>
      PublicationStateSchema.parse({
        ...state,
        posts: state.posts.map((post) => ({ ...post, notionPageId: "private" })),
      }),
    ).toThrow();
  });

  it("reserves the JSON endpoint while allowing public content to link to it", () => {
    expect(() => validateSlug("publication-state")).toThrow(/reserved/);
    expect(() => validateLiteralRedirectSource("/publication-state.json")).toThrow(/shadows/);
    const post = makePost();
    post.blocks = [
      {
        id: "state-link",
        type: "paragraph",
        richText: [{ text: "Publication state", href: "/publication-state.json" }],
        children: [],
      },
    ];
    expect(() => validateContentSnapshot(snapshot([post]))).not.toThrow();
  });
});
