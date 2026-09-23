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
      mediaReferences: [] as Array<{
        path: string;
        sha256: string;
        kind: "image" | "file" | "pdf" | "audio" | "video";
      }>,
      tocPlacements: 0,
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
        `Post media list does not match media blocks for ${post.slug}.`,
      );
    }
    for (const mediaPath of state.media) {
      if (!mediaByPath.has(mediaPath)) {
        throw new ContentError("MISSING_MEDIA", `Post references missing media: ${mediaPath}`);
      }
      allReferencedMedia.add(mediaPath);
    }
    for (const reference of state.mediaReferences) {
      const asset = mediaByPath.get(reference.path);
      if (!asset) continue;
      if (asset.sha256 !== reference.sha256) {
        throw new ContentError(
          "MEDIA_HASH_MISMATCH",
          `Media block in ${post.slug} has a hash that differs from ${reference.path}.`,
        );
      }
      if (!mediaKindAcceptsMimeType(reference.kind, asset.mimeType)) {
        throw new ContentError(
          "MEDIA_TYPE_MISMATCH",
          `Media block in ${post.slug} has an unexpected type for ${reference.path}.`,
        );
      }
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

interface BlockInspectionState {
  ids: Set<string>;
  headings: Array<{ id: string; text: string; level: 2 | 3 | 4 }>;
  headingAnchors: Set<string>;
  media: Set<string>;
  mediaReferences: Array<{
    path: string;
    sha256: string;
    kind: "image" | "file" | "pdf" | "audio" | "video";
  }>;
  tocPlacements: number;
  links: string[];
}

function inspectBlocks(blocks: ContentBlock[], state: BlockInspectionState, isRoot = true): void {
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
      case "toDo":
        inspectRichText(block.richText, state.links);
        inspectBlocks(block.children, state, false);
        break;
      case "columns":
        for (const column of block.columns) {
          if (state.ids.has(column.id)) {
            throw new ContentError("DUPLICATE_BLOCK_ID", `Duplicate block ID: ${column.id}`);
          }
          state.ids.add(column.id);
          inspectBlocks(column.children, state, false);
        }
        break;
      case "tableOfContents":
        state.tocPlacements += 1;
        if (!isRoot || state.tocPlacements > 1) {
          throw new ContentError(
            "INVALID_TOC_PLACEMENT",
            "A Notion table of contents must appear once at the article root.",
          );
        }
        break;
      case "heading":
        inspectRichText(block.richText, state.links);
        if ((block.toggleable === true) !== (block.children !== undefined)) {
          throw new ContentError(
            "INVALID_HEADING_CHILDREN",
            "Only toggleable headings may contain child blocks.",
          );
        }
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
        if (block.children) inspectBlocks(block.children, state, false);
        break;
      case "code":
        inspectRichText(block.caption, state.links);
        break;
      case "image":
        state.media.add(block.mediaPath);
        state.mediaReferences.push({
          path: block.mediaPath,
          sha256: block.sha256,
          kind: "image",
        });
        inspectRichText(block.caption, state.links);
        break;
      case "mediaFile":
        if (block.source.type === "local") {
          state.media.add(block.source.mediaPath);
          state.mediaReferences.push({
            path: block.source.mediaPath,
            sha256: block.source.sha256,
            kind: block.kind,
          });
        } else {
          inspectExternalMediaHref(block.source.href, state.links);
        }
        inspectRichText(block.caption, state.links);
        break;
      case "embed":
        inspectExternalMediaHref(block.href, state.links);
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

function mediaKindAcceptsMimeType(
  kind: "image" | "file" | "pdf" | "audio" | "video",
  mimeType: string,
): boolean {
  const imageTypes = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);
  const audioTypes = new Set(["audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/x-wav"]);
  const videoTypes = new Set(["video/mp4", "video/ogg", "video/webm"]);
  if (kind === "image") return imageTypes.has(mimeType);
  if (kind === "pdf") return mimeType === "application/pdf";
  if (kind === "audio") return audioTypes.has(mimeType);
  if (kind === "video") return videoTypes.has(mimeType);
  return new Set([
    "application/octet-stream",
    "application/pdf",
    "application/zip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain",
    "text/csv",
    ...imageTypes,
    ...audioTypes,
    ...videoTypes,
  ]).has(mimeType);
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

function inspectExternalMediaHref(href: string, links: string[]): void {
  if (!href.startsWith("/blog/")) {
    let parsed: URL;
    try {
      parsed = new URL(href);
    } catch {
      throw new ContentError("UNSAFE_MEDIA_URL", "External media must have an absolute HTTPS URL.");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new ContentError(
        "UNSAFE_MEDIA_URL",
        "External media must have an HTTPS URL without credentials.",
      );
    }
  }
  inspectHref(href, links);
}

function stripQueryAndHash(href: string): string {
  const url = new URL(href, "https://internal.invalid");
  return url.pathname;
}
