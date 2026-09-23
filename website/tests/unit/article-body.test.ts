import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ArticleBody } from "../../src/components/ArticleBody";
import type { ContentBlock, RichTextSpan, TableBlock } from "../../src/lib/content";

function renderBlocks(blocks: ContentBlock[]): string {
  return renderToStaticMarkup(createElement(ArticleBody, { blocks }));
}

function cell(text: string): RichTextSpan[] {
  return [{ text }];
}

function table(hasColumnHeader: boolean, hasRowHeader: boolean, id: string): TableBlock {
  return {
    id,
    type: "table",
    hasColumnHeader,
    hasRowHeader,
    rows: [
      [cell("Mass"), cell("Value")],
      [cell("Speed"), cell("3m/s")],
    ],
  };
}

describe("article body markup", () => {
  it("renders a Notion table of contents once at its chosen position", () => {
    const html = renderToStaticMarkup(
      createElement(ArticleBody, {
        language: "en",
        toc: [{ id: "before", text: "Before", level: 2 }],
        blocks: [
          {
            id: "before-block",
            type: "heading",
            level: 2,
            anchor: "before",
            richText: [{ text: "Before" }],
          },
          { id: "toc-block", type: "tableOfContents" },
          { id: "after-block", type: "paragraph", richText: [{ text: "After" }], children: [] },
        ],
      }),
    );

    expect(html.match(/On this page/g)).toHaveLength(1);
    expect(html.indexOf('id="before"')).toBeLessThan(html.indexOf("On this page"));
    expect(html.indexOf("On this page")).toBeLessThan(html.indexOf("After"));
    expect(html).toContain('href="#before"');
  });

  it("renders read-only tasks and responsive columns without losing nested content", () => {
    const html = renderBlocks([
      {
        id: "two-columns",
        type: "columns",
        columns: [
          {
            id: "first-column",
            widthRatio: 0.4,
            children: [
              {
                id: "reviewed",
                type: "toDo",
                checked: true,
                richText: [{ text: "Reviewed" }],
                children: [],
              },
            ],
          },
          {
            id: "second-column",
            widthRatio: 0.6,
            children: [
              {
                id: "draft",
                type: "toDo",
                checked: false,
                richText: [{ text: "Draft" }],
                children: [],
              },
            ],
          },
        ],
      },
    ]);

    expect(html).toContain("--column-template:0.4fr 0.6fr");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('aria-label="Reviewed"');
    expect(html).toContain('aria-label="Draft"');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain("Reviewed");
    expect(html).toContain("Draft");
  });

  it("keeps a toggleable heading as an anchored heading inside disclosure markup", () => {
    const html = renderBlocks([
      {
        id: "expandable",
        type: "heading",
        level: 2,
        anchor: "expandable-heading",
        richText: [{ text: "Expandable heading" }],
        toggleable: true,
        children: [
          { id: "inside", type: "paragraph", richText: [{ text: "Inside text" }], children: [] },
        ],
      },
    ]);

    expect(html).toMatch(/<details[^>]*open=""[^>]*><summary><h2 id="expandable-heading">/);
    expect(html).toContain("Inside text");
  });
  it("makes article images expandable while keeping their captions in the article", () => {
    const html = renderBlocks([
      {
        id: "figure-1",
        type: "image",
        mediaPath: "/media/example.png",
        sha256: "example",
        width: 1200,
        height: 600,
        alt: "A diagram",
        caption: [{ text: "Figure 1: the diagram" }],
      },
    ]);

    expect(html).toContain('aria-label="Enlarge image: A diagram"');
    expect(html).toContain('href="/media/example.png"');
    expect(html).toContain('style="width:min(100%, 1200px)"');
    expect(html).toContain('alt="A diagram"');
    expect(html).toContain('width="1200" height="600"');
    expect(html).toContain("<figcaption><span>Figure 1: the diagram</span></figcaption>");
  });

  it("renders a linked bookmark caption without nested anchors", () => {
    const html = renderBlocks([
      {
        id: "linked-bookmark",
        type: "bookmark",
        href: "https://example.com/bookmarked",
        caption: [{ text: "Linked caption", href: "https://example.com/caption" }],
      },
    ]);

    expect(html).toContain(
      '<a href="https://example.com/bookmarked"><span>Linked caption</span></a>',
    );
    expect(html).not.toContain('href="https://example.com/caption"');
    expect(html.match(/<a\b/g)).toHaveLength(1);
  });

  it("renders local audio playback and a PDF opening link", () => {
    const html = renderBlocks([
      {
        id: "audio-clip",
        type: "mediaFile",
        kind: "audio",
        name: "Interview.mp3",
        caption: [],
        source: { type: "local", mediaPath: "/media/audio.mp3", sha256: "audio" },
      },
      {
        id: "pdf-attachment",
        type: "mediaFile",
        kind: "pdf",
        name: "Paper.pdf",
        caption: [],
        source: { type: "local", mediaPath: "/media/paper.pdf", sha256: "paper" },
      },
    ]);

    expect(html).toContain('<audio controls="" preload="none" src="/media/audio.mp3">');
    expect(html).toContain('href="/media/paper.pdf"');
    expect(html).toContain("Open PDF: Paper.pdf");
    expect(html).not.toContain('<iframe src="/media/paper.pdf"');
  });

  it("embeds only canonical YouTube/Vimeo frames and links other widgets", () => {
    const html = renderBlocks([
      {
        id: "youtube",
        type: "embed",
        href: "https://youtu.be/dQw4w9WgXcQ?t=42",
        caption: [{ text: "Talk" }],
      },
      {
        id: "other-widget",
        type: "embed",
        href: "https://example.com/widget",
        caption: [{ text: "Interactive widget" }],
      },
    ]);

    expect(html).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(html).toContain('sandbox="allow-scripts allow-same-origin allow-presentation"');
    expect(html).toContain('href="https://example.com/widget"');
    expect(html.match(/<iframe/g)).toHaveLength(1);
  });

  it("uses row scope for every first-column header in a row-header-only table", () => {
    const html = renderBlocks([table(false, true, "row-headers")]);

    expect(html).toContain('<th scope="row"><span>Mass</span></th>');
    expect(html).toContain('<th scope="row"><span>Speed</span></th>');
    expect(html).not.toContain('scope="col"');
  });

  it("uses column scope only for the first row in a column-header-only table", () => {
    const html = renderBlocks([table(true, false, "column-headers")]);

    expect(html).toContain('<th scope="col"><span>Mass</span></th>');
    expect(html).toContain('<th scope="col"><span>Value</span></th>');
    expect(html).toContain("<td><span>Speed</span></td>");
    expect(html).not.toContain('scope="row"');
  });

  it("uses column scope on the header row and row scope below it when both are enabled", () => {
    const html = renderBlocks([table(true, true, "row-and-column-headers")]);

    expect(html).toContain('<th scope="col"><span>Mass</span></th>');
    expect(html).toContain('<th scope="col"><span>Value</span></th>');
    expect(html).toContain('<th scope="row"><span>Speed</span></th>');
  });

  it("gives display equations an accessible mathematical role and label", () => {
    const html = renderBlocks([
      {
        id: "display-equation",
        type: "equation",
        expression: "E = mc^2",
      },
    ]);

    expect(html).toContain('role="math"');
    expect(html).toContain('aria-label="Equation: E = mc^2"');
  });
});
