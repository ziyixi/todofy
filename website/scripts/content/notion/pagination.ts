import { ContentError } from "../../../src/lib/content/errors";
import type { NotionBlockNode, NotionClientLike, PaginatedResponse } from "./types";

const DEFAULT_MAX_PAGES = 1_000;
const DEFAULT_MAX_BLOCKS = 20_000;

export async function queryAllDataSourcePages(
  client: NotionClientLike,
  dataSourceId: string,
  maxPages = DEFAULT_MAX_PAGES,
): Promise<unknown[]> {
  return collectCursorPages(
    (cursor) =>
      client.dataSources.query({
        data_source_id: dataSourceId,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    maxPages,
    "data source query",
  );
}

export async function fetchBlockTree(
  client: NotionClientLike,
  pageId: string,
  maxBlocks = DEFAULT_MAX_BLOCKS,
): Promise<NotionBlockNode[]> {
  let count = 0;

  async function visit(parentId: string): Promise<NotionBlockNode[]> {
    const blocks = await collectCursorPages(
      (cursor) =>
        client.blocks.children.list({
          block_id: parentId,
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      DEFAULT_MAX_PAGES,
      `blocks.children for ${parentId}`,
    );
    const nodes: NotionBlockNode[] = [];
    for (const rawBlock of blocks) {
      if (!isRecord(rawBlock) || typeof rawBlock.id !== "string") {
        throw new ContentError("INVALID_NOTION_BLOCK", "Notion returned a block without an ID.");
      }
      count += 1;
      if (count > maxBlocks) {
        throw new ContentError(
          "NOTION_BLOCK_LIMIT",
          `Block traversal exceeded the safety limit of ${maxBlocks}.`,
          { pageId },
        );
      }
      const children = rawBlock.has_children === true ? await visit(rawBlock.id) : [];
      nodes.push({ block: rawBlock, children });
    }
    return nodes;
  }

  return visit(pageId);
}

async function collectCursorPages(
  request: (cursor?: string) => Promise<PaginatedResponse>,
  maxPages: number,
  operation: string,
): Promise<unknown[]> {
  const results: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await request(cursor);
    if (response.request_status?.type === "incomplete") {
      throw new ContentError(
        "INCOMPLETE_NOTION_RESPONSE",
        `Notion marked ${operation} as incomplete.`,
      );
    }
    if (!Array.isArray(response.results) || typeof response.has_more !== "boolean") {
      throw new ContentError("INVALID_NOTION_RESPONSE", `Malformed response from ${operation}.`);
    }
    results.push(...response.results);
    if (!response.has_more) return results;
    if (!response.next_cursor) {
      throw new ContentError(
        "INVALID_NOTION_CURSOR",
        `${operation} reported more results without a cursor.`,
      );
    }
    if (seenCursors.has(response.next_cursor)) {
      throw new ContentError("NOTION_CURSOR_LOOP", `${operation} repeated a cursor.`);
    }
    seenCursors.add(response.next_cursor);
    cursor = response.next_cursor;
  }
  throw new ContentError(
    "NOTION_PAGE_LIMIT",
    `${operation} exceeded the pagination safety limit of ${maxPages}.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
