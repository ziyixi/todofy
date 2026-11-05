import { PassThrough } from "node:stream";

import { createElement } from "react";
import { renderToPipeableStream, renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ArticleBody } from "../../src/components/ArticleBody";
import type { ContentBlock, RichTextSpan, TableBlock } from "../../src/lib/content";
import { trustedVideoEmbedUrl } from "../../src/lib/content/video-embed";

function renderBlocks(blocks: ContentBlock[]): string {
  return renderToStaticMarkup(createElement(ArticleBody, { blocks }));
}

async function renderAsyncBlocks(blocks: ContentBlock[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = new PassThrough();
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
    const { pipe } = renderToPipeableStream(createElement(ArticleBody, { blocks }), {
      onAllReady() {
        pipe(stream);
      },
      onError(error) {
        reject(error);
      },
    });
  });
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

  it("groups list items by style and renders quote, callout, toggle, and inline math", () => {
    const html = renderBlocks([
      {
        id: "bullet-1",
        type: "listItem",
        style: "bulleted",
        richText: [{ text: "First bullet", bold: true }],
        children: [
          {
            id: "nested-bullet",
            type: "listItem",
            style: "bulleted",
            richText: [{ text: "Nested bullet" }],
            children: [],
          },
        ],
      },
      {
        id: "bullet-2",
        type: "listItem",
        style: "bulleted",
        richText: [{ text: "Second bullet", strikethrough: true, underline: true }],
        children: [],
      },
      {
        id: "num-1",
        type: "listItem",
        style: "numbered",
        richText: [{ text: "x^2 + y^2 = z^2", equation: true }],
        children: [],
      },
      {
        id: "quote-1",
        type: "quote",
        richText: [{ text: "Quoted thought", italic: true }],
        children: [
          {
            id: "quote-note",
            type: "paragraph",
            richText: [{ text: "Quote child" }],
            children: [],
          },
        ],
      },
      {
        id: "callout-1",
        type: "callout",
        icon: "💡",
        richText: [{ text: "Callout text", code: true }],
        children: [],
      },
      {
        id: "toggle-1",
        type: "toggle",
        richText: [{ text: "Toggle summary" }],
        children: [
          {
            id: "toggle-child",
            type: "paragraph",
            richText: [{ text: "Toggle details" }],
            children: [],
          },
        ],
      },
      { id: "divider-1", type: "divider" },
    ]);

    expect(html.match(/<ul\b/g)).toHaveLength(2);
    expect(html.match(/<ol\b/g)).toHaveLength(1);
    expect(html).toContain("<strong>First bullet</strong>");
    expect(html).toContain("<u><s>Second bullet</s></u>");
    expect(html).toContain('class="katex"');
    expect(html).toContain("<blockquote><p><span><em>Quoted thought</em></span></p>");
    expect(html).toContain("Quote child");
    expect(html).toContain('<span aria-hidden="true">💡 </span>');
    expect(html).toContain("<code>Callout text</code>");
    expect(html).toContain("<details><summary><span>Toggle summary</span></summary>");
    expect(html).toContain("Toggle details");
    expect(html).toContain("<hr/>");
  });

  it("highlights supported code languages with Shiki and falls back for unknown ones", async () => {
    const html = await renderAsyncBlocks([
      {
        id: "ts-code",
        type: "code",
        language: "typescript",
        highlighted: true,
        code: "const answer: number = 42;",
        caption: [{ text: "TypeScript snippet" }],
      },
      {
        id: "unknown-code",
        type: "code",
        language: "fortran",
        highlighted: false,
        code: "PRINT *, 'HELLO'",
        caption: [],
      },
    ]);

    expect(html).toContain("shiki");
    expect(html).toContain("<figcaption><span>TypeScript snippet</span></figcaption>");
    expect(html).toContain(
      '<pre data-language="fortran" tabindex="0"><code>PRINT *, &#x27;HELLO&#x27;</code></pre>',
    );
  });
});

describe("trusted video embeds", () => {
  it("rewrites known providers to narrow, canonical iframe URLs", () => {
    expect(trustedVideoEmbedUrl("https://youtu.be/dQw4w9WgXcQ?t=42")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    );
    expect(trustedVideoEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    );
    expect(trustedVideoEmbedUrl("https://player.vimeo.com/video/226053498?h=a1599a8ee9")).toBe(
      "https://player.vimeo.com/video/226053498?h=a1599a8ee9",
    );
  });

  it("refuses arbitrary hosts, credentials, ports, and malformed IDs", () => {
    for (const href of [
      "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
      "https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com:8443/watch?v=dQw4w9WgXcQ",
      "http://youtu.be/dQw4w9WgXcQ",
      "https://youtu.be/not-an-id",
      "https://example.com/widget",
    ]) {
      expect(trustedVideoEmbedUrl(href)).toBeUndefined();
    }
  });
});
