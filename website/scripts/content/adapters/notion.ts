import { Client } from "@notionhq/client";

import {
  assertNotFuture,
  comparePostsNewestFirst,
  parseContentDate,
} from "../../../src/lib/content/date";
import { ContentError } from "../../../src/lib/content/errors";
import { sourceKeyForNotionPage } from "../../../src/lib/content/hash";
import type { Post } from "../../../src/lib/content/schema";
import { validateSlug } from "../../../src/lib/content/slug";
import { assertUniqueTranslationLanguages } from "../../../src/lib/content/translations";
import { convertNotionBlocks } from "../notion/convert";
import { createMediaResolver } from "../notion/media";
import { fetchBlockTree, queryAllDataSourcePages } from "../notion/pagination";
import type { NotionClientLike } from "../notion/types";
import type { PreparedSource, SourceContext } from "../types";

const EXPECTED_PROPERTY_TYPES = {
  title: "title",
  slug: "rich_text",
  status: "status",
  publishedAt: "date",
  summary: "rich_text",
  language: "select",
  tags: "multi_select",
} as const;

export interface NotionPropertyNames {
  title: string;
  slug: string;
  status: string;
  publishedAt: string;
  summary: string;
  language: string;
  tags: string;
  translationKey?: string;
}

export interface PrepareNotionOptions {
  token: string;
  dataSourceId: string;
  apiVersion: string;
  propertyNames?: NotionPropertyNames;
  client?: NotionClientLike;
  allowedMediaHosts?: string[];
}

const DEFAULT_PROPERTIES: NotionPropertyNames = {
  title: "Title",
  slug: "Slug",
  status: "Status",
  publishedAt: "PublishedAt",
  summary: "Summary",
  language: "Language",
  tags: "Tags",
  translationKey: "TranslationKey",
};

interface PublicPage {
  id: string;
  raw: Record<string, unknown>;
  slug: string;
  title: string;
  summary: string;
  language: "en" | "zh-CN";
  translationKey?: string;
  publishedAt: string;
  tags: string[];
}

export async function prepareNotionSource(
  context: SourceContext,
  options: PrepareNotionOptions,
): Promise<PreparedSource> {
  if (!options.token || !options.dataSourceId || !options.apiVersion) {
    throw new ContentError(
      "MISSING_NOTION_CREDENTIALS",
      "notion mode requires a token, data source ID, and explicit API version.",
    );
  }
  const client =
    options.client ??
    (new Client({
      auth: options.token,
      notionVersion: options.apiVersion,
      timeoutMs: 30_000,
    }) as unknown as NotionClientLike);
  const propertyNames = options.propertyNames ?? DEFAULT_PROPERTIES;
  let previousFingerprint: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Each consistency attempt is a fresh candidate snapshot. Do not charge
    // media bytes downloaded by a discarded first attempt against the retry's
    // total limit.
    const resolveImage = createMediaResolver({
      publicDirectory: context.publicDirectory,
      refreshUrl: (blockId) => refreshNotionImageUrl(client, blockId),
      ...(options.allowedMediaHosts ? { allowedHostSuffixes: options.allowedMediaHosts } : {}),
    });
    const prepared = await syncOnce(client, context, {
      ...options,
      propertyNames,
      resolveImage,
    });
    const verificationRows = await queryAllDataSourcePages(client, options.dataSourceId);
    const verification = publicMetadataFingerprint(
      collectPublicPages(verificationRows, propertyNames, context.cutoff).pages,
    );
    if (verification === prepared.fingerprint) return prepared.result;
    if (previousFingerprint === verification) {
      throw new ContentError(
        "NOTION_CHANGED_DURING_SYNC",
        "The public Notion collection changed while it was being synchronized.",
      );
    }
    previousFingerprint = verification;
  }
  throw new ContentError(
    "NOTION_CHANGED_DURING_SYNC",
    "The public Notion collection kept changing during synchronization.",
  );
}

async function syncOnce(
  client: NotionClientLike,
  context: SourceContext,
  options: PrepareNotionOptions & {
    propertyNames: NotionPropertyNames;
    resolveImage: ReturnType<typeof createMediaResolver>;
  },
): Promise<{ result: PreparedSource; fingerprint: string }> {
  const schema = await client.dataSources.retrieve({ data_source_id: options.dataSourceId });
  validateDataSourceSchema(schema, options.propertyNames);
  const rows = await queryAllDataSourcePages(client, options.dataSourceId);
  const collected = collectPublicPages(rows, options.propertyNames, context.cutoff);
  const publicPageSlugs = new Map(
    collected.pages.map((page) => [normalizeNotionId(page.id), page.slug]),
  );
  const warnings: string[] = [];
  const posts: Post[] = [];
  const media = new Map<string, PreparedSource["media"][number]>();

  for (const page of collected.pages) {
    const tree = await fetchBlockTree(client, page.id);
    const converted = await convertNotionBlocks(tree, {
      publicPageSlugs,
      warnings,
      resolveImage: options.resolveImage,
    });
    for (const asset of converted.media) media.set(asset.path, asset);
    const sourceKey = sourceKeyForNotionPage(page.id);
    posts.push({
      sourceKey,
      feedGuid: `urn:ziyixi:post:${sourceKey}`,
      slug: page.slug,
      title: page.title,
      summary: page.summary,
      language: page.language,
      ...(page.translationKey ? { translationKey: page.translationKey } : {}),
      publishedAt: page.publishedAt,
      tags: page.tags,
      blocks: converted.blocks,
      toc: converted.toc,
      media: converted.media.map((asset) => asset.path).sort(),
    });
  }
  posts.sort(comparePostsNewestFirst);

  return {
    fingerprint: publicMetadataFingerprint(collected.pages),
    result: {
      posts,
      media: [...media.values()].sort((left, right) => left.path.localeCompare(right.path)),
      diagnostics: {
        draftCount: collected.draftCount,
        futureCount: collected.futureCount,
        warnings,
      },
    },
  };
}

export function validateDataSourceSchema(
  input: unknown,
  propertyNames: NotionPropertyNames = DEFAULT_PROPERTIES,
): void {
  if (!isRecord(input) || !isRecord(input.properties)) {
    throw new ContentError("NOTION_SCHEMA_MISMATCH", "Data source has no properties object.");
  }
  for (const [logicalName, expectedType] of Object.entries(EXPECTED_PROPERTY_TYPES)) {
    const propertyName = propertyNames[logicalName as keyof typeof EXPECTED_PROPERTY_TYPES];
    const property = input.properties[propertyName];
    if (!isRecord(property) || property.type !== expectedType) {
      throw new ContentError(
        "NOTION_SCHEMA_MISMATCH",
        `Notion property ${propertyName} must have type ${expectedType}.`,
        { propertyName, expectedType },
      );
    }
  }
  const translationPropertyName = propertyNames.translationKey ?? "TranslationKey";
  const translationProperty = input.properties[translationPropertyName];
  if (
    translationProperty !== undefined &&
    (!isRecord(translationProperty) || translationProperty.type !== "rich_text")
  ) {
    throw new ContentError(
      "NOTION_SCHEMA_MISMATCH",
      `Optional Notion property ${translationPropertyName} must have type rich_text when present.`,
    );
  }
}

export async function refreshNotionImageUrl(
  client: NotionClientLike,
  blockId: string,
): Promise<string> {
  if (!client.blocks.retrieve) {
    throw new ContentError(
      "NOTION_MEDIA_REFRESH_UNAVAILABLE",
      "The Notion client cannot refresh an expired media URL.",
    );
  }
  const block = await client.blocks.retrieve({ block_id: blockId });
  if (!isRecord(block) || block.type !== "image" || !isRecord(block.image)) {
    throw new ContentError(
      "NOTION_MEDIA_REFRESH_FAILED",
      `Notion block ${blockId} is no longer an image.`,
    );
  }
  const imageType = block.image.type;
  if (imageType !== "file" && imageType !== "external") {
    throw new ContentError(
      "NOTION_MEDIA_REFRESH_FAILED",
      `Notion block ${blockId} returned an unsupported image source.`,
    );
  }
  const source = block.image[imageType];
  if (!isRecord(source) || typeof source.url !== "string" || !source.url) {
    throw new ContentError(
      "NOTION_MEDIA_REFRESH_FAILED",
      `Notion block ${blockId} did not return a refreshed image URL.`,
    );
  }
  return source.url;
}

export function collectPublicPages(
  rows: unknown[],
  propertyNames: NotionPropertyNames = DEFAULT_PROPERTIES,
  cutoff = new Date(),
): { pages: PublicPage[]; draftCount: number; futureCount: number } {
  const pages: PublicPage[] = [];
  let draftCount = 0;
  let futureCount = 0;

  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== "string" || !isRecord(row.properties)) {
      throw new ContentError("INVALID_NOTION_PAGE", "Notion returned a malformed data source row.");
    }
    if (row.in_trash === true || row.archived === true) continue;
    const status = readStatus(row.properties, propertyNames.status);
    if (status !== "Draft" && status !== "Published") {
      throw new ContentError(
        "UNKNOWN_NOTION_STATUS",
        `Unknown Notion status ${status || "(empty)"}; expected Draft or Published.`,
      );
    }
    if (status === "Draft") {
      draftCount += 1;
      continue;
    }

    const publishedAt = parseContentDate(
      readDate(row.properties, propertyNames.publishedAt, "PublishedAt"),
    );
    try {
      assertNotFuture(publishedAt, cutoff);
    } catch (error) {
      if (error instanceof ContentError && error.code === "FUTURE_POST") {
        futureCount += 1;
        continue;
      }
      throw error;
    }
    const language = readSelect(row.properties, propertyNames.language, "Language");
    if (language !== "en" && language !== "zh-CN") {
      throw new ContentError(
        "INVALID_LANGUAGE",
        `Published page language must be en or zh-CN, received ${language || "(empty)"}.`,
      );
    }
    const slug = validateSlug(readRichText(row.properties, propertyNames.slug, "Slug"));
    const title = readTitle(row.properties, propertyNames.title, "Title").trim();
    const summary = readRichText(row.properties, propertyNames.summary, "Summary").trim();
    const translationPropertyName = propertyNames.translationKey ?? "TranslationKey";
    const translationKey =
      row.properties[translationPropertyName] === undefined
        ? undefined
        : readRichText(row.properties, translationPropertyName, "TranslationKey").trim();
    if (!title || !summary) {
      throw new ContentError(
        "MISSING_NOTION_FIELD",
        `Published page ${slug} must have a title and summary.`,
      );
    }
    pages.push({
      id: row.id,
      raw: row,
      slug,
      title,
      summary,
      language,
      ...(translationKey ? { translationKey } : {}),
      publishedAt,
      tags: readMultiSelect(row.properties, propertyNames.tags),
    });
  }

  const slugs = new Set<string>();
  for (const page of pages) {
    if (slugs.has(page.slug)) {
      throw new ContentError("DUPLICATE_SLUG", `Duplicate published slug: ${page.slug}`);
    }
    slugs.add(page.slug);
  }
  assertUniqueTranslationLanguages(pages);
  pages.sort((left, right) => left.id.localeCompare(right.id));
  return { pages, draftCount, futureCount };
}

function publicMetadataFingerprint(pages: PublicPage[]): string {
  return JSON.stringify(
    pages.map((page) => ({
      id: normalizeNotionId(page.id),
      slug: page.slug,
      title: page.title,
      summary: page.summary,
      language: page.language,
      translationKey: page.translationKey,
      publishedAt: page.publishedAt,
      tags: page.tags,
      lastEditedTime:
        typeof page.raw.last_edited_time === "string" ? page.raw.last_edited_time : undefined,
    })),
  );
}

function readTitle(properties: Record<string, unknown>, name: string, label: string): string {
  return readTextArray(properties, name, "title", label);
}

function readRichText(properties: Record<string, unknown>, name: string, label: string): string {
  return readTextArray(properties, name, "rich_text", label);
}

function readTextArray(
  properties: Record<string, unknown>,
  name: string,
  key: string,
  label: string,
): string {
  const property = getProperty(properties, name, label);
  const value = property[key];
  if (!Array.isArray(value)) {
    throw new ContentError("INVALID_NOTION_FIELD", `${label} must be a ${key} property.`);
  }
  return value
    .map((item) => (isRecord(item) && typeof item.plain_text === "string" ? item.plain_text : ""))
    .join("");
}

function readStatus(properties: Record<string, unknown>, name: string): string {
  const property = getProperty(properties, name, "Status");
  return isRecord(property.status) && typeof property.status.name === "string"
    ? property.status.name
    : "";
}

function readDate(properties: Record<string, unknown>, name: string, label: string): string {
  const property = getProperty(properties, name, label);
  if (!isRecord(property.date) || typeof property.date.start !== "string") {
    throw new ContentError("MISSING_NOTION_FIELD", `${label} is required for published pages.`);
  }
  return property.date.start;
}

function readSelect(properties: Record<string, unknown>, name: string, label: string): string {
  const property = getProperty(properties, name, label);
  return isRecord(property.select) && typeof property.select.name === "string"
    ? property.select.name
    : "";
}

function readMultiSelect(properties: Record<string, unknown>, name: string): string[] {
  const property = getProperty(properties, name, "Tags");
  if (!Array.isArray(property.multi_select)) {
    throw new ContentError("INVALID_NOTION_FIELD", "Tags must be a multi_select property.");
  }
  return property.multi_select.map((tag) => {
    if (!isRecord(tag) || typeof tag.name !== "string" || !tag.name.trim()) {
      throw new ContentError("INVALID_NOTION_FIELD", "Tags contains a malformed option.");
    }
    return tag.name.trim();
  });
}

function getProperty(
  properties: Record<string, unknown>,
  name: string,
  label: string,
): Record<string, unknown> {
  const property = properties[name];
  if (!isRecord(property)) {
    throw new ContentError("MISSING_NOTION_FIELD", `${label} property ${name} is missing.`);
  }
  return property;
}

function normalizeNotionId(id: string): string {
  const normalized = id.replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized)) {
    throw new ContentError("INVALID_NOTION_ID", "Notion returned an invalid page ID.");
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
