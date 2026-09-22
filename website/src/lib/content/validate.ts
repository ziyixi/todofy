import { comparePostsNewestFirst } from "./date";
import { ContentError } from "./errors";
import { normalizeHeadingText, RESERVED_ARTICLE_ANCHOR_IDS } from "./heading";
import {
  ContentSnapshotSchema,
  type ContentBlock,
  type ContentSnapshot,
  type RichTextSpan,
} from "./schema";
import { assertUniqueTranslationLanguages } from "./translations";

export function validateContentSnapshot(input: unknown): ContentSnapshot {
  return validateContentSnapshotWithOptions(input, { allowCvPath: false });
}

export function validateContentSnapshotWithOptions(
  input: unknown,
  options: { allowCvPath: boolean; canonicalOrigin?: string },
): ContentSnapshot {
  const snapshot = ContentSnapshotSchema.parse(input);
  assertUniqueTranslationLanguages(snapshot.posts);
  const expectedOrder = [...snapshot.posts].sort(comparePostsNewestFirst);
  if (expectedOrder.some((post, index) => post.sourceKey !== snapshot.posts[index]?.sourceKey)) {
    throw new ContentError(
      "UNSTABLE_POST_ORDER",
      "Posts must be sorted by publishedAt descending and slug ascending.",
    );
  }

  const mediaByPath = new Map(snapshot.media.map((asset) => [asset.path, asset]));
  if (mediaByPath.size !== snapshot.media.length) {
    throw new ContentError("DUPLICATE_MEDIA", "Snapshot contains duplicate media paths.");
  }

  const allReferencedMedia = new Set<string>();
  const currentPaths = new Set(snapshot.posts.map((post) => `/blog/${post.slug}`));
  const currentKeys = new Set(snapshot.posts.map((post) => post.sourceKey));
  const linksByPost: Array<{ slug: string; links: string[] }> = [];
  const anchorsByPath = new Map<string, Set<string>>([
    ["/", new Set(["main-content", "about-title", "blog-title", "publications-title"])],
    ["/blog", new Set(["main-content"])],
    ["/publications", new Set(["main-content"])],
  ]);

  for (const post of snapshot.posts) {
    const state = {
      ids: new Set<string>(),
      headingAnchors: new Set<string>(),
      headings: [] as Array<{ id: string; text: string; level: 2 | 3 | 4 }>,
      media: new Set<string>(),
      links: [] as string[],
    };
    inspectBlocks(post.blocks, state);
    anchorsByPath.set(
      `/blog/${post.slug}`,
      new Set(["main-content", ...state.headings.map((heading) => heading.id)]),
    );
    linksByPost.push({ slug: post.slug, links: state.links });

    if (state.ids.size === 0 && post.blocks.length > 0) {
      throw new ContentError("INVALID_BLOCKS", `Could not inspect blocks for ${post.slug}.`);
    }
    if (
      state.headings.length !== post.toc.length ||
      state.headings.some((heading, index) => {
        const toc = post.toc[index];
        return (
          !toc || toc.id !== heading.id || toc.text !== heading.text || toc.level !== heading.level
        );
      })
    ) {
      throw new ContentError(
        "INVALID_TOC",
        `Table of contents does not match headings for ${post.slug}.`,
      );
    }

    const declaredMedia = [...new Set(post.media)].sort();
    const referencedMedia = [...state.media].sort();
    if (declaredMedia.join("\0") !== referencedMedia.join("\0")) {
      throw new ContentError(
        "INVALID_MEDIA_LIST",
        `Post media list does not match image blocks for ${post.slug}.`,
      );
    }
    for (const mediaPath of state.media) {
      if (!mediaByPath.has(mediaPath)) {
        throw new ContentError("MISSING_MEDIA", `Post references missing media: ${mediaPath}`);
      }
      allReferencedMedia.add(mediaPath);
    }
  }

  for (const asset of snapshot.media) {
    if (!allReferencedMedia.has(asset.path)) {
      throw new ContentError("ORPHAN_MEDIA", `Snapshot contains unreferenced media: ${asset.path}`);
    }
  }

  const publicPaths = new Set([
    "/",
    "/blog",
    "/publications",
    "/feed.xml",
    "/sitemap.xml",
    "/robots.txt",
    "/build-info.json",
    ...currentPaths,
    ...snapshot.media.map((asset) => asset.path),
    ...(options.allowCvPath ? ["/cv.pdf"] : []),
  ]);
  for (const post of linksByPost) {
    for (const href of post.links) {
      const target = internalLinkTarget(href, options.canonicalOrigin);
      if (!target) continue;
      if (!publicPaths.has(target.pathname)) {
        throw new ContentError(
          "BROKEN_INTERNAL_LINK",
          `Post ${post.slug} links to a route that is not public: ${href}`,
        );
      }
      if (target.hash) {
        const fragment = decodeFragment(target.hash, href);
        if (!anchorsByPath.get(target.pathname)?.has(fragment)) {
          throw new ContentError(
            "BROKEN_INTERNAL_ANCHOR",
            `Post ${post.slug} links to an unknown public anchor: ${href}`,
          );
        }
      }
    }
  }

  const redirectSources = new Set<string>();
  const knownRoutes = new Set(["/", "/blog", "/publications", ...currentPaths]);
  for (const redirect of snapshot.redirects) {
    if (redirectSources.has(redirect.from)) {
      throw new ContentError("DUPLICATE_REDIRECT", `Duplicate redirect source: ${redirect.from}`);
    }
    redirectSources.add(redirect.from);
    if (currentPaths.has(redirect.from)) {
      throw new ContentError(
        "REDIRECT_SHADOWS_POST",
        `Redirect shadows a current post: ${redirect.from}`,
      );
    }
    const targetPath = stripQueryAndHash(redirect.to);
    if (!knownRoutes.has(targetPath)) {
      throw new ContentError(
        "INVALID_REDIRECT_TARGET",
        `Redirect target is not public: ${redirect.to}`,
      );
    }
    if (
      redirect.sourceKey &&
      (!currentPaths.has(targetPath) || !currentKeys.has(redirect.sourceKey))
    ) {
      throw new ContentError(
        "INVALID_REDIRECT_TARGET",
        `Article redirect target is not public: ${redirect.to}`,
      );
    }
    if (redirectSources.has(targetPath)) {
      throw new ContentError("REDIRECT_CHAIN", `Redirect chains are not allowed: ${redirect.from}`);
    }
  }

  for (const redirect of snapshot.redirects) {
    if (redirectSources.has(stripQueryAndHash(redirect.to))) {
      throw new ContentError("REDIRECT_CHAIN", `Redirect chains are not allowed: ${redirect.from}`);
    }
  }

  return snapshot;
}

function internalLinkTarget(href: string, canonicalOrigin: string | undefined): URL | undefined {
  if (href.startsWith("/")) return new URL(href, "https://internal.invalid");
  if (!canonicalOrigin) return undefined;
  const target = new URL(href);
  return target.origin === canonicalOrigin ? target : undefined;
}

function decodeFragment(hash: string, href: string): string {
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    throw new ContentError("BROKEN_INTERNAL_ANCHOR", `Link has an invalid fragment: ${href}`);
  }
}

function inspectBlocks(
  blocks: ContentBlock[],
  state: {
    ids: Set<string>;
    headings: Array<{ id: string; text: string; level: 2 | 3 | 4 }>;
    headingAnchors: Set<string>;
    media: Set<string>;
    links: string[];
  },
): void {
  for (const block of blocks) {
    if (state.ids.has(block.id)) {
      throw new ContentError("DUPLICATE_BLOCK_ID", `Duplicate block ID: ${block.id}`);
    }
    state.ids.add(block.id);
    switch (block.type) {
      case "paragraph":
      case "listItem":
      case "quote":
      case "toggle":
      case "callout":
        inspectRichText(block.richText, state.links);
        inspectBlocks(block.children, state);
        break;
      case "heading":
        inspectRichText(block.richText, state.links);
        if (RESERVED_ARTICLE_ANCHOR_IDS.has(block.anchor)) {
          throw new ContentError(
            "RESERVED_HEADING_ANCHOR",
            `Heading anchor is reserved by the article shell: ${block.anchor}`,
          );
        }
        if (state.headingAnchors.has(block.anchor)) {
          throw new ContentError(
            "DUPLICATE_HEADING_ANCHOR",
            `Duplicate heading anchor: ${block.anchor}`,
          );
        }
        state.headingAnchors.add(block.anchor);
        const headingText = normalizeHeadingText(block.richText);
        if (!headingText) {
          throw new ContentError("INVALID_HEADING_TEXT", "Heading text cannot be empty.");
        }
        state.headings.push({
          id: block.anchor,
          text: headingText,
          level: block.level,
        });
        break;
      case "code":
        inspectRichText(block.caption, state.links);
        break;
      case "image":
        state.media.add(block.mediaPath);
        inspectRichText(block.caption, state.links);
        break;
      case "table":
        for (const row of block.rows) for (const cell of row) inspectRichText(cell, state.links);
        break;
      case "bookmark":
        inspectHref(block.href, state.links);
        inspectRichText(block.caption, state.links);
        break;
      case "divider":
      case "equation":
        break;
      default: {
        const exhaustive: never = block;
        throw new ContentError("UNKNOWN_BLOCK", `Unknown block: ${String(exhaustive)}`);
      }
    }
  }
}

function inspectRichText(spans: RichTextSpan[], links: string[]): void {
  for (const span of spans) if (span.href) inspectHref(span.href, links);
}

function inspectHref(href: string, links: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(href, "https://internal.invalid");
  } catch {
    links.push(href);
    return;
  }
  if (/(?:^|\.)notion\.(?:so|site)$/.test(parsed.hostname)) {
    throw new ContentError(
      "UNREWRITTEN_NOTION_LINK",
      "A Notion page link reached the public snapshot without being rewritten.",
    );
  }
  links.push(href);
}

function stripQueryAndHash(href: string): string {
  const url = new URL(href, "https://internal.invalid");
  return url.pathname;
}
