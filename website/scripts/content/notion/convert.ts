import { ContentError } from "../../../src/lib/content/errors";
import { validateKatexExpression } from "../../../src/lib/content/equation";
import { sha256 } from "../../../src/lib/content/hash";
import {
  normalizeHeadingText,
  RESERVED_ARTICLE_ANCHOR_IDS,
} from "../../../src/lib/content/heading";
import type { ContentBlock, RichTextSpan, TocEntrySchema } from "../../../src/lib/content/schema";
import { validatePublicHref } from "../../../src/lib/content/url";
import type { z } from "zod";
import type { MediaAsset } from "../types";
import type { NotionBlockNode, RemoteImage, ResolvedImage } from "./types";

type TocEntry = z.infer<typeof TocEntrySchema>;

export const HIGHLIGHTED_CODE_LANGUAGES = new Set([
  "bash",
  "c",
  "cpp",
  "css",
  "go",
  "html",
  "javascript",
  "json",
  "jsx",
  "markdown",
  "python",
  "rust",
  "shell",
  "sql",
  "text",
  "tsx",
  "typescript",
  "yaml",
]);

export interface ConvertContext {
  publicPageSlugs: Map<string, string>;
  warnings: string[];
  resolveImage?: (image: RemoteImage) => Promise<ResolvedImage>;
}

export interface ConvertedBlocks {
  blocks: ContentBlock[];
  toc: TocEntry[];
  media: MediaAsset[];
}

export async function convertNotionBlocks(
  nodes: NotionBlockNode[],
  context: ConvertContext,
): Promise<ConvertedBlocks> {
  const headingCounts = new Map<string, number>();
  const allocatedHeadingAnchors = new Set(RESERVED_ARTICLE_ANCHOR_IDS);
  const toc: TocEntry[] = [];
  const media = new Map<string, MediaAsset>();

  const blocks = await convertNodes(nodes);
  return { blocks, toc, media: [...media.values()].sort((a, b) => a.path.localeCompare(b.path)) };

  async function convertNodes(input: NotionBlockNode[]): Promise<ContentBlock[]> {
    const output: ContentBlock[] = [];
    for (const node of input) {
      const raw = node.block;
      const type = getString(raw, "type");
      const id = stableBlockId(getString(raw, "id"));
      const payload = getRecord(raw, type);

      switch (type) {
        case "paragraph":
          output.push({
            id,
            type: "paragraph",
            richText: convertRichText(getArray(payload, "rich_text"), context),
            children: await convertNodes(node.children),
          });
          break;
        case "heading_1":
        case "heading_2":
        case "heading_3": {
          if (node.children.length > 0 || payload.is_toggleable === true) {
            throw unsupportedBlock(type, raw, "toggleable headings are not supported");
          }
          const richText = convertRichText(getArray(payload, "rich_text"), context);
          const text = normalizeHeadingText(richText);
          if (!text) throw unsupportedBlock(type, raw, "heading text is empty");
          const anchor = allocateHeadingAnchor(
            headingSlug(text),
            headingCounts,
            allocatedHeadingAnchors,
          );
          const level = ({ heading_1: 2, heading_2: 3, heading_3: 4 } as const)[type];
          output.push({ id, type: "heading", level, anchor, richText });
          toc.push({ id: anchor, text, level });
          break;
        }
        case "bulleted_list_item":
        case "numbered_list_item":
          output.push({
            id,
            type: "listItem",
            style: type === "bulleted_list_item" ? "bulleted" : "numbered",
            richText: convertRichText(getArray(payload, "rich_text"), context),
            children: await convertNodes(node.children),
          });
          break;
        case "quote":
          output.push({
            id,
            type: "quote",
            richText: convertRichText(getArray(payload, "rich_text"), context),
            children: await convertNodes(node.children),
          });
          break;
        case "divider":
          if (node.children.length > 0) throw unsupportedBlock(type, raw, "divider has children");
          output.push({ id, type: "divider" });
          break;
        case "code": {
          if (node.children.length > 0) throw unsupportedBlock(type, raw, "code has children");
          const language = getString(payload, "language").toLowerCase();
          const highlighted = HIGHLIGHTED_CODE_LANGUAGES.has(language);
          if (!highlighted) {
            context.warnings.push(
              `Block ${getString(raw, "id")} uses unknown code language ${language}; kept as plain text.`,
            );
          }
          output.push({
            id,
            type: "code",
            code: plainText(getArray(payload, "rich_text")),
            language,
            caption: convertRichText(optionalArray(payload.caption), context),
            highlighted,
          });
          break;
        }
        case "equation": {
          const expression = getString(payload, "expression").trim();
          if (!expression || /(?:\\html|\\href|\\includegraphics)/i.test(expression)) {
            throw unsupportedBlock(type, raw, "equation is empty or uses an unsafe command");
          }
          validateKatexExpression(expression, true);
          output.push({ id, type: "equation", expression });
          break;
        }
        case "image": {
          if (!context.resolveImage) {
            throw unsupportedBlock(type, raw, "no media resolver is configured");
          }
          const imageType = getString(payload, "type");
          const file = getRecord(payload, imageType);
          const url = getString(file, "url");
          const resolved = await context.resolveImage({
            url,
            notionBlockId: getString(raw, "id"),
          });
          media.set(resolved.asset.path, resolved.asset);
          const caption = convertRichText(optionalArray(payload.caption), context);
          const alt = caption
            .map((span) => span.text)
            .join("")
            .trim();
          if (!alt) {
            context.warnings.push(
              `Image block ${getString(raw, "id")} has no caption; emitted with empty alt text.`,
            );
          }
          if (!resolved.asset.width || !resolved.asset.height) {
            throw unsupportedBlock(type, raw, "image dimensions are unavailable");
          }
          output.push({
            id,
            type: "image",
            mediaPath: resolved.asset.path,
            sha256: resolved.asset.sha256,
            width: resolved.asset.width,
            height: resolved.asset.height,
            alt,
            caption,
          });
          break;
        }
        case "table": {
          const rows = node.children.map((child) => {
            if (child.block.type !== "table_row" || child.children.length > 0) {
              throw unsupportedBlock(type, raw, "table contains a non-row child");
            }
            const row = getRecord(child.block, "table_row");
            return getArray(row, "cells").map((cell) => {
              if (!Array.isArray(cell)) {
                throw unsupportedBlock(type, raw, "table cell is malformed");
              }
              return convertRichText(cell, context);
            });
          });
          if (rows.length === 0) throw unsupportedBlock(type, raw, "table has no rows");
          const width = rows[0]?.length;
          if (!width || rows.some((row) => row.length !== width)) {
            throw unsupportedBlock(type, raw, "table rows have inconsistent widths");
          }
          output.push({
            id,
            type: "table",
            hasColumnHeader: payload.has_column_header === true,
            hasRowHeader: payload.has_row_header === true,
            rows,
          });
          break;
        }
        case "toggle":
          output.push({
            id,
            type: "toggle",
            richText: convertRichText(getArray(payload, "rich_text"), context),
            children: await convertNodes(node.children),
          });
          break;
        case "callout": {
          const icon =
            isRecord(payload.icon) && payload.icon.type === "emoji"
              ? getString(payload.icon, "emoji")
              : undefined;
          output.push({
            id,
            type: "callout",
            richText: convertRichText(getArray(payload, "rich_text"), context),
            ...(icon ? { icon } : {}),
            children: await convertNodes(node.children),
          });
          break;
        }
        case "bookmark":
          output.push({
            id,
            type: "bookmark",
            href: rewriteNotionLink(getString(payload, "url"), context.publicPageSlugs),
            caption: convertRichText(optionalArray(payload.caption), context),
          });
          break;
        case "table_row":
          throw unsupportedBlock(type, raw, "table rows must be children of a table");
        default:
          throw unsupportedBlock(type, raw);
      }
    }
    return output;
  }
}

function allocateHeadingAnchor(
  base: string,
  counts: Map<string, number>,
  allocated: Set<string>,
): string {
  let occurrence = (counts.get(base) ?? 0) + 1;
  let candidate = occurrence === 1 ? base : `${base}-${occurrence}`;
  while (allocated.has(candidate)) {
    occurrence += 1;
    candidate = `${base}-${occurrence}`;
  }
  counts.set(base, occurrence);
  allocated.add(candidate);
  return candidate;
}

export function convertRichText(input: unknown[], context: ConvertContext): RichTextSpan[] {
  return input.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new ContentError("INVALID_RICH_TEXT", `Rich text item ${index} is malformed.`);
    }
    const type = getString(raw, "type");
    let text: string;
    let equation = false;
    let href = typeof raw.href === "string" ? raw.href : undefined;
    if (type === "text") {
      const textObject = getRecord(raw, "text");
      text = getString(textObject, "content");
      if (!href && isRecord(textObject.link) && typeof textObject.link.url === "string") {
        href = textObject.link.url;
      }
    } else if (type === "equation") {
      text = getString(getRecord(raw, "equation"), "expression");
      validateKatexExpression(text, false);
      equation = true;
    } else if (type === "mention") {
      const mention = getRecord(raw, "mention");
      if (mention.type !== "page") {
        throw new ContentError(
          "UNSUPPORTED_MENTION",
          `Unsupported Notion mention type: ${String(mention.type)}`,
        );
      }
      const pageId = normalizeNotionId(getString(getRecord(mention, "page"), "id"));
      const slug = context.publicPageSlugs.get(pageId);
      if (!slug) {
        throw new ContentError(
          "PRIVATE_PAGE_MENTION",
          "A page mention points to a page outside the public article set.",
        );
      }
      text = typeof raw.plain_text === "string" ? raw.plain_text : slug;
      href = `/blog/${slug}`;
    } else {
      throw new ContentError("UNSUPPORTED_RICH_TEXT", `Unsupported rich text type: ${type}`);
    }

    if (href) href = rewriteNotionLink(href, context.publicPageSlugs);
    const annotations = isRecord(raw.annotations) ? raw.annotations : {};
    return {
      text,
      ...(annotations.bold === true ? { bold: true } : {}),
      ...(annotations.italic === true ? { italic: true } : {}),
      ...(annotations.strikethrough === true ? { strikethrough: true } : {}),
      ...(annotations.underline === true ? { underline: true } : {}),
      ...(annotations.code === true ? { code: true } : {}),
      ...(equation ? { equation: true } : {}),
      ...(href ? { href: validatePublicHref(href) } : {}),
    };
  });
}

function rewriteNotionLink(href: string, pages: Map<string, string>): string {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return validatePublicHref(href);
  }
  if (!/(?:^|\.)notion\.(?:so|site)$/.test(parsed.hostname)) return validatePublicHref(href);
  const candidate = parsed.pathname.split("/").at(-1)?.replaceAll("-", "") ?? "";
  const match = /([a-f0-9]{32})$/i.exec(candidate);
  if (!match) {
    throw new ContentError("UNKNOWN_NOTION_LINK", "A Notion link does not contain a page ID.");
  }
  const pageId = match[1];
  if (!pageId) {
    throw new ContentError("UNKNOWN_NOTION_LINK", "A Notion link does not contain a page ID.");
  }
  const slug = pages.get(pageId.toLowerCase());
  if (!slug) {
    throw new ContentError(
      "PRIVATE_NOTION_LINK",
      "A Notion link points to a page outside the public article set.",
    );
  }
  if (parsed.hash) {
    throw new ContentError(
      "UNRESOLVED_NOTION_FRAGMENT",
      "A Notion section link cannot be published until its target block is mapped to a public heading anchor.",
    );
  }
  return `/blog/${slug}`;
}

function stableBlockId(id: string): string {
  return `b-${sha256(`notion-block:v1:${normalizeNotionId(id)}`).slice(0, 24)}`;
}

function headingSlug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || "section"
  );
}

function plainText(input: unknown[]): string {
  return input
    .map((item) => (isRecord(item) && typeof item.plain_text === "string" ? item.plain_text : ""))
    .join("");
}

function normalizeNotionId(id: string): string {
  const normalized = id.replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized)) {
    throw new ContentError("INVALID_NOTION_ID", "Notion returned an invalid page or block ID.");
  }
  return normalized;
}

function unsupportedBlock(
  type: string,
  block: Record<string, unknown>,
  reason?: string,
): ContentError {
  return new ContentError(
    "UNSUPPORTED_NOTION_BLOCK",
    `Unsupported Notion block ${type}${reason ? `: ${reason}` : ""}.`,
    { blockId: typeof block.id === "string" ? block.id : "unknown", blockType: type },
  );
}

function getRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const child = value[key];
  if (!isRecord(child)) {
    throw new ContentError("INVALID_NOTION_RESPONSE", `Expected object at ${key}.`);
  }
  return child;
}

function getArray(value: Record<string, unknown>, key: string): unknown[] {
  const child = value[key];
  if (!Array.isArray(child)) {
    throw new ContentError("INVALID_NOTION_RESPONSE", `Expected array at ${key}.`);
  }
  return child;
}

function optionalArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ContentError("INVALID_NOTION_RESPONSE", "Expected an optional array.");
  }
  return value;
}

function getString(value: Record<string, unknown>, key: string): string {
  const child = value[key];
  if (typeof child !== "string") {
    throw new ContentError("INVALID_NOTION_RESPONSE", `Expected string at ${key}.`);
  }
  return child;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
