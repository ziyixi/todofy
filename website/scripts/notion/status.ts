import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { siteConfig } from "../../content/site.config";
import { parseContentDate } from "../../src/lib/content/date";
import { ContentError } from "../../src/lib/content/errors";
import { sourceKeyForNotionPage } from "../../src/lib/content/hash";
import {
  hashPostContent,
  PublicationStateSchema,
  type PublicationState,
} from "../../src/lib/content/publication-state";
import type { Post } from "../../src/lib/content/schema";
import { stableStringify } from "../../src/lib/content/stable-json";
import { prepareNotionSource, validateDataSourceSchema } from "../content/adapters/notion";
import { queryAllDataSourcePages } from "../content/notion/pagination";
import type { NotionClientLike } from "../content/notion/types";

export const WEBSITE_STATUSES = [
  "未上线",
  "已同步",
  "有修改待发布",
  "待下线",
  "待定时发布",
  "检查失败",
] as const;
export type WebsiteStatus = (typeof WEBSITE_STATUSES)[number];

const feedbackTypes = {
  网站状态: "select",
  线上版本时间: "date",
  检查时间: "date",
  网站链接: "url",
  已上线指纹: "rich_text",
  "Notion 编辑时间": "last_edited_time",
} as const;

export interface StatusClient extends NotionClientLike {
  dataSources: NotionClientLike["dataSources"] & {
    update(args: { data_source_id: string; properties: Record<string, unknown> }): Promise<unknown>;
  };
  pages: {
    update(args: { page_id: string; properties: Record<string, unknown> }): Promise<unknown>;
  };
}

export interface StatusPlan {
  pageId: string;
  sourceKey: string;
  status: WebsiteStatus;
  properties: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sourceProperties(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    throw new ContentError("NOTION_STATUS_SCHEMA", "Notion data source schema is incomplete.");
  }
  return schema.properties;
}

function readSelectOptions(property: Record<string, unknown>): Record<string, unknown>[] {
  if (!isRecord(property.select) || !Array.isArray(property.select.options)) {
    throw new ContentError("NOTION_STATUS_SCHEMA", "Website status select options are invalid.");
  }
  const options = property.select.options;
  if (!options.every((option) => isRecord(option) && typeof option.name === "string")) {
    throw new ContentError("NOTION_STATUS_SCHEMA", "Website status select options are invalid.");
  }
  return options;
}

export function statusSchemaChanges(schema: unknown): Record<string, unknown> {
  validateDataSourceSchema(schema, siteConfig.notion.propertyNames);
  const properties = sourceProperties(schema);
  const changes: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(feedbackTypes)) {
    const property = properties[name];
    if (property === undefined) {
      changes[name] =
        type === "select"
          ? { select: { options: WEBSITE_STATUSES.map((option) => ({ name: option })) } }
          : { [type]: {} };
      continue;
    }
    if (!isRecord(property) || property.type !== type) {
      throw new ContentError(
        "NOTION_STATUS_SCHEMA",
        `Notion feedback property ${name} must have type ${type}.`,
      );
    }
    if (type === "select") {
      const options = readSelectOptions(property);
      const missing = WEBSITE_STATUSES.filter(
        (name) => !options.some((item) => item.name === name),
      );
      if (missing.length > 0) {
        changes[name] = {
          select: {
            options: [
              ...options.map(({ id, name, color }) => ({ id, name, color })),
              ...missing.map((name) => ({ name })),
            ],
          },
        };
      }
    }
  }
  return changes;
}

export async function setupStatusSchema(
  client: StatusClient,
  dataSourceId: string,
): Promise<number> {
  const schema = await client.dataSources.retrieve({ data_source_id: dataSourceId });
  const properties = statusSchemaChanges(schema);
  const count = Object.keys(properties).length;
  if (count > 0) {
    await client.dataSources.update({ data_source_id: dataSourceId, properties });
    const verified = await client.dataSources.retrieve({ data_source_id: dataSourceId });
    if (Object.keys(statusSchemaChanges(verified)).length > 0) {
      throw new ContentError(
        "NOTION_STATUS_SCHEMA",
        "Feedback schema update could not be verified.",
      );
    }
  }
  return count;
}

function requireFeedbackSchema(schema: unknown): void {
  if (Object.keys(statusSchemaChanges(schema)).length > 0) {
    throw new ContentError(
      "NOTION_STATUS_SCHEMA",
      "Notion feedback properties are incomplete; run --setup-schema first.",
    );
  }
}

function property(row: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  if (!isRecord(row.properties)) return undefined;
  const value = row.properties[name];
  return isRecord(value) ? value : undefined;
}

function textProperty(row: Record<string, unknown>, name: string): string {
  const value = property(row, name)?.rich_text;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (!isRecord(part)) return "";
      if (typeof part.plain_text === "string") return part.plain_text;
      return isRecord(part.text) && typeof part.text.content === "string" ? part.text.content : "";
    })
    .join("");
}

function dateProperty(row: Record<string, unknown>, name: string): string | undefined {
  const date = property(row, name)?.date;
  if (!isRecord(date) || typeof date.start !== "string") return undefined;
  return parseContentDate(date.start);
}

export function activeRows(rows: unknown[]): Record<string, unknown>[] {
  return rows.filter((row): row is Record<string, unknown> => {
    if (!isRecord(row) || typeof row.id !== "string" || !isRecord(row.properties)) {
      throw new ContentError("NOTION_STATUS_SOURCE", "Notion returned an incomplete page record.");
    }
    return row.archived !== true && row.in_trash !== true;
  });
}

function authorMetadataFingerprint(rows: unknown[]): string {
  return stableStringify(
    activeRows(rows)
      .map((row) => ({
        id: row.id,
        lastEditedTime: row.last_edited_time,
        properties: Object.fromEntries(
          Object.values(siteConfig.notion.propertyNames).map((name) => [name, property(row, name)]),
        ),
      }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id))),
  );
}

export function planStatusUpdates(options: {
  rows: unknown[];
  posts: Post[];
  production: PublicationState;
  checkedAt: Date;
  confirmedAt?: Date;
}): StatusPlan[] {
  const production = PublicationStateSchema.parse(options.production);
  const liveByKey = new Map(production.posts.map((post) => [post.sourceKey, post]));
  const currentByKey = new Map(options.posts.map((post) => [post.sourceKey, post]));
  const checkedAt = options.checkedAt.toISOString();
  const confirmedAt = (options.confirmedAt ?? options.checkedAt).toISOString();
  if (confirmedAt > checkedAt) {
    throw new ContentError("NOTION_STATUS_TIME", "Confirmation time must not be in the future.");
  }
  return activeRows(options.rows).map((row) => {
    const pageId = String(row.id);
    const sourceKey = sourceKeyForNotionPage(pageId);
    const live = liveByKey.get(sourceKey);
    const current = currentByKey.get(sourceKey);
    const notionStatus = property(row, siteConfig.notion.propertyNames.status)?.status;
    const authorStatus = isRecord(notionStatus) ? notionStatus.name : undefined;
    let status: WebsiteStatus;
    if (authorStatus === "Draft") {
      status = live ? "待下线" : "未上线";
    } else if (authorStatus === "Published") {
      const publishedAt = dateProperty(row, siteConfig.notion.propertyNames.publishedAt);
      if (!publishedAt) {
        throw new ContentError("NOTION_STATUS_SOURCE", "Published page has no publication date.");
      }
      if (publishedAt > checkedAt) {
        status = live ? "待下线" : "待定时发布";
      } else if (!current) {
        status = "检查失败";
      } else if (!live) {
        status = "未上线";
      } else {
        status = hashPostContent(current) === live.contentHash ? "已同步" : "有修改待发布";
      }
    } else {
      throw new ContentError("NOTION_STATUS_SOURCE", "Author Status must be Draft or Published.");
    }

    const oldFingerprint = textProperty(row, "已上线指纹");
    const oldVersionTime = dateProperty(row, "线上版本时间");
    const versionTime = live
      ? oldFingerprint === live.contentHash && oldVersionTime
        ? oldVersionTime
        : confirmedAt
      : undefined;
    return {
      pageId,
      sourceKey,
      status,
      properties: {
        网站状态: { select: { name: status } },
        线上版本时间: { date: versionTime ? { start: versionTime } : null },
        检查时间: { date: { start: checkedAt } },
        网站链接: { url: live ? `${siteConfig.canonicalOrigin}/blog/${live.slug}` : null },
        已上线指纹: {
          rich_text: live ? [{ type: "text", text: { content: live.contentHash } }] : [],
        },
      },
    };
  });
}

async function fetchPublicJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { "Cache-Control": "no-cache, no-store", Pragma: "no-cache" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new ContentError(
      "PRODUCTION_STATUS_UNAVAILABLE",
      "Public production metadata is unavailable.",
    );
  }
  const body = await response.text();
  if (body.length > 2_000_000) {
    throw new ContentError(
      "PRODUCTION_STATUS_INVALID",
      "Public production metadata exceeds the limit.",
    );
  }
  return JSON.parse(body) as unknown;
}

export async function readProductionState(
  fetchImpl: typeof fetch = fetch,
): Promise<PublicationState> {
  const origin = siteConfig.canonicalOrigin;
  const before = await fetchPublicJson(`${origin}/build-info.json`, fetchImpl);
  const state = PublicationStateSchema.parse(
    await fetchPublicJson(`${origin}/publication-state.json`, fetchImpl),
  );
  const after = await fetchPublicJson(`${origin}/build-info.json`, fetchImpl);
  const identity = stableStringify(state.identity);
  if (stableStringify(before) !== identity || stableStringify(after) !== identity) {
    throw new ContentError(
      "PRODUCTION_STATUS_CHANGED",
      "Production metadata changed or disagrees; no Notion status was updated.",
    );
  }
  return state;
}

export interface SyncStatusOptions {
  client: StatusClient;
  token: string;
  dataSourceId: string;
  apiVersion: string;
  checkedAt?: Date;
  confirmedAt?: Date;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
}

export async function syncNotionStatus(options: SyncStatusOptions): Promise<{
  checked: number;
  written: number;
  failed: number;
  statuses: Partial<Record<WebsiteStatus, number>>;
}> {
  const checkedAt = options.checkedAt ?? new Date();
  const production = await readProductionState(options.fetchImpl);
  const schema = await options.client.dataSources.retrieve({
    data_source_id: options.dataSourceId,
  });
  requireFeedbackSchema(schema);
  const initialRows = await queryAllDataSourcePages(options.client, options.dataSourceId);
  const directory = await mkdtemp(path.join(tmpdir(), "ziyixi-notion-status-"));
  let currentPosts: Post[];
  try {
    const prepared = await prepareNotionSource(
      { cutoff: checkedAt, publicDirectory: directory },
      {
        token: options.token,
        dataSourceId: options.dataSourceId,
        apiVersion: options.apiVersion,
        propertyNames: siteConfig.notion.propertyNames,
        client: options.client,
      },
    );
    currentPosts = prepared.posts;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const finalRows = await queryAllDataSourcePages(options.client, options.dataSourceId);
  if (authorMetadataFingerprint(initialRows) !== authorMetadataFingerprint(finalRows)) {
    throw new ContentError(
      "NOTION_CHANGED_DURING_STATUS_CHECK",
      "Notion changed during the status check; no status was updated. Run the check again.",
    );
  }
  const verifiedProduction = await readProductionState(options.fetchImpl);
  if (stableStringify(production) !== stableStringify(verifiedProduction)) {
    throw new ContentError(
      "PRODUCTION_STATUS_CHANGED",
      "Production changed during the status check; no Notion status was updated.",
    );
  }
  // Plan all rows before the first write. A late validation failure cannot leave
  // a partially validated set of source records marked synchronized.
  const plans = planStatusUpdates({
    rows: finalRows,
    posts: currentPosts,
    production,
    checkedAt,
    confirmedAt: options.confirmedAt,
  });
  const result = { checked: plans.length, written: 0, failed: 0, statuses: {} } as {
    checked: number;
    written: number;
    failed: number;
    statuses: Partial<Record<WebsiteStatus, number>>;
  };
  for (const plan of plans) {
    result.statuses[plan.status] = (result.statuses[plan.status] ?? 0) + 1;
    if (plan.status === "检查失败") result.failed += 1;
    if (options.dryRun) continue;
    try {
      await options.client.pages.update({ page_id: plan.pageId, properties: plan.properties });
      result.written += 1;
    } catch {
      // Never replace a previously confirmed live timestamp/hash with an error
      // record, and never roll back a healthy website because feedback failed.
      if (plan.status !== "检查失败") result.failed += 1;
    }
  }
  return result;
}
