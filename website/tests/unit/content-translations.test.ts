import { describe, expect, it, vi } from "vitest";

import {
  collectPublicPages,
  prepareNotionSource,
  validateDataSourceSchema,
} from "../../scripts/content/adapters/notion";
import type { NotionClientLike } from "../../scripts/content/notion/types";
import { comparePostsNewestFirst } from "../../src/lib/content/date";
import { hashContentSnapshot, sha256 } from "../../src/lib/content/hash";
import { buildCandidateRegistry } from "../../src/lib/content/registry";
import { PostSchema, type ContentSnapshot, type Post } from "../../src/lib/content/schema";
import { getPostTranslations, groupPostsByTranslation } from "../../src/lib/content/translations";
import { validateContentSnapshot } from "../../src/lib/content/validate";

function post(slug: string, language: Post["language"], translationKey?: string): Post {
  const sourceKey = sha256(slug);
  return {
    sourceKey,
    feedGuid: `urn:ziyixi:post:${sourceKey}`,
    slug,
    title: slug,
    summary: `Summary for ${slug}`,
    language,
    ...(translationKey ? { translationKey } : {}),
    publishedAt: "2025-01-01T00:00:00.000Z",
    tags: [],
    blocks: [],
    toc: [],
    media: [],
  };
}

function snapshot(posts: Post[]): ContentSnapshot {
  return {
    schemaVersion: 1,
    sourceMode: "fixture",
    posts: [...posts].sort(comparePostsNewestFirst),
    media: [],
    redirects: [],
  };
}

const propertyNames = {
  title: "Title",
  slug: "Slug",
  status: "Status",
  publishedAt: "PublishedAt",
  summary: "Summary",
  language: "Language",
  tags: "Tags",
};

const notionSchema = {
  properties: {
    Title: { type: "title" },
    Slug: { type: "rich_text" },
    Status: { type: "status" },
    PublishedAt: { type: "date" },
    Summary: { type: "rich_text" },
    Language: { type: "select" },
    Tags: { type: "multi_select" },
  },
};

function notionPage(index: number, value: Post, status = "Published") {
  const richText = (text: string) => ({ type: "rich_text", rich_text: [{ plain_text: text }] });
  return {
    id: index.toString(16).padStart(32, "0"),
    last_edited_time: "2025-02-01T00:00:00.000Z",
    properties: {
      Title: { type: "title", title: [{ plain_text: value.title }] },
      Slug: richText(value.slug),
      Summary: richText(value.summary),
      Status: { type: "status", status: { name: status } },
      PublishedAt: { type: "date", date: { start: value.publishedAt } },
      Language: { type: "select", select: { name: value.language } },
      Tags: { type: "multi_select", multi_select: [] },
      ...(value.translationKey !== undefined
        ? { TranslationKey: richText(value.translationKey) }
        : {}),
    },
  };
}

describe("translation groups", () => {
  it("keeps old snapshots compatible and hashes an explicitly added translation relationship", () => {
    const original = post("standalone", "en");
    expect(PostSchema.parse(original)).not.toHaveProperty("translationKey");
    expect(hashContentSnapshot(snapshot([original]))).not.toBe(
      hashContentSnapshot(snapshot([{ ...original, translationKey: "same-article" }])),
    );
    expect(PostSchema.parse({ ...original, translationKey: "  一篇文章  " }).translationKey).toBe(
      "一篇文章",
    );
  });

  it("groups before a home-page limit and preserves the first publication date", () => {
    const english = post("paired-en", "en", "pair");
    const chinese = {
      ...post("paired-zh", "zh-CN", "pair"),
      publishedAt: "2026-09-01T00:00:00.000Z",
    };
    const recent = { ...post("newer-original", "en"), publishedAt: "2026-01-01T00:00:00.000Z" };
    const third = post("third", "zh-CN");
    const fourth = { ...post("fourth", "en"), publishedAt: "2024-01-01T00:00:00.000Z" };
    const input = [chinese, third, fourth, recent, english];
    const groups = groupPostsByTranslation(input);

    expect(groups).toHaveLength(4);
    expect(groups.slice(0, 3).flatMap((group) => group.translations)).toHaveLength(4);
    expect(groups[0]?.primary.slug).toBe("newer-original");
    const pair = groups.find((group) => group.id === "translation:pair");
    expect(pair).toMatchObject({ primary: english, publishedAt: english.publishedAt });
    expect(pair?.translations.map((value) => value.language)).toEqual(["en", "zh-CN"]);
    expect(
      groupPostsByTranslation(input, "zh-CN").find((group) => group.id === pair?.id)?.primary,
    ).toBe(chinese);
    expect(groupPostsByTranslation([...input].reverse())).toEqual(groups);
    expect(input).toEqual([chinese, third, fourth, recent, english]);
  });

  it("does not infer pairs from titles, slugs, or keys that happen to equal another source key", () => {
    const first = post("name-en", "en");
    const second = { ...post("name-zh", "zh-CN"), title: first.title };
    const keyed = post("keyed", "en", first.sourceKey);
    expect(groupPostsByTranslation([first, second, keyed])).toHaveLength(3);
    expect(getPostTranslations([first, second, keyed], first)).toEqual([first]);
  });

  it("uses only supplied public versions for language switching, including a one-language group", () => {
    const english = post("paired-en", "en", "pair");
    const chinese = post("paired-zh", "zh-CN", "pair");
    const unrelated = post("other", "zh-CN", "other");
    expect(getPostTranslations([chinese, unrelated, english], chinese)).toEqual([english, chinese]);
    expect(getPostTranslations([english, unrelated], english)).toEqual([english]);
    expect(groupPostsByTranslation([chinese])[0]?.primary).toBe(chinese);
  });

  it("rejects ambiguous same-language pairs at the normalized snapshot boundary", () => {
    const first = post("first", "en", "pair");
    const second = post("second", "en", "pair");
    expect(() => validateContentSnapshot(snapshot([first, second]))).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_TRANSLATION_LANGUAGE" }),
    );
    expect(() =>
      validateContentSnapshot(snapshot([first, { ...second, language: "zh-CN" }])),
    ).not.toThrow();
  });

  it("keeps each translation's registry and feed identity when pairing or renaming", () => {
    const english = post("paired-en", "en");
    const chinese = post("paired-zh", "zh-CN");
    const baseline = buildCandidateRegistry([english, chinese]).registry;
    const paired = [
      { ...english, translationKey: "pair" },
      { ...chinese, translationKey: "pair", slug: "renamed-zh" },
    ];
    const candidate = buildCandidateRegistry(paired, baseline);
    expect(candidate.registry.articleCount).toBe(2);
    expect(candidate.registry.posts.map((entry) => entry.feedGuid).sort()).toEqual(
      [english.feedGuid, chinese.feedGuid].sort(),
    );
    expect(candidate.redirects).toEqual([
      {
        from: "/blog/paired-zh",
        to: "/blog/renamed-zh",
        status: 308,
        sourceKey: chinese.sourceKey,
      },
    ]);
  });
});

describe("Notion translation metadata", () => {
  it("permits absent or empty TranslationKey columns while checking the optional column type", () => {
    expect(() => validateDataSourceSchema(notionSchema)).not.toThrow();
    expect(() =>
      validateDataSourceSchema({
        properties: { ...notionSchema.properties, TranslationKey: { type: "rich_text" } },
      }),
    ).not.toThrow();
    expect(() =>
      validateDataSourceSchema({
        properties: { ...notionSchema.properties, TranslationKey: { type: "select" } },
      }),
    ).toThrow(/TranslationKey must have type rich_text/);

    const missing = notionPage(1, post("missing-key", "en"));
    const empty = notionPage(2, { ...post("empty-key", "zh-CN"), translationKey: "   " });
    const result = collectPublicPages([missing, empty]);
    expect(result.pages).toHaveLength(2);
    for (const page of result.pages) expect(page).not.toHaveProperty("translationKey");
  });

  it("supports a renamed optional property and trims its value", () => {
    const names = { ...propertyNames, translationKey: "Translations" };
    expect(() =>
      validateDataSourceSchema(
        {
          properties: { ...notionSchema.properties, Translations: { type: "rich_text" } },
        },
        names,
      ),
    ).not.toThrow();
    const page = notionPage(1, post("renamed-key", "en"));
    const result = collectPublicPages(
      [
        {
          ...page,
          properties: {
            ...page.properties,
            Translations: { type: "rich_text", rich_text: [{ plain_text: " 一篇文章 " }] },
          },
        },
      ],
      names,
    );
    expect(result.pages[0]?.translationKey).toBe("一篇文章");
  });

  it("excludes draft and future variants before checking translation-language collisions", () => {
    const english = post("paired-en", "en", "pair");
    const chinese = post("paired-zh", "zh-CN", "pair");
    const duplicate = post("unpublished-duplicate", "en", "pair");
    const rows = [
      notionPage(1, english),
      notionPage(2, chinese),
      notionPage(3, duplicate, "Draft"),
      notionPage(4, {
        ...duplicate,
        slug: "future-duplicate",
        publishedAt: "2099-01-01T00:00:00.000Z",
      }),
    ];
    const result = collectPublicPages(rows, undefined, new Date("2026-01-01T00:00:00Z"));
    expect(result.pages.map((page) => page.slug)).toEqual(["paired-en", "paired-zh"]);
    expect(result).toMatchObject({ draftCount: 1, futureCount: 1 });
    expect(() =>
      collectPublicPages([notionPage(1, english), notionPage(3, duplicate)]),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_TRANSLATION_LANGUAGE" }));
  });

  it("retries a sync when only the translation relationship changes during collection", async () => {
    const before = notionPage(1, post("moving-key", "en", "before"));
    const after = notionPage(1, post("moving-key", "en", "after"));
    const query = vi
      .fn()
      .mockResolvedValueOnce({ results: [before], has_more: false, next_cursor: null })
      .mockResolvedValue({ results: [after], has_more: false, next_cursor: null });
    const client: NotionClientLike = {
      dataSources: {
        retrieve: async () => ({
          properties: { ...notionSchema.properties, TranslationKey: { type: "rich_text" } },
        }),
        query,
      },
      blocks: {
        children: { list: async () => ({ results: [], has_more: false, next_cursor: null }) },
      },
    };
    const prepared = await prepareNotionSource(
      { cutoff: new Date("2026-01-01T00:00:00Z"), publicDirectory: "unused-no-images" },
      { token: "test", dataSourceId: "test", apiVersion: "2026-03-11", client },
    );
    expect(query).toHaveBeenCalledTimes(4);
    expect(prepared.posts[0]?.translationKey).toBe("after");
  });
});
