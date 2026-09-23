import { describe, expect, it } from "vitest";

import {
  collectPublicPages,
  refreshNotionImageUrl,
  refreshNotionMediaUrl,
  validateDataSourceSchema,
} from "../../scripts/content/adapters/notion";
import { convertNotionBlocks, convertRichText } from "../../scripts/content/notion/convert";
import type { NotionBlockNode, NotionClientLike } from "../../scripts/content/notion/types";
import notionBlocks from "../fixtures/notion-blocks.json";
import notionPages from "../fixtures/notion-pages.json";

const propertyTypes = {
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

function blockId(index: number): string {
  return index.toString(16).padStart(32, "0");
}

function textSpan(content: string): Record<string, unknown> {
  return {
    type: "text",
    text: { content },
    plain_text: content,
    annotations: {},
  };
}

function headingNode(index: number, spans: string[]): NotionBlockNode {
  return {
    block: {
      id: blockId(index),
      type: "heading_1",
      heading_1: {
        rich_text: spans.map(textSpan),
        is_toggleable: false,
      },
      has_children: false,
    },
    children: [],
  };
}

function bookmarkNode(index: number, url: string): NotionBlockNode {
  return {
    block: {
      id: blockId(index),
      type: "bookmark",
      bookmark: { url, caption: [] },
      has_children: false,
    },
    children: [],
  };
}

function notionNode(
  index: number,
  type: string,
  payload: Record<string, unknown>,
  children: NotionBlockNode[] = [],
): NotionBlockNode {
  return {
    block: {
      id: blockId(index),
      type,
      [type]: payload,
      has_children: children.length > 0,
    },
    children,
  };
}

describe("Notion metadata boundary", () => {
  it("separates drafts, future posts, and the current public set", () => {
    const result = collectPublicPages(
      notionPages.results,
      undefined,
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(result.pages.map((page) => page.slug)).toEqual(["public-note"]);
    expect(result.draftCount).toBe(1);
    expect(result.futureCount).toBe(1);
  });

  it("fails when the data source schema drifts", () => {
    expect(() => validateDataSourceSchema(propertyTypes)).not.toThrow();
    expect(() =>
      validateDataSourceSchema({
        ...propertyTypes,
        properties: { ...propertyTypes.properties, Slug: { type: "url" } },
      }),
    ).toThrow(/must have type rich_text/);
  });

  it("refreshes an expired file URL by retrieving the image block again", async () => {
    const client = {
      blocks: {
        retrieve: async ({ block_id }: { block_id: string }) => ({
          id: block_id,
          type: "image",
          image: {
            type: "file",
            file: { url: "https://secure.notion-static.com/refreshed.png" },
          },
        }),
      },
    } as unknown as NotionClientLike;

    await expect(refreshNotionImageUrl(client, "image-block")).resolves.toBe(
      "https://secure.notion-static.com/refreshed.png",
    );
  });

  it("fails closed when a media refresh no longer returns an image", async () => {
    const client = {
      blocks: {
        retrieve: async () => ({ type: "paragraph", paragraph: {} }),
      },
    } as unknown as NotionClientLike;

    await expect(refreshNotionImageUrl(client, "former-image")).rejects.toMatchObject({
      code: "NOTION_MEDIA_REFRESH_FAILED",
    });
  });

  it("refreshes an uploaded PDF only if the block still has the expected type", async () => {
    const client = {
      blocks: {
        retrieve: async () => ({
          type: "pdf",
          pdf: { type: "file", file: { url: "https://file.notion.so/refreshed.pdf" } },
        }),
      },
    } as unknown as NotionClientLike;
    await expect(refreshNotionMediaUrl(client, "pdf-block", "pdf")).resolves.toBe(
      "https://file.notion.so/refreshed.pdf",
    );
    await expect(refreshNotionMediaUrl(client, "pdf-block", "audio")).rejects.toMatchObject({
      code: "NOTION_MEDIA_REFRESH_FAILED",
    });
  });
});

describe("finite Notion block conversion", () => {
  it("preserves Notion tasks, column order and width, and toggleable heading hierarchy", async () => {
    const paragraph = notionNode(204, "paragraph", { rich_text: [textSpan("Column text")] });
    const columns = notionNode(200, "column_list", {}, [
      notionNode(201, "column", { width_ratio: 0.35 }, [
        notionNode(202, "to_do", { checked: true, rich_text: [textSpan("Reviewed")] }),
      ]),
      notionNode(203, "column", { width_ratio: 0.65 }, [paragraph]),
    ]);
    const toggleHeading = notionNode(
      205,
      "heading_1",
      { rich_text: [textSpan("Expandable")], is_toggleable: true },
      [headingNode(206, ["Nested"])],
    );
    const converted = await convertNotionBlocks([columns, toggleHeading], {
      publicPageSlugs: new Map(),
      warnings: [],
    });

    expect(converted.blocks).toMatchObject([
      {
        type: "columns",
        columns: [
          { widthRatio: 0.35, children: [{ type: "toDo", checked: true }] },
          { widthRatio: 0.65, children: [{ type: "paragraph" }] },
        ],
      },
      {
        type: "heading",
        toggleable: true,
        children: [{ type: "heading", richText: [{ text: "Nested" }] }],
      },
    ]);
    expect(converted.toc.map((entry) => entry.text)).toEqual(["Expandable", "Nested"]);
  });

  it("places a single Notion table of contents marker in the article and keeps links safe", async () => {
    const publicPageId = "11111111111111111111111111111111";
    const converted = await convertNotionBlocks(
      [
        headingNode(210, ["Before"]),
        notionNode(211, "table_of_contents", {}),
        notionNode(212, "link_preview", {
          url: `https://www.notion.so/Public-${publicPageId}`,
        }),
        headingNode(213, ["After"]),
      ],
      {
        publicPageSlugs: new Map([[publicPageId, "public-note"]]),
        warnings: [],
      },
    );

    expect(converted.blocks.map((block) => block.type)).toEqual([
      "heading",
      "tableOfContents",
      "bookmark",
      "heading",
    ]);
    expect(converted.blocks[2]).toMatchObject({ href: "/blog/public-note", caption: [] });
    expect(converted.toc.map((entry) => entry.text)).toEqual(["Before", "After"]);
  });

  it("rejects unsafe previews, malformed columns, and misplaced or repeated TOC markers", async () => {
    const context = { publicPageSlugs: new Map(), warnings: [] };
    await expect(
      convertNotionBlocks(
        [notionNode(220, "link_preview", { url: "javascript:alert(1)" })],
        context,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_NOTION_BLOCK" });
    await expect(
      convertNotionBlocks(
        [notionNode(221, "column_list", {}, [notionNode(222, "paragraph", { rich_text: [] })])],
        context,
      ),
    ).rejects.toThrow(/non-column/);
    await expect(
      convertNotionBlocks(
        [notionNode(223, "column_list", {}, [notionNode(224, "column", { width_ratio: -1 })])],
        context,
      ),
    ).rejects.toThrow(/width ratio is invalid/);
    await expect(
      convertNotionBlocks(
        [
          notionNode(225, "paragraph", { rich_text: [] }, [
            notionNode(226, "table_of_contents", {}),
          ]),
        ],
        context,
      ),
    ).rejects.toThrow(/top-level table of contents/);
    await expect(
      convertNotionBlocks(
        [notionNode(227, "table_of_contents", {}), notionNode(228, "table_of_contents", {})],
        context,
      ),
    ).rejects.toThrow(/top-level table of contents/);
  });
  it("preserves an HTTP auto-linked filename and an HTTP bookmark", async () => {
    const href = "http://hello.cu/";
    const converted = await convertNotionBlocks(
      [
        {
          block: {
            id: blockId(90),
            type: "paragraph",
            paragraph: {
              rich_text: [
                {
                  ...textSpan("hello.cu"),
                  href,
                  text: { content: "hello.cu", link: { url: href } },
                },
              ],
            },
            has_children: false,
          },
          children: [],
        },
        bookmarkNode(91, "http://example.com/paper?version=1#results"),
      ],
      { publicPageSlugs: new Map(), warnings: [] },
    );

    expect(converted.blocks).toMatchObject([
      { type: "paragraph", richText: [{ text: "hello.cu", href }] },
      { type: "bookmark", href: "http://example.com/paper?version=1#results" },
    ]);
  });

  it("creates stable duplicate heading anchors and preserves unknown code as text", async () => {
    const warnings: string[] = [];
    const converted = await convertNotionBlocks(notionBlocks as NotionBlockNode[], {
      publicPageSlugs: new Map(),
      warnings,
    });
    expect(converted.toc.map((entry) => entry.id)).toEqual(["boundary", "boundary-2"]);
    expect(converted.blocks[2]).toMatchObject({
      type: "code",
      code: "literal <script>",
      highlighted: false,
    });
    expect(warnings[0]).toMatch(/unknown code language/);
  });

  it("rewrites a public page mention and blocks a private page mention", () => {
    const target = "11111111111111111111111111111111";
    const richText = [
      {
        type: "mention",
        plain_text: "Public note",
        mention: { type: "page", page: { id: target } },
        annotations: {},
      },
    ];
    expect(
      convertRichText(richText, {
        publicPageSlugs: new Map([[target, "public-note"]]),
        warnings: [],
      })[0]?.href,
    ).toBe("/blog/public-note");
    expect(() => convertRichText(richText, { publicPageSlugs: new Map(), warnings: [] })).toThrow(
      /outside the public article set/,
    );
  });

  it.each(["http", "https"])(
    "rewrites a public %s Notion bookmark through the public article map",
    async (protocol) => {
      const target = "11111111111111111111111111111111";
      const converted = await convertNotionBlocks(
        [bookmarkNode(10, `${protocol}://www.notion.so/Public-note-${target}`)],
        {
          publicPageSlugs: new Map([[target, "public-note"]]),
          warnings: [],
        },
      );

      expect(converted.blocks).toMatchObject([{ type: "bookmark", href: "/blog/public-note" }]);
    },
  );

  it.each(["http", "https"])(
    "rejects an %s bookmark to a Notion page outside the public article map",
    async (protocol) => {
      await expect(
        convertNotionBlocks(
          [
            bookmarkNode(
              11,
              `${protocol}://www.notion.so/Private-page-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
            ),
          ],
          { publicPageSlugs: new Map(), warnings: [] },
        ),
      ).rejects.toMatchObject({ code: "PRIVATE_NOTION_LINK" });
    },
  );

  it("rejects an unresolved fragment on a public Notion bookmark", async () => {
    const target = "11111111111111111111111111111111";
    await expect(
      convertNotionBlocks(
        [bookmarkNode(12, `https://www.notion.so/Public-note-${target}#private-block`)],
        {
          publicPageSlugs: new Map([[target, "public-note"]]),
          warnings: [],
        },
      ),
    ).rejects.toMatchObject({ code: "UNRESOLVED_NOTION_FRAGMENT" });
  });

  it("allocates unique anchors across duplicate, numeric, normalized, and reserved names", async () => {
    const converted = await convertNotionBlocks(
      [
        headingNode(20, ["Setup"]),
        headingNode(21, ["Setup"]),
        headingNode(22, ["Setup 2"]),
        headingNode(23, ["A+B"]),
        headingNode(24, ["A / B"]),
        headingNode(25, ["Main content"]),
      ],
      { publicPageSlugs: new Map(), warnings: [] },
    );

    expect(converted.toc.map((entry) => entry.id)).toEqual([
      "setup",
      "setup-2",
      "setup-2-2",
      "a-b",
      "a-b-2",
      "main-content-2",
    ]);
    expect(new Set(converted.toc.map((entry) => entry.id)).size).toBe(converted.toc.length);
  });

  it("normalizes heading boundary whitespace without changing its rich-text spans", async () => {
    const converted = await convertNotionBlocks([headingNode(30, ["  Setup", " guide  "])], {
      publicPageSlugs: new Map(),
      warnings: [],
    });

    expect(converted.toc).toEqual([{ id: "setup-guide", text: "Setup guide", level: 2 }]);
    expect(converted.blocks[0]).toMatchObject({
      type: "heading",
      richText: [{ text: "  Setup" }, { text: " guide  " }],
    });
  });

  it("rejects a heading whose spans contain only whitespace", async () => {
    await expect(
      convertNotionBlocks([headingNode(31, [" ", "\t\n"])], {
        publicPageSlugs: new Map(),
        warnings: [],
      }),
    ).rejects.toThrow(/heading text is empty/);
  });

  it("rejects Notion section links whose block fragment cannot be proven public", () => {
    const target = "11111111111111111111111111111111";
    const richText = [
      {
        type: "text",
        text: {
          content: "Unresolved section",
          link: { url: `https://www.notion.so/Public-${target}#private-block` },
        },
        annotations: {},
      },
    ];
    expect(() =>
      convertRichText(richText, {
        publicPageSlugs: new Map([[target, "public-note"]]),
        warnings: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "UNRESOLVED_NOTION_FRAGMENT" }));
  });

  it("preserves external media and embeds without fetching arbitrary hosts", async () => {
    const converted = await convertNotionBlocks(
      [
        {
          block: {
            id: blockId(80),
            type: "video",
            video: {
              type: "external",
              external: { url: "https://youtu.be/dQw4w9WgXcQ" },
              caption: [],
            },
          },
          children: [],
        },
        {
          block: {
            id: blockId(81),
            type: "embed",
            embed: { url: "https://example.com/widget" },
          },
          children: [],
        },
      ],
      { publicPageSlugs: new Map(), warnings: [] },
    );
    expect(converted.blocks).toMatchObject([
      {
        type: "mediaFile",
        kind: "video",
        source: { type: "external", href: "https://youtu.be/dQw4w9WgXcQ" },
      },
      { type: "embed", href: "https://example.com/widget" },
    ]);
    expect(converted.media).toEqual([]);
  });

  it("copies signed Notion file and embed media into the public snapshot", async () => {
    const audioDigest = "a".repeat(64);
    const pdfDigest = "b".repeat(64);
    const resolveFile = async (file: { kind: string; url: string }) =>
      file.kind === "embed"
        ? {
            kind: "pdf" as const,
            asset: {
              path: `/media/${pdfDigest}.pdf`,
              sha256: pdfDigest,
              mimeType: "application/pdf",
              sizeBytes: 7,
            },
          }
        : {
            kind: "audio" as const,
            asset: {
              path: `/media/${audioDigest}.mp3`,
              sha256: audioDigest,
              mimeType: "audio/mpeg",
              sizeBytes: 7,
            },
          };
    const converted = await convertNotionBlocks(
      [
        {
          block: {
            id: blockId(82),
            type: "audio",
            audio: { type: "file", file: { url: "https://file.notion.so/audio" }, caption: [] },
          },
          children: [],
        },
        {
          block: {
            id: blockId(83),
            type: "embed",
            embed: { url: "https://file.notion.so/uploaded.pdf" },
          },
          children: [],
        },
      ],
      {
        publicPageSlugs: new Map(),
        warnings: [],
        resolveFile,
        isManagedMediaUrl: (url) => new URL(url).hostname === "file.notion.so",
      },
    );
    expect(converted.blocks).toMatchObject([
      {
        type: "mediaFile",
        kind: "audio",
        source: { type: "local", mediaPath: `/media/${audioDigest}.mp3` },
      },
      {
        type: "mediaFile",
        kind: "pdf",
        source: { type: "local", mediaPath: `/media/${pdfDigest}.pdf` },
      },
    ]);
    expect(converted.media).toHaveLength(2);
  });

  it("rejects unsafe external media URLs", async () => {
    await expect(
      convertNotionBlocks(
        [
          {
            block: { id: blockId(84), type: "embed", embed: { url: "http://example.com/widget" } },
            children: [],
          },
        ],
        { publicPageSlugs: new Map(), warnings: [] },
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_MEDIA_URL" });
  });

  it("never publishes a temporary Notion embed URL without a downloader", async () => {
    await expect(
      convertNotionBlocks(
        [
          {
            block: {
              id: blockId(85),
              type: "embed",
              embed: { url: "https://file.notion.so/temporary" },
            },
            children: [],
          },
        ],
        { publicPageSlugs: new Map(), warnings: [] },
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_NOTION_BLOCK" });
  });

  it("fails closed on an unsupported block", async () => {
    await expect(
      convertNotionBlocks(
        [
          {
            block: {
              id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
              type: "unsupported",
              unsupported: { block_type: "button" },
              has_children: false,
            },
            children: [],
          },
        ],
        { publicPageSlugs: new Map(), warnings: [] },
      ),
    ).rejects.toThrow(/Unsupported Notion block unsupported/);
  });

  it("validates block equations with the renderer's strict KaTeX policy", async () => {
    const equationNode = (expression: string): NotionBlockNode => ({
      block: {
        id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
        type: "equation",
        equation: { expression },
        has_children: false,
      },
      children: [],
    });

    await expect(
      convertNotionBlocks([equationNode(String.raw`\frac{a}{b}`)], {
        publicPageSlugs: new Map(),
        warnings: [],
      }),
    ).resolves.toMatchObject({
      blocks: [{ type: "equation", expression: String.raw`\frac{a}{b}` }],
    });
    await expect(
      convertNotionBlocks([equationNode(String.raw`\frac{a}{`)], {
        publicPageSlugs: new Map(),
        warnings: [],
      }),
    ).rejects.toMatchObject({ code: "INVALID_EQUATION" });
  });

  it("validates inline equations before they reach the renderer", () => {
    const equation = (expression: string) => [
      {
        type: "equation",
        equation: { expression },
        annotations: {},
      },
    ];
    const context = { publicPageSlugs: new Map<string, string>(), warnings: [] };

    expect(convertRichText(equation(String.raw`E = mc^2`), context)).toMatchObject([
      { text: String.raw`E = mc^2`, equation: true },
    ]);
    expect(() => convertRichText(equation(String.raw`\sqrt{`), context)).toThrowError(
      expect.objectContaining({ code: "INVALID_EQUATION" }),
    );
  });
});
