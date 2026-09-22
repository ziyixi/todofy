import { describe, expect, it } from "vitest";

import { parseContentDate } from "../../src/lib/content/date";
import { sha256 } from "../../src/lib/content/hash";
import type { ContentSnapshot } from "../../src/lib/content/schema";
import { validateSlug } from "../../src/lib/content/slug";
import { validateHttpsOrigin, validatePublicHref } from "../../src/lib/content/url";
import { validateContentSnapshotWithOptions } from "../../src/lib/content/validate";

function snapshotWithHref(href: string): ContentSnapshot {
  const sourceKey = sha256("internal-link-test");
  return {
    schemaVersion: 1,
    sourceMode: "fixture",
    posts: [
      {
        sourceKey,
        feedGuid: `urn:ziyixi:post:${sourceKey}`,
        slug: "link-check",
        title: "Link check",
        summary: "A representative internal link validation record.",
        language: "en",
        publishedAt: "2026-01-01T00:00:00.000Z",
        tags: [],
        blocks: [
          {
            id: "known-heading",
            type: "heading",
            level: 2,
            anchor: "known-heading",
            richText: [{ text: "Known heading" }],
          },
          {
            id: "link-paragraph",
            type: "paragraph",
            richText: [{ text: "Target", href }],
            children: [],
          },
        ],
        toc: [{ id: "known-heading", text: "Known heading", level: 2 }],
        media: [],
      },
    ],
    media: [],
    redirects: [],
  };
}

describe("content date rules", () => {
  it("normalizes date-only values to UTC midnight", () => {
    expect(parseContentDate("2025-02-03")).toBe("2025-02-03T00:00:00.000Z");
  });

  it("requires an explicit offset for date-time values", () => {
    expect(() => parseContentDate("2025-02-03T10:00:00")).toThrow(/explicit UTC offset/);
    expect(parseContentDate("2025-02-03T10:00:00-08:00")).toBe("2025-02-03T18:00:00.000Z");
  });

  it("rejects calendar rollover", () => {
    expect(() => parseContentDate("2025-02-30")).toThrow(/Invalid calendar date/);
  });
});

describe("slug and URL rules", () => {
  it("accepts only unambiguous lowercase slugs", () => {
    expect(validateSlug("research-notes")).toBe("research-notes");
    expect(() => validateSlug("Research Notes")).toThrow();
    expect(() => validateSlug("../notes")).toThrow();
    expect(() => validateSlug("blog")).toThrow(/reserved/i);
  });

  it("accepts a bare HTTPS origin and rejects path-bearing origins", () => {
    expect(validateHttpsOrigin("https://www.ziyixi.science")).toBe("https://www.ziyixi.science");
    expect(() => validateHttpsOrigin("https://www.ziyixi.science/blog")).toThrow();
    expect(() => validateHttpsOrigin("http://www.ziyixi.science")).toThrow();
  });

  it("rejects dangerous or ambiguous links", () => {
    expect(validatePublicHref("/blog/research-notes#result")).toBe("/blog/research-notes#result");
    expect(() => validatePublicHref("javascript:alert(1)")).toThrow(/protocol/);
    expect(() => validatePublicHref("//attacker.example/path")).toThrow(/Ambiguous/);
    expect(() => validatePublicHref("/blog%2fsecret")).toThrow(/Ambiguous/);
  });

  it.each([
    "http://example.com/paper?version=1#results",
    "https://example.com/paper?version=1#results",
    "mailto:author@example.com",
  ])("preserves the protocol and destination of a public link: %s", (href) => {
    expect(validatePublicHref(href)).toBe(href);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///tmp/notes",
    "http://user:password@example.com/",
    "https://user:password@example.com/",
  ])("rejects unsafe links even when HTTP is supported: %s", (href) => {
    expect(() => validatePublicHref(href)).toThrowError(
      expect.objectContaining({ code: "UNSAFE_URL" }),
    );
  });

  it("accepts HTTP rich text and bookmarks through the full snapshot boundary", () => {
    const href = "http://example.com/paper?version=1#results";
    const snapshot = snapshotWithHref(href);
    const post = snapshot.posts[0];
    if (!post) throw new Error("invalid test fixture");
    post.blocks.push({ id: "http-bookmark", type: "bookmark", href, caption: [] });

    const validated = validateContentSnapshotWithOptions(snapshot, { allowCvPath: false });
    expect(validated.posts[0]?.blocks[1]).toMatchObject({
      type: "paragraph",
      richText: [{ text: "Target", href }],
    });
    expect(validated.posts[0]?.blocks[2]).toMatchObject({ type: "bookmark", href });
  });

  it("validates every internal route and article fragment", () => {
    const options = {
      allowCvPath: false,
      canonicalOrigin: "https://www.ziyixi.science",
    };
    expect(() =>
      validateContentSnapshotWithOptions(
        snapshotWithHref("/blog/link-check#known-heading"),
        options,
      ),
    ).not.toThrow();
    expect(() =>
      validateContentSnapshotWithOptions(snapshotWithHref("/missing"), options),
    ).toThrowError(expect.objectContaining({ code: "BROKEN_INTERNAL_LINK" }));
    expect(() =>
      validateContentSnapshotWithOptions(
        snapshotWithHref("/blog/link-check#missing-heading"),
        options,
      ),
    ).toThrowError(expect.objectContaining({ code: "BROKEN_INTERNAL_ANCHOR" }));
    expect(() =>
      validateContentSnapshotWithOptions(
        snapshotWithHref("https://www.ziyixi.science/not-a-route"),
        options,
      ),
    ).toThrowError(expect.objectContaining({ code: "BROKEN_INTERNAL_LINK" }));
  });

  it("normalizes heading text consistently across rich-text spans and the TOC", () => {
    const snapshot = snapshotWithHref("/");
    const post = snapshot.posts[0];
    const heading = post?.blocks[0];
    if (!post || !heading || heading.type !== "heading") throw new Error("invalid test fixture");
    heading.richText = [{ text: "  Known" }, { text: " heading  " }];
    post.toc[0] = { id: "known-heading", text: "Known heading", level: 2 };

    expect(() =>
      validateContentSnapshotWithOptions(snapshot, { allowCvPath: false }),
    ).not.toThrow();
  });

  it("rejects whitespace-only heading text at the snapshot boundary", () => {
    const snapshot = snapshotWithHref("/");
    const post = snapshot.posts[0];
    const heading = post?.blocks[0];
    if (!post || !heading || heading.type !== "heading") throw new Error("invalid test fixture");
    heading.richText = [{ text: "  " }, { text: "\t" }];
    post.toc[0] = { id: "known-heading", text: "placeholder", level: 2 };

    expect(() => validateContentSnapshotWithOptions(snapshot, { allowCvPath: false })).toThrowError(
      expect.objectContaining({ code: "INVALID_HEADING_TEXT" }),
    );
  });

  it("rejects duplicate and article-shell-reserved heading anchors", () => {
    const duplicate = snapshotWithHref("/");
    const duplicatePost = duplicate.posts[0];
    if (!duplicatePost) throw new Error("invalid test fixture");
    duplicatePost.blocks.push({
      id: "second-heading",
      type: "heading",
      level: 3,
      anchor: "known-heading",
      richText: [{ text: "Second heading" }],
    });
    duplicatePost.toc.push({ id: "known-heading", text: "Second heading", level: 3 });
    expect(() =>
      validateContentSnapshotWithOptions(duplicate, { allowCvPath: false }),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_HEADING_ANCHOR" }));

    const reserved = snapshotWithHref("/");
    const reservedPost = reserved.posts[0];
    const reservedHeading = reservedPost?.blocks[0];
    if (!reservedPost || !reservedHeading || reservedHeading.type !== "heading") {
      throw new Error("invalid test fixture");
    }
    reservedHeading.anchor = "main-content";
    reservedPost.toc[0] = { id: "main-content", text: "Known heading", level: 2 };
    expect(() => validateContentSnapshotWithOptions(reserved, { allowCvPath: false })).toThrowError(
      expect.objectContaining({ code: "RESERVED_HEADING_ANCHOR" }),
    );
  });

  it("rejects a raw Notion page URL in a bookmark at the snapshot boundary", () => {
    const snapshot = snapshotWithHref("/");
    const post = snapshot.posts[0];
    if (!post) throw new Error("invalid test fixture");
    post.blocks[1] = {
      id: "private-notion-bookmark",
      type: "bookmark",
      href: "https://www.notion.so/Private-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      caption: [],
    };

    expect(() => validateContentSnapshotWithOptions(snapshot, { allowCvPath: false })).toThrowError(
      expect.objectContaining({ code: "UNREWRITTEN_NOTION_LINK" }),
    );
  });

  it("allows the fixed CV route only when the profile enables it", () => {
    const snapshot = snapshotWithHref("/cv.pdf");
    expect(() => validateContentSnapshotWithOptions(snapshot, { allowCvPath: false })).toThrowError(
      expect.objectContaining({ code: "BROKEN_INTERNAL_LINK" }),
    );
    expect(() => validateContentSnapshotWithOptions(snapshot, { allowCvPath: true })).not.toThrow();
  });
});
