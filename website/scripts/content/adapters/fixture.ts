import { parseContentDate } from "../../../src/lib/content/date";
import { sha256 } from "../../../src/lib/content/hash";
import type { Post } from "../../../src/lib/content/schema";
import type { PreparedSource, SourceContext } from "../types";

const sourceKey = sha256("fixture:v1:reliable-content-pipelines");

export async function prepareFixtureSource(context: SourceContext): Promise<PreparedSource> {
  void context;
  const post: Post = {
    sourceKey,
    feedGuid: `urn:ziyixi:post:${sourceKey}`,
    slug: "reliable-content-pipelines",
    title: "Notes on reliable content pipelines",
    summary:
      "A synthetic article used to exercise headings, rich text, nested blocks, code, formulas, and tables.",
    language: "en",
    translationKey: "fixture-content-pipelines",
    publishedAt: parseContentDate("2025-02-03"),
    tags: ["systems", "publishing"],
    blocks: [
      {
        id: "fixture-intro",
        type: "paragraph",
        richText: [
          { text: "A build should consume one validated snapshot, " },
          { text: "not a changing remote API", bold: true },
          { text: "." },
        ],
        children: [],
      },
      {
        id: "fixture-toc-marker",
        type: "tableOfContents",
      },
      {
        id: "fixture-boundaries",
        type: "heading",
        level: 2,
        anchor: "explicit-boundaries",
        richText: [{ text: "Explicit boundaries" }],
      },
      {
        id: "fixture-list",
        type: "listItem",
        style: "bulleted",
        richText: [{ text: "Fetch, normalize, then validate." }],
        children: [
          {
            id: "fixture-nested-list",
            type: "listItem",
            style: "bulleted",
            richText: [{ text: "The renderer only reads local data." }],
            children: [],
          },
        ],
      },
      {
        id: "fixture-code",
        type: "code",
        code: "const stable = hash(snapshot);",
        language: "typescript",
        caption: [{ text: "Stable input, stable identity." }],
        highlighted: true,
      },
      {
        id: "fixture-equation",
        type: "equation",
        expression: "H = SHA256(C)",
      },
      {
        id: "fixture-table",
        type: "table",
        hasColumnHeader: true,
        hasRowHeader: false,
        rows: [
          [[{ text: "Mode" }], [{ text: "Network" }]],
          [[{ text: "empty" }], [{ text: "never" }]],
          [[{ text: "notion" }], [{ text: "sync only" }]],
        ],
      },
      {
        id: "fixture-columns",
        type: "columns",
        columns: [
          {
            id: "fixture-first-column",
            widthRatio: 0.4,
            children: [
              {
                id: "fixture-checked-task",
                type: "toDo",
                checked: true,
                richText: [{ text: "Verify the snapshot" }],
                children: [],
              },
            ],
          },
          {
            id: "fixture-second-column",
            widthRatio: 0.6,
            children: [
              {
                id: "fixture-unchecked-task",
                type: "toDo",
                checked: false,
                richText: [{ text: "Publish after review" }],
                children: [],
              },
            ],
          },
        ],
      },
      {
        id: "fixture-toggle-heading",
        type: "heading",
        level: 2,
        anchor: "optional-details",
        richText: [{ text: "Optional details" }],
        toggleable: true,
        children: [
          {
            id: "fixture-nested-heading",
            type: "heading",
            level: 3,
            anchor: "nested-section",
            richText: [{ text: "Nested section" }],
          },
          {
            id: "fixture-nested-paragraph",
            type: "paragraph",
            richText: [{ text: "This section remains visible on initial navigation." }],
            children: [],
          },
        ],
      },
      {
        id: "fixture-toggle",
        type: "toggle",
        richText: [{ text: "Why a manifest?" }],
        children: [
          {
            id: "fixture-toggle-answer",
            type: "paragraph",
            richText: [{ text: "It proves the snapshot completed and records its hash." }],
            children: [],
          },
        ],
      },
      {
        id: "fixture-callout",
        type: "callout",
        icon: "i",
        richText: [{ text: "This article is synthetic and never production content." }],
        children: [],
      },
      {
        id: "fixture-link",
        type: "bookmark",
        href: "https://developers.notion.com/",
        caption: [
          {
            text: "Notion developer documentation",
            href: "https://example.com/caption",
          },
        ],
      },
    ],
    toc: [
      { id: "explicit-boundaries", text: "Explicit boundaries", level: 2 },
      { id: "optional-details", text: "Optional details", level: 2 },
      { id: "nested-section", text: "Nested section", level: 3 },
    ],
    media: [],
  };

  const chineseSourceKey = sha256("fixture:v1:reliable-content-pipelines:zh-CN");
  const chinesePost: Post = {
    ...post,
    sourceKey: chineseSourceKey,
    feedGuid: `urn:ziyixi:post:${chineseSourceKey}`,
    slug: "reliable-content-pipelines-zh",
    title: "可靠内容流水线笔记",
    summary: "用于测试双语切换的合成文章，演示本地快照、代码和表格。",
    language: "zh-CN",
    blocks: [
      {
        id: "fixture-zh-intro",
        type: "paragraph",
        richText: [
          { text: "构建应读取一份已经校验的本地快照，避免在读者访问时依赖远程内容接口。" },
        ],
        children: [],
      },
      {
        id: "fixture-zh-boundaries",
        type: "heading",
        level: 2,
        anchor: "explicit-boundaries",
        richText: [{ text: "明确内容边界" }],
      },
      ...post.blocks.filter((block) => block.type === "code" || block.type === "table"),
      {
        id: "fixture-zh-disclaimer",
        type: "paragraph",
        richText: [{ text: "本文仅用于测试，不会作为真实文章发布。" }],
        children: [],
      },
    ],
    toc: [{ id: "explicit-boundaries", text: "明确内容边界", level: 2 }],
  };

  return {
    posts: [post, chinesePost],
    media: [],
    diagnostics: { draftCount: 0, futureCount: 0, warnings: [] },
  };
}
