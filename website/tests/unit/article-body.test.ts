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
