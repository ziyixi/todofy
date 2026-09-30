import { describe, expect, it } from "vitest";

import { sha256 } from "../../src/lib/content/hash";
import type { ContentBlock, ContentSnapshot } from "../../src/lib/content/schema";
import { validateContentSnapshot } from "../../src/lib/content/validate";

const mediaHash = "a".repeat(64);
const mediaPath = `/media/${mediaHash}.pdf`;

function snapshot(blocks: ContentBlock[]): ContentSnapshot {
  const sourceKey = sha256("new-content-block-validation");
  return {
    schemaVersion: 1,
    sourceMode: "fixture",
    posts: [
      {
        sourceKey,
        feedGuid: `urn:ziyixi:post:${sourceKey}`,
        slug: "new-content-blocks",
        title: "New content blocks",
        summary: "A synthetic test of nested Notion content blocks.",
        language: "en",
        publishedAt: "2026-01-01T00:00:00.000Z",
        tags: [],
        blocks,
        toc: [],
        media: [],
      },
    ],
    media: [],
    redirects: [],
  };
}

describe("expanded Notion block validation", () => {
  it("tracks headings and links inside columns, to-dos, and collapsible headings", () => {
    const value = snapshot([
      { id: "toc-marker", type: "tableOfContents" },
      {
        id: "column-list",
        type: "columns",
        columns: [
          {
            id: "column-one",
            children: [
              {
                id: "section",
                type: "heading",
                level: 2,
                anchor: "section",
                richText: [{ text: "Section" }],
                toggleable: true,
                children: [
                  {
                    id: "task",
                    type: "toDo",
                    checked: true,
                    richText: [{ text: "Read the note", href: "/blog/new-content-blocks#section" }],
                    children: [],
                  },
                ],
              },
            ],
          },
          { id: "column-two", children: [] },
        ],
      },
    ]);
    value.posts[0]!.toc = [{ id: "section", text: "Section", level: 2 }];
    expect(() => validateContentSnapshot(value)).not.toThrow();
  });

  it("rejects misplaced or repeated Notion table-of-contents markers", () => {
    const nested = snapshot([
      {
        id: "outer",
        type: "toggle",
        richText: [{ text: "More" }],
        children: [{ id: "toc-marker", type: "tableOfContents" }],
      },
    ]);
    expect(() => validateContentSnapshot(nested)).toThrowError(
      expect.objectContaining({ code: "INVALID_TOC_PLACEMENT" }),
    );
    const repeated = snapshot([
      { id: "toc-one", type: "tableOfContents" },
      { id: "toc-two", type: "tableOfContents" },
    ]);
    expect(() => validateContentSnapshot(repeated)).toThrowError(
      expect.objectContaining({ code: "INVALID_TOC_PLACEMENT" }),
    );
  });

  it("rejects a regular heading with hidden children and duplicate column ids", () => {
    const heading = snapshot([
      {
        id: "section",
        type: "heading",
        level: 2,
        anchor: "section",
        richText: [{ text: "Section" }],
        children: [],
      },
    ]);
    heading.posts[0]!.toc = [{ id: "section", text: "Section", level: 2 }];
    expect(() => validateContentSnapshot(heading)).toThrowError(
      expect.objectContaining({ code: "INVALID_HEADING_CHILDREN" }),
    );

    const columns = snapshot([
      {
        id: "column-list",
        type: "columns",
        columns: [
          { id: "same-column", children: [] },
          { id: "same-column", children: [] },
        ],
      },
    ]);
    expect(() => validateContentSnapshot(columns)).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_BLOCK_ID" }),
    );
  });

  it("verifies local media MIME and hash and rejects unrewritten private links", () => {
    const mediaBlock: ContentBlock = {
      id: "pdf-block",
      type: "mediaFile",
      kind: "pdf",
      name: "A paper.pdf",
      caption: [],
      source: { type: "local", mediaPath, sha256: mediaHash },
    };
    const value = snapshot([mediaBlock]);
    value.posts[0]!.media = [mediaPath];
    value.media = [
      { path: mediaPath, sha256: mediaHash, mimeType: "application/pdf", sizeBytes: 100 },
    ];
    expect(() => validateContentSnapshot(value)).not.toThrow();

    value.media[0]!.mimeType = "text/html";
    expect(() => validateContentSnapshot(value)).toThrowError(
      expect.objectContaining({ code: "MEDIA_TYPE_MISMATCH" }),
    );
    value.media[0]!.mimeType = "application/pdf";
    value.media[0]!.sha256 = "b".repeat(64);
    expect(() => validateContentSnapshot(value)).toThrowError(
      expect.objectContaining({ code: "MEDIA_HASH_MISMATCH" }),
    );

    const external = snapshot([
      {
        id: "private-embed",
        type: "embed",
        href: "https://www.notion.so/private-page",
        caption: [],
      },
    ]);
    expect(() => validateContentSnapshot(external)).toThrowError(
      expect.objectContaining({ code: "UNREWRITTEN_NOTION_LINK" }),
    );
    external.posts[0]!.blocks = [
      { id: "unsafe-embed", type: "embed", href: "mailto:author@example.com", caption: [] },
    ];
    expect(() => validateContentSnapshot(external)).toThrowError(
      expect.objectContaining({ code: "UNSAFE_MEDIA_URL" }),
    );
    external.posts[0]!.blocks = [
      {
        id: "http-audio",
        type: "mediaFile",
        kind: "audio",
        name: "Interview",
        caption: [],
        source: { type: "external", href: "http://example.com/interview.mp3" },
      },
    ];
    expect(() => validateContentSnapshot(external)).toThrowError(
      expect.objectContaining({ code: "UNSAFE_MEDIA_URL" }),
    );
  });
});
