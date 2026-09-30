import { describe, expect, it } from "vitest";

import { fetchBlockTree, queryAllDataSourcePages } from "../../scripts/content/notion/pagination";
import type { NotionClientLike, PaginatedResponse } from "../../scripts/content/notion/types";

function clientWith(options: {
  query: (cursor?: string) => Promise<PaginatedResponse>;
  blocks?: (id: string, cursor?: string) => Promise<PaginatedResponse>;
}): NotionClientLike {
  return {
    dataSources: {
      retrieve: async () => ({}),
      query: async (args) => options.query(args.start_cursor),
    },
    blocks: {
      children: {
        list: async (args) =>
          options.blocks?.(args.block_id, args.start_cursor) ?? {
            results: [],
            has_more: false,
            next_cursor: null,
          },
      },
    },
  };
}

describe("Notion cursor traversal", () => {
  it("uses has_more and next_cursor rather than page length", async () => {
    const client = clientWith({
      query: async (cursor) =>
        cursor
          ? { results: [{ id: "second" }], has_more: false, next_cursor: null }
          : { results: [{ id: "first" }], has_more: true, next_cursor: "next" },
    });
    await expect(queryAllDataSourcePages(client, "source")).resolves.toEqual([
      { id: "first" },
      { id: "second" },
    ]);
  });

  it("rejects a response explicitly marked incomplete", async () => {
    const client = clientWith({
      query: async () => ({
        results: [{ id: "partial" }],
        has_more: false,
        next_cursor: null,
        request_status: { type: "incomplete" },
      }),
    });
    await expect(queryAllDataSourcePages(client, "source")).rejects.toThrow(/incomplete/);
  });

  it("recursively retrieves children", async () => {
    const client = clientWith({
      query: async () => ({ results: [], has_more: false, next_cursor: null }),
      blocks: async (id) => {
        if (id === "page") {
          return {
            results: [{ id: "parent", type: "toggle", has_children: true }],
            has_more: false,
            next_cursor: null,
          };
        }
        return {
          results: [{ id: "child", type: "paragraph", has_children: false }],
          has_more: false,
          next_cursor: null,
        };
      },
    });
    const tree = await fetchBlockTree(client, "page");
    expect(tree[0]?.children[0]?.block.id).toBe("child");
  });
});
