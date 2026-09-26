import { describe, expect, it, vi } from "vitest";

import {
  planStatusUpdates,
  readProductionState,
  setupStatusSchema,
  statusSchemaChanges,
  syncNotionStatus,
  WEBSITE_STATUSES,
  type StatusClient,
} from "../../scripts/notion/status";
import { hashContentSnapshot, sourceKeyForNotionPage } from "../../src/lib/content/hash";
import {
  createPublicationState,
  hashPostContent,
  type PublicationState,
} from "../../src/lib/content/publication-state";
import { CONTENT_SCHEMA_VERSION, type Post } from "../../src/lib/content/schema";

const checkedAt = new Date("2026-09-25T12:00:00Z");
const pageId = "0123456789abcdef0123456789abcdef";
const otherPageId = "abcdef0123456789abcdef0123456789";

function post(id = pageId): Post {
  const sourceKey = sourceKeyForNotionPage(id);
  return {
    sourceKey,
    feedGuid: `urn:ziyixi:post:${sourceKey}`,
    slug: id === pageId ? "test-note" : "second-note",
    title: "Test note",
    summary: "A test summary.",
    language: "en",
    publishedAt: "2026-01-01T00:00:00.000Z",
    tags: [],
    blocks: [],
    toc: [],
    media: [],
  };
}

function production(posts = [post()]): PublicationState {
  const snapshot = {
    schemaVersion: CONTENT_SCHEMA_VERSION,
    sourceMode: "notion" as const,
    posts,
    media: [],
    redirects: [],
  };
  return createPublicationState(snapshot, {
    codeSha: "a".repeat(40),
    contentHash: hashContentSnapshot(snapshot),
    configHash: "b".repeat(64),
    schemaVersion: CONTENT_SCHEMA_VERSION,
  });
}

function row(
  options: {
    id?: string;
    authorStatus?: string;
    date?: string;
    liveHash?: string;
    liveTime?: string;
    lastEditedTime?: string;
  } = {},
): Record<string, unknown> {
  const current = post(options.id ?? pageId);
  return {
    id: options.id ?? pageId,
    last_edited_time: options.lastEditedTime ?? "2026-09-01T12:00:00.000Z",
    properties: {
      Title: { title: [{ plain_text: current.title }] },
      Slug: { rich_text: [{ plain_text: current.slug }] },
      Status: { status: { name: options.authorStatus ?? "Published" } },
      PublishedAt: { date: { start: options.date ?? current.publishedAt } },
      Summary: { rich_text: [{ plain_text: current.summary }] },
      Language: { select: { name: "en" } },
      Tags: { multi_select: [] },
      已上线指纹: { rich_text: [{ plain_text: options.liveHash ?? "" }] },
      线上版本时间: { date: options.liveTime ? { start: options.liveTime } : null },
    },
  };
}

function schema(includeFeedback = true): { properties: Record<string, unknown> } {
  const properties: Record<string, unknown> = {
    Title: { type: "title" },
    Slug: { type: "rich_text" },
    Status: { type: "status" },
    PublishedAt: { type: "date" },
    Summary: { type: "rich_text" },
    Language: { type: "select" },
    Tags: { type: "multi_select" },
  };
  if (includeFeedback) {
    Object.assign(properties, {
      网站状态: {
        type: "select",
        select: {
          options: WEBSITE_STATUSES.map((name, id) => ({ name, id: String(id), color: "default" })),
        },
      },
      线上版本时间: { type: "date" },
      检查时间: { type: "date" },
      网站链接: { type: "url" },
      已上线指纹: { type: "rich_text" },
      "Notion 编辑时间": { type: "last_edited_time" },
    });
  }
  return { properties };
}

function client(rows = [row()]) {
  return {
    dataSources: {
      retrieve: vi.fn().mockResolvedValue(schema()),
      query: vi.fn().mockImplementation(async () => ({
        results: structuredClone(rows),
        has_more: false,
        next_cursor: null,
      })),
      update: vi.fn().mockResolvedValue({}),
    },
    blocks: {
      children: {
        list: vi.fn().mockResolvedValue({ results: [], has_more: false, next_cursor: null }),
      },
    },
    pages: { update: vi.fn().mockResolvedValue({}) },
  } satisfies StatusClient;
}

function publicFetch(state = production()) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const pathname = new URL(String(input)).pathname;
    return Response.json(pathname === "/build-info.json" ? state.identity : state);
  });
}

function options(notion = client()) {
  return {
    client: notion,
    token: "test-only-secret",
    dataSourceId: "test-data-source",
    apiVersion: "2026-03-11",
    checkedAt,
    fetchImpl: publicFetch(),
  };
}

describe("Notion publication feedback classification", () => {
  it.each([
    { authorStatus: "Draft", online: false, expected: "未上线" },
    { authorStatus: "Draft", online: true, expected: "待下线" },
    { authorStatus: "Published", online: false, expected: "未上线" },
    { authorStatus: "Published", online: true, expected: "已同步" },
    { authorStatus: "Published", online: false, date: "2027-01-01", expected: "待定时发布" },
    { authorStatus: "Published", online: true, date: "2027-01-01", expected: "待下线" },
  ])("classifies $authorStatus / online=$online / $date as $expected", (scenario) => {
    const [plan] = planStatusUpdates({
      rows: [row(scenario)],
      posts: [post()],
      production: production(scenario.online ? [post()] : []),
      checkedAt,
    });
    expect(plan?.status).toBe(scenario.expected);
    expect(plan?.properties).not.toHaveProperty("Status");
    expect(plan?.properties).not.toHaveProperty("Notion 编辑时间");
  });

  it("finds authored changes using normalized content rather than last_edited_time", () => {
    const changed = { ...post(), title: "Edited after deployment" };
    const [plan] = planStatusUpdates({
      rows: [row()],
      posts: [changed],
      production: production(),
      checkedAt,
    });
    expect(plan?.status).toBe("有修改待发布");
    expect(plan?.properties.已上线指纹).toEqual({
      rich_text: [{ type: "text", text: { content: hashPostContent(post()) } }],
    });
  });

  it("preserves the live-version date despite later record edits or a code-only deployment", () => {
    const previousTime = "2026-09-10T10:00:00.000Z";
    const [plan] = planStatusUpdates({
      rows: [
        row({
          liveHash: hashPostContent(post()),
          liveTime: previousTime,
          lastEditedTime: "2026-09-25T11:59:00.000Z",
        }),
      ],
      posts: [post()],
      production: production(),
      checkedAt,
      confirmedAt: new Date("2026-09-25T11:50:00Z"),
    });
    expect(plan?.status).toBe("已同步");
    expect(plan?.properties.线上版本时间).toEqual({ date: { start: previousTime } });
  });

  it("uses the supplied confirmation time only for a newly observed live content version", () => {
    const confirmedAt = new Date("2026-09-25T11:50:00Z");
    const [plan] = planStatusUpdates({
      rows: [row({ liveHash: "c".repeat(64), liveTime: "2026-09-10T10:00:00Z" })],
      posts: [post()],
      production: production(),
      checkedAt,
      confirmedAt,
    });
    expect(plan?.properties.线上版本时间).toEqual({ date: { start: confirmedAt.toISOString() } });
  });

  it("uses first observation time at initial setup and clears live fields after withdrawal", () => {
    const [first] = planStatusUpdates({
      rows: [row()],
      posts: [post()],
      production: production(),
      checkedAt,
    });
    expect(first?.properties.线上版本时间).toEqual({ date: { start: checkedAt.toISOString() } });
    const [withdrawn] = planStatusUpdates({
      rows: [
        row({
          authorStatus: "Draft",
          liveHash: hashPostContent(post()),
          liveTime: "2026-09-10T10:00:00Z",
        }),
      ],
      posts: [],
      production: production([]),
      checkedAt,
    });
    expect(withdrawn?.properties.线上版本时间).toEqual({ date: null });
    expect(withdrawn?.properties.网站链接).toEqual({ url: null });
    expect(withdrawn?.properties.已上线指纹).toEqual({ rich_text: [] });
  });

  it("uses the online slug when a Notion slug edit is still unpublished", () => {
    const [plan] = planStatusUpdates({
      rows: [row()],
      posts: [{ ...post(), slug: "new-slug" }],
      production: production(),
      checkedAt,
    });
    expect(plan?.status).toBe("有修改待发布");
    expect(plan?.properties.网站链接).toEqual({ url: "https://www.ziyixi.science/blog/test-note" });
  });

  it("never guesses synchronized when an eligible article is missing from normalized results", () => {
    const [plan] = planStatusUpdates({
      rows: [row()],
      posts: [],
      production: production(),
      checkedAt,
    });
    expect(plan?.status).toBe("检查失败");
  });
});

describe("Notion feedback schema", () => {
  it("adds only the six feedback columns and is idempotent", async () => {
    const notion = client();
    notion.dataSources.retrieve.mockResolvedValueOnce(schema(false)).mockResolvedValue(schema());
    expect(await setupStatusSchema(notion, "source")).toBe(6);
    expect(notion.dataSources.update.mock.calls[0]?.[0].properties).toEqual(
      statusSchemaChanges(schema(false)),
    );
    expect(await setupStatusSchema(notion, "source")).toBe(0);
    expect(notion.dataSources.update).toHaveBeenCalledTimes(1);
  });

  it("fails before any schema update when an existing feedback type differs", async () => {
    const notion = client();
    const incorrect = schema();
    incorrect.properties.网站状态 = { type: "status" };
    notion.dataSources.retrieve.mockResolvedValue(incorrect);
    await expect(setupStatusSchema(notion, "source")).rejects.toMatchObject({
      code: "NOTION_STATUS_SCHEMA",
    });
    expect(notion.dataSources.update).not.toHaveBeenCalled();
  });

  it("preserves preexisting custom select options when adding missing system options", () => {
    const partial = schema();
    partial.properties.网站状态 = {
      type: "select",
      select: { options: [{ id: "custom", name: "旧标记", color: "blue" }] },
    };
    expect(statusSchemaChanges(partial)).toMatchObject({
      网站状态: {
        select: {
          options: expect.arrayContaining([
            { id: "custom", name: "旧标记", color: "blue" },
            { name: "已同步" },
          ]),
        },
      },
    });
  });
});

describe("production state consistency", () => {
  it("reads only the canonical public origin without credentials or redirects", async () => {
    const fetchImpl = publicFetch();
    await expect(readProductionState(fetchImpl)).resolves.toEqual(production());
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [input, init] of fetchImpl.mock.calls) {
      expect(new URL(String(input)).origin).toBe("https://www.ziyixi.science");
      expect(init?.headers).not.toHaveProperty("Authorization");
      expect(init?.cache).toBe("no-store");
      expect(init?.redirect).toBe("error");
    }
  });

  it("rejects a mixed deployment rather than writing stale statuses", async () => {
    const state = production();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(state.identity))
      .mockResolvedValueOnce(Response.json(state))
      .mockResolvedValueOnce(Response.json({ ...state.identity, codeSha: "d".repeat(40) }));
    await expect(readProductionState(fetchImpl)).rejects.toMatchObject({
      code: "PRODUCTION_STATUS_CHANGED",
    });
  });
});

describe("status synchronization boundaries", () => {
  it("uses the existing real Notion normalizer and completes all reads before writing feedback only", async () => {
    const notion = client();
    const configuration = options(notion);
    notion.pages.update.mockImplementation(async () => {
      expect(configuration.fetchImpl).toHaveBeenCalledTimes(6);
      expect(notion.dataSources.query).toHaveBeenCalledTimes(4);
      return {};
    });
    const result = await syncNotionStatus(configuration);
    expect(result).toEqual({ checked: 1, written: 1, failed: 0, statuses: { 已同步: 1 } });
    expect(notion.blocks.children.list).toHaveBeenCalledTimes(1);
    expect(Object.keys(notion.pages.update.mock.calls[0]?.[0].properties)).toEqual([
      "网站状态",
      "线上版本时间",
      "检查时间",
      "网站链接",
      "已上线指纹",
    ]);
  });

  it("performs a dry run without schema or page mutations", async () => {
    const notion = client();
    expect(await syncNotionStatus({ ...options(notion), dryRun: true })).toMatchObject({
      checked: 1,
      written: 0,
    });
    expect(notion.pages.update).not.toHaveBeenCalled();
    expect(notion.dataSources.update).not.toHaveBeenCalled();
  });

  it("writes nothing if content conversion fails", async () => {
    const notion = client();
    notion.blocks.children.list.mockRejectedValue(new Error("private upstream details"));
    await expect(syncNotionStatus(options(notion))).rejects.toThrow();
    expect(notion.pages.update).not.toHaveBeenCalled();
  });

  it("writes nothing when author content changes during the complete read", async () => {
    const notion = client();
    let queries = 0;
    notion.dataSources.query.mockImplementation(async () => ({
      results: [row({ lastEditedTime: ++queries === 4 ? "2026-09-25T11:59:00Z" : undefined })],
      has_more: false,
      next_cursor: null,
    }));
    await expect(syncNotionStatus(options(notion))).rejects.toMatchObject({
      code: "NOTION_CHANGED_DURING_STATUS_CHECK",
    });
    expect(notion.pages.update).not.toHaveBeenCalled();
  });

  it("writes nothing if production moves after Notion was normalized", async () => {
    const notion = client();
    const state = production();
    const newer = { ...state, identity: { ...state.identity, codeSha: "d".repeat(40) } };
    let requests = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const result = ++requests <= 3 ? state : newer;
      return Response.json(String(input).endsWith("/build-info.json") ? result.identity : result);
    });
    await expect(syncNotionStatus({ ...options(notion), fetchImpl })).rejects.toMatchObject({
      code: "PRODUCTION_STATUS_CHANGED",
    });
    expect(notion.pages.update).not.toHaveBeenCalled();
  });

  it("keeps failed writes isolated, returns failure counts, and never tries website rollback", async () => {
    const notion = client([row(), row({ id: otherPageId })]);
    notion.pages.update
      .mockRejectedValueOnce(new Error("Notion unavailable"))
      .mockResolvedValueOnce({});
    const result = await syncNotionStatus({
      ...options(notion),
      fetchImpl: publicFetch(production([post(), post(otherPageId)])),
    });
    expect(result).toMatchObject({ checked: 2, written: 1, failed: 1 });
    expect(notion.pages.update).toHaveBeenCalledTimes(2);
  });

  it("does not misclassify its own feedback edits as new article content", async () => {
    const notion = client([
      row({
        lastEditedTime: "2026-09-25T11:59:00Z",
        liveHash: hashPostContent(post()),
        liveTime: "2026-09-20T10:00:00Z",
      }),
    ]);
    const result = await syncNotionStatus(options(notion));
    expect(result.statuses).toEqual({ 已同步: 1 });
    expect(notion.pages.update.mock.calls[0]?.[0].properties.线上版本时间).toEqual({
      date: { start: "2026-09-20T10:00:00.000Z" },
    });
  });
});
