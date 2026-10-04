import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@notionhq/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareNotionSource } from "../../scripts/content/adapters/notion";
import type { NotionClientLike, PaginatedResponse } from "../../scripts/content/notion/types";
import { prepareContent } from "../../scripts/content/prepare";
import { sourceKeyForNotionPage } from "../../src/lib/content/hash";
import { readContentBundle } from "../../src/lib/content/reader";
import type { ContentRegistry } from "../../src/lib/content/schema";

vi.mock("@notionhq/client", () => ({ Client: vi.fn() }));

const sourceId = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const firstId = "11111111111111111111111111111111";
const secondId = "22222222222222222222222222222222";
const cutoff = new Date("2026-10-04T00:00:00Z");
const directories: string[] = [];

function row(id: string, status = "Draft", extra: Record<string, unknown> = {}) {
  return {
    object: "page",
    id,
    parent: { type: "data_source_id", data_source_id: sourceId },
    last_edited_time: "2026-10-03T12:00:00.000Z",
    properties: {
      Title: { title: [{ plain_text: "Synthetic article" }] },
      Slug: { rich_text: [{ plain_text: `article-${id[0]}` }] },
      Status: { status: { name: status } },
      PublishedAt: { date: { start: "2026-01-01" } },
      Summary: { rich_text: [{ plain_text: "Synthetic summary." }] },
      Language: { select: { name: "en" } },
      Tags: { multi_select: [] },
    },
    ...extra,
  };
}

function response(results: unknown[]): PaginatedResponse {
  return { results, has_more: false, next_cursor: null };
}

function source() {
  return {
    object: "data_source",
    id: sourceId,
    in_trash: false,
    properties: {
      Title: { type: "title" },
      Slug: { type: "rich_text" },
      Status: { type: "status" },
      PublishedAt: { type: "date" },
      Summary: { type: "rich_text" },
      Language: { type: "select" },
      Tags: { type: "multi_select" },
    },
  };
}

function client(active: unknown[], archived: unknown[] = []) {
  return {
    dataSources: {
      retrieve: vi.fn(async () => source()),
      query: vi.fn(async () => response(active)),
    },
    request: vi.fn(async () => response(archived)),
    blocks: {
      children: { list: vi.fn(async () => response([])) },
    },
  };
}

function baseline(ids = [firstId, secondId]): ContentRegistry {
  return {
    registryVersion: 1,
    articleCount: ids.length,
    posts: ids.map((id) => {
      const sourceKey = sourceKeyForNotionPage(id);
      return {
        sourceKey,
        currentSlug: `article-${id[0]}`,
        historicalSlugs: [],
        feedGuid: `urn:ziyixi:post:${sourceKey}`,
        published: true,
      };
    }),
  };
}

async function prepare(mock: NotionClientLike, keys = [firstId, secondId]) {
  const directory = await mkdtemp(path.join(tmpdir(), "notion-withdrawal-"));
  directories.push(directory);
  return prepareNotionSource(
    { cutoff, publicDirectory: directory },
    {
      token: "synthetic-token",
      dataSourceId: sourceId,
      apiVersion: "2026-03-11",
      previousPublishedKeys: keys.map(sourceKeyForNotionPage),
      client: mock,
    },
  );
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("explicit withdrawal of the complete public collection", () => {
  it("confirms all previous articles are Draft without querying archives", async () => {
    const mock = client([row(firstId), row(secondId)]);
    await expect(prepare(mock)).resolves.toMatchObject({
      posts: [],
      emptyCollectionConfirmed: true,
    });
    expect(mock.request).not.toHaveBeenCalled();
    expect(mock.dataSources.query).toHaveBeenCalledTimes(2);
  });

  it("matches normalized page IDs rather than slugs or draft counts", async () => {
    const dashed = "11111111-1111-1111-1111-111111111111";
    await expect(prepare(client([row(dashed)]), [firstId])).resolves.toMatchObject({
      emptyCollectionConfirmed: true,
    });
    await expect(prepare(client([row(secondId)]), [firstId])).rejects.toMatchObject({
      code: "UNCONFIRMED_EMPTY_COLLECTION",
    });
  });

  it("confirms mixed Draft and archived withdrawals through the SDK request path", async () => {
    const mock = client([row(firstId)], [row(secondId, "Published", { is_archived: true })]);
    await expect(prepare(mock)).resolves.toMatchObject({
      posts: [],
      emptyCollectionConfirmed: true,
    });
    expect(mock.request).toHaveBeenCalledTimes(2);
    expect(mock.request).toHaveBeenCalledWith({
      path: `data_sources/${sourceId}/query`,
      method: "post",
      body: { page_size: 100, is_archived: true },
    });
  });

  it("confirms the archived final article and preserves an empty snapshot", async () => {
    const mock = client([], [row(firstId, "Published", { is_archived: true })]);
    await expect(prepare(mock, [firstId])).resolves.toMatchObject({
      posts: [],
      emptyCollectionConfirmed: true,
    });
  });

  it.each([{ in_trash: true }, { archived: true }, { is_archived: true }])(
    "accepts an explicit withdrawal flag returned by the current source: %j",
    async (flag) => {
      await expect(
        prepare(client([row(firstId, "Published", flag)]), [firstId]),
      ).resolves.toMatchObject({ emptyCollectionConfirmed: true });
    },
  );

  it("does not infer withdrawal from missing rows or a date moved into the future", async () => {
    await expect(prepare(client([]), [firstId])).rejects.toMatchObject({
      code: "UNCONFIRMED_EMPTY_COLLECTION",
    });
    const future = row(firstId, "Published");
    future.properties.PublishedAt.date.start = "2027-01-01";
    await expect(prepare(client([future]), [firstId])).rejects.toMatchObject({
      code: "UNCONFIRMED_EMPTY_COLLECTION",
    });
  });

  it("rejects a response from a different source and Draft rows with a different parent", async () => {
    const wrongSource = client([row(firstId)]);
    wrongSource.dataSources.retrieve.mockResolvedValue({ ...source(), id: secondId });
    await expect(prepare(wrongSource, [firstId])).rejects.toMatchObject({
      code: "NOTION_WITHDRAWAL_SOURCE_MISMATCH",
    });
    await expect(
      prepare(
        client([
          row(firstId, "Draft", { parent: { type: "data_source_id", data_source_id: secondId } }),
        ]),
        [firstId],
      ),
    ).rejects.toMatchObject({ code: "NOTION_WITHDRAWAL_SOURCE_MISMATCH" });
  });

  it("rejects malformed and duplicate withdrawal identities", async () => {
    await expect(prepare(client([row(firstId), row(firstId)]), [firstId])).rejects.toMatchObject({
      code: "INVALID_NOTION_PAGE",
    });
    await expect(
      prepare(client([row(firstId, "Draft", { last_edited_time: "invalid" })]), [firstId]),
    ).rejects.toMatchObject({ code: "INVALID_NOTION_PAGE" });
    await expect(prepare(client([row("invalid-id")]), [firstId])).rejects.toMatchObject({
      code: "INVALID_NOTION_PAGE",
    });
  });

  it("does not withdraw content when the data source itself was trashed", async () => {
    const mock = client([row(firstId)]);
    mock.dataSources.retrieve.mockResolvedValue({ ...source(), in_trash: true });
    await expect(prepare(mock, [firstId])).rejects.toMatchObject({
      code: "NOTION_WITHDRAWAL_SOURCE_MISMATCH",
    });
  });

  it("rejects an archived article belonging to another data source", async () => {
    const archived = row(firstId, "Published", {
      is_archived: true,
      parent: { type: "data_source_id", data_source_id: secondId },
    });
    await expect(prepare(client([], [archived]), [firstId])).rejects.toMatchObject({
      code: "NOTION_WITHDRAWAL_SOURCE_MISMATCH",
    });
  });

  it("does not trust a non-archived result from the archive query", async () => {
    await expect(prepare(client([], [row(firstId, "Published")]), [firstId])).rejects.toMatchObject(
      { code: "INVALID_NOTION_PAGE" },
    );
  });

  it("propagates an archive permission failure without accepting empty content", async () => {
    const mock = client([]);
    mock.request.mockRejectedValue({ status: 403, code: "restricted_resource" });
    await expect(prepare(mock, [firstId])).rejects.toMatchObject({ status: 403 });
  });

  it("does not convert an active-source permission failure into a withdrawal", async () => {
    const mock = client([]);
    mock.dataSources.query.mockRejectedValue({ status: 404, code: "object_not_found" });
    await expect(prepare(mock, [firstId])).rejects.toMatchObject({ status: 404 });
    expect(mock.request).not.toHaveBeenCalled();
  });

  it("rejects incomplete archive responses and invalid pagination", async () => {
    const incomplete = client([]);
    incomplete.request.mockResolvedValue({
      ...response([row(firstId, "Published", { is_archived: true })]),
      request_status: { type: "incomplete" },
    });
    await expect(prepare(incomplete, [firstId])).rejects.toMatchObject({
      code: "INCOMPLETE_NOTION_RESPONSE",
    });
    const badCursor = client([]);
    badCursor.request.mockResolvedValue({ ...response([]), has_more: true });
    await expect(prepare(badCursor, [firstId])).rejects.toMatchObject({
      code: "INVALID_NOTION_CURSOR",
    });
  });

  it("completes archived pagination before using the proof", async () => {
    const mock = client([]);
    mock.request
      .mockResolvedValueOnce({
        results: [row(firstId, "Published", { is_archived: true })],
        has_more: true,
        next_cursor: "next",
      })
      .mockResolvedValueOnce(response([row(secondId, "Published", { is_archived: true })]))
      .mockResolvedValueOnce({
        results: [row(firstId, "Published", { is_archived: true })],
        has_more: true,
        next_cursor: "next",
      })
      .mockResolvedValueOnce(response([row(secondId, "Published", { is_archived: true })]));
    await expect(prepare(mock)).resolves.toMatchObject({ emptyCollectionConfirmed: true });
    expect(mock.request).toHaveBeenCalledWith({
      path: `data_sources/${sourceId}/query`,
      method: "post",
      body: { page_size: 100, is_archived: true, start_cursor: "next" },
    });
  });

  it("rejects a Draft article disappearing during verification", async () => {
    const mock = client([]);
    mock.dataSources.query.mockResolvedValueOnce(response([row(firstId)]));
    await expect(prepare(mock, [firstId])).rejects.toMatchObject({
      code: "UNCONFIRMED_EMPTY_COLLECTION",
    });
  });

  it("checks the edit time of Draft withdrawal evidence again before accepting it", async () => {
    const mock = client([row(firstId, "Draft", { last_edited_time: "2026-10-03T13:00:00.000Z" })]);
    mock.dataSources.query.mockResolvedValueOnce(response([row(firstId)]));
    await expect(prepare(mock, [firstId])).rejects.toMatchObject({
      code: "NOTION_CHANGED_DURING_SYNC",
    });
  });

  it("rejects archive evidence that disappears during verification", async () => {
    const mock = client([]);
    mock.request.mockResolvedValueOnce(
      response([row(firstId, "Published", { is_archived: true })]),
    );
    await expect(prepare(mock, [firstId])).rejects.toMatchObject({
      code: "UNCONFIRMED_EMPTY_COLLECTION",
    });
  });

  it("retries when a withdrawn article is restored during synchronization", async () => {
    const restored = row(firstId, "Published");
    const mock = client([restored]);
    mock.dataSources.query.mockResolvedValueOnce(response([row(firstId)]));
    await expect(prepare(mock, [firstId])).resolves.toMatchObject({
      posts: [{ slug: "article-1" }],
    });
  });

  it("does not extend the complete-collection guard to an ordinary partial withdrawal", async () => {
    const mock = client([row(firstId, "Published")]);
    const result = await prepare(mock);
    expect(result.posts).toHaveLength(1);
    expect(result.emptyCollectionConfirmed).toBeUndefined();
    expect(mock.request).not.toHaveBeenCalled();
  });

  it("passes confirmed empty content through the registry and route contract without publishing proof metadata", async () => {
    const mock = client([row(firstId)]);
    vi.mocked(Client).mockImplementation(function () {
      return mock as unknown as Client;
    });
    const directory = await mkdtemp(path.join(tmpdir(), "notion-withdrawal-bundle-"));
    directories.push(directory);
    const outputDirectory = path.join(directory, "content");
    const manifest = await prepareContent({
      source: "notion",
      baseline: baseline([firstId]),
      cutoff,
      outputDirectory,
      publicDirectory: path.join(directory, "public"),
      notion: { token: "synthetic-token", dataSourceId: sourceId, apiVersion: "2026-03-11" },
    });
    expect(manifest.postCount).toBe(0);
    expect(manifest.routes).toContainEqual({
      path: "/blog/article-1",
      expectedStatus: 404,
      kind: "absent",
    });
    expect(manifest.candidateRegistry.posts).toEqual([
      { ...baseline([firstId]).posts[0], published: false },
    ]);
    const bundle = await readContentBundle(outputDirectory);
    expect(JSON.stringify(bundle)).not.toContain("emptyCollectionConfirmed");
    expect(JSON.stringify(bundle)).not.toContain(firstId);
  });

  it("keeps explicit allow_empty for owner recovery without requiring withdrawal proof", async () => {
    const mock = client([]);
    vi.mocked(Client).mockImplementation(function () {
      return mock as unknown as Client;
    });
    const directory = await mkdtemp(path.join(tmpdir(), "notion-empty-recovery-"));
    directories.push(directory);
    await expect(
      prepareContent({
        source: "notion",
        baseline: baseline([firstId]),
        cutoff,
        allowEmpty: true,
        outputDirectory: path.join(directory, "content"),
        publicDirectory: path.join(directory, "public"),
        notion: { token: "synthetic-token", dataSourceId: sourceId, apiVersion: "2026-03-11" },
      }),
    ).resolves.toMatchObject({ postCount: 0 });
    expect(mock.request).not.toHaveBeenCalled();
  });

  it("does not require withdrawal evidence for articles already absent from the published baseline", async () => {
    const mock = client([row(firstId)]);
    vi.mocked(Client).mockImplementation(function () {
      return mock as unknown as Client;
    });
    const directory = await mkdtemp(path.join(tmpdir(), "notion-withdrawal-history-"));
    directories.push(directory);
    const registry = baseline();
    registry.posts[1] = { ...registry.posts[1]!, published: false };
    registry.articleCount = 1;
    await expect(
      prepareContent({
        source: "notion",
        baseline: registry,
        cutoff,
        outputDirectory: path.join(directory, "content"),
        publicDirectory: path.join(directory, "public"),
        notion: { token: "synthetic-token", dataSourceId: sourceId, apiVersion: "2026-03-11" },
      }),
    ).resolves.toMatchObject({ postCount: 0 });
    expect(mock.request).not.toHaveBeenCalled();
  });
});
