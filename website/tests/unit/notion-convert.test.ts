import { describe, expect, it } from "vitest";

import {
  collectPublicPages,
  refreshNotionImageUrl,
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
});

describe("finite Notion block conversion", () => {
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

  it("fails closed on an unsupported block", async () => {
    await expect(
      convertNotionBlocks(
        [
          {
            block: {
              id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
              type: "embed",
              embed: { url: "https://example.com" },
              has_children: false,
            },
            children: [],
          },
        ],
        { publicPageSlugs: new Map(), warnings: [] },
      ),
    ).rejects.toThrow(/Unsupported Notion block embed/);
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
