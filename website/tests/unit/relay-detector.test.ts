import { readFile } from "node:fs/promises";

import { parse } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { siteConfig } from "../../content/site.config";
import { WEBSITE_STATUSES } from "../../scripts/notion/status";
import {
  decide,
  isWriteBackEdit,
  NOT_ONLINE,
  notionQuery,
  NOTION,
  parseRows,
  PENDING,
  runDetector,
  SCHEDULED,
  settingsFrom,
  type DetectorSettings,
  type NotionRow,
} from "../../relay/src/detector";
import worker from "../../relay/src/index";
import { parseRuns, type RunSummary } from "../../relay/src/github";

const MINUTE = 60_000;
const NOW = Date.parse("2026-10-02T15:07:00.000Z");
const settings: DetectorSettings = {
  quietMinutes: 25,
  maxAutoReleasesPerDay: 6,
  reconcileUtcHour: 10,
  ignoredEditors: new Set(),
};

/** A finished release run that started `startedAgo` minutes before NOW and took two minutes. */
function run(overrides: Partial<RunSummary> & { startedAgo?: number } = {}): RunSummary {
  const startedAt = NOW - (overrides.startedAgo ?? 120) * MINUTE;
  return {
    id: 1,
    status: "completed",
    conclusion: "success",
    createdAt: startedAt,
    startedAt,
    updatedAt: startedAt + 2 * MINUTE,
    operation: "release",
    trigger: "cron",
    ...overrides,
  };
}

/** The day's reconcile already ran, so only changes can dispatch. */
const reconciled = run({ id: 9, startedAgo: 300, trigger: "reconcile" });

function row(overrides: Partial<NotionRow> = {}): NotionRow {
  return {
    lastEditedTime: NOW - 300 * MINUTE,
    lastEditedBy: "author",
    authorStatus: "Published",
    siteStatus: "已同步",
    checkedAt: NOW - 300 * MINUTE,
    publishedAt: Date.parse("2026-01-03"),
    ...overrides,
  };
}

function decideWith(rows: NotionRow[], runs: RunSummary[] = [run(), reconciled], now = NOW) {
  return decide({ now, runs, rows, settings });
}

describe("change detector rules", () => {
  it("publishes an author edit made after the last release once the quiet period passed", () => {
    const edited = row({ lastEditedTime: NOW - 60 * MINUTE, checkedAt: NOW - 118 * MINUTE });
    expect(decideWith([edited])).toMatchObject({
      action: "dispatch",
      trigger: "cron",
      code: "DISPATCH_CHANGES",
      counts: { edited: 1 },
    });
  });

  it("waits while the newest author edit is inside the quiet period", () => {
    const editing = row({ lastEditedTime: NOW - 10 * MINUTE, checkedAt: NOW - 118 * MINUTE });
    expect(decideWith([editing])).toMatchObject({ action: "skip", code: "QUIET_PERIOD" });
  });

  it("ignores the status write-back's own edits, so a release never re-triggers itself", () => {
    // The release run wrote feedback at its end: last edit one minute after the check time.
    const written = row({
      lastEditedTime: NOW - 119 * MINUTE,
      checkedAt: NOW - 119.5 * MINUTE,
      siteStatus: "已同步",
      lastEditedBy: "bot",
    });
    expect(isWriteBackEdit(written, settings.ignoredEditors)).toBe(true);
    expect(decideWith([written])).toMatchObject({ action: "skip", code: "NO_CHANGE" });
  });

  it("ignores listed editors and drafts that were never public", () => {
    const bot = row({ lastEditedTime: NOW - 60 * MINUTE, lastEditedBy: "writer", checkedAt: null });
    expect(
      decide({
        now: NOW,
        runs: [run(), reconciled],
        rows: [bot],
        settings: { ...settings, ignoredEditors: new Set(["writer"]) },
      }),
    ).toMatchObject({ code: "NO_CHANGE" });
    const draft = row({
      lastEditedTime: NOW - 60 * MINUTE,
      authorStatus: "Draft",
      siteStatus: NOT_ONLINE,
    });
    expect(decideWith([draft])).toMatchObject({ code: "NO_CHANGE" });
    // Unpublishing a live post is a change.
    expect(decideWith([{ ...draft, siteStatus: "已同步" }])).toMatchObject({
      code: "DISPATCH_CHANGES",
    });
  });

  it("publishes a scheduled post once it becomes due, and only once", () => {
    const due = row({ siteStatus: SCHEDULED, publishedAt: NOW - 60 * MINUTE });
    expect(decideWith([due])).toMatchObject({ code: "DISPATCH_CHANGES", counts: { due: 1 } });
    // A release that started after it became due already published it (or failed; reconcile).
    const after = run({ startedAgo: 30 });
    expect(decideWith([due], [after, reconciled])).toMatchObject({ code: "NO_CHANGE" });
    // A date-only PublishedAt is due from UTC midnight, not from the author's local date.
    const dateOnly = row({ siteStatus: SCHEDULED, publishedAt: Date.parse("2026-10-02") });
    const yesterday = run({ startedAgo: 20 * 60 });
    expect(
      decide({
        now: NOW,
        runs: [yesterday],
        rows: [dateOnly],
        settings: { ...settings, reconcileUtcHour: 23 },
      }),
    ).toMatchObject({ code: "DISPATCH_CHANGES" });
    const future = row({ siteStatus: SCHEDULED, publishedAt: NOW + MINUTE });
    expect(decideWith([future])).toMatchObject({ code: "NO_CHANGE" });
  });

  it("publishes pending changes found by a check after the last release", () => {
    const pending = row({
      siteStatus: PENDING[0],
      lastEditedTime: NOW - 40 * MINUTE,
      checkedAt: NOW - 40.2 * MINUTE,
    });
    expect(decideWith([pending])).toMatchObject({
      code: "DISPATCH_CHANGES",
      counts: { pending: 1 },
    });
    // The same state written by the release itself (a release that cannot converge) is ignored.
    const ownWriteBack = row({
      siteStatus: PENDING[1],
      lastEditedTime: NOW - 118.5 * MINUTE,
      checkedAt: NOW - 118.6 * MINUTE,
    });
    expect(decideWith([ownWriteBack])).toMatchObject({ code: "NO_CHANGE" });
  });

  it("stops after the daily cap of change-triggered releases", () => {
    const edited = row({ lastEditedTime: NOW - 60 * MINUTE, checkedAt: null });
    const today = Array.from({ length: 6 }, (_, index) =>
      run({ id: 100 + index, startedAgo: 120 + index }),
    );
    expect(decideWith([edited], [...today, reconciled])).toMatchObject({
      action: "skip",
      code: "AUTO_CAP_REACHED",
    });
  });

  it("stops for the day after three failed releases", () => {
    const edited = row({ lastEditedTime: NOW - 60 * MINUTE, checkedAt: null });
    const failed = [1, 2, 3].map((id) =>
      run({ id, startedAgo: 120 + id, conclusion: "failure", trigger: "button" }),
    );
    expect(decideWith([edited], [...failed, reconciled])).toMatchObject({ code: "FAILURES_TODAY" });
    expect(decideWith([edited], [...failed.slice(1), reconciled])).toMatchObject({
      code: "DISPATCH_CHANGES",
    });
  });

  it("dispatches one reconcile release a day, after the configured hour", () => {
    expect(decideWith([], [run()])).toMatchObject({
      trigger: "reconcile",
      code: "DISPATCH_RECONCILE",
    });
    expect(decideWith([], [run(), reconciled])).toMatchObject({ code: "NO_CHANGE" });
    const early = Date.parse("2026-10-02T09:07:00.000Z");
    expect(decide({ now: early, runs: [], rows: [], settings })).toMatchObject({
      code: "NO_CHANGE",
    });
    const yesterday = run({ trigger: "reconcile", startedAgo: 24 * 60 });
    expect(decideWith([], [yesterday])).toMatchObject({ code: "DISPATCH_RECONCILE" });
  });

  it("queries edits since the last release start, due posts at this instant and pending states", () => {
    const query = notionQuery({ since: NOW - 120 * MINUTE, finishedAt: NOW - 118 * MINUTE }, NOW);
    expect(query).toMatchObject({ page_size: 25 });
    const branches = (query.filter as { or: unknown[] }).or;
    expect(branches[0]).toEqual({
      timestamp: "last_edited_time",
      last_edited_time: { on_or_after: new Date(NOW - 121 * MINUTE).toISOString() },
    });
    expect(JSON.stringify(branches[1])).toContain(new Date(NOW).toISOString());
    expect(branches).toHaveLength(2 + PENDING.length);
  });
});

describe("change detector parsing", () => {
  it("reads only the rule fields, treats date-only PublishedAt as UTC midnight, and skips trash", () => {
    const rows = parseRows({
      results: [
        {
          last_edited_time: "2026-10-02T14:00:00.000Z",
          last_edited_by: { object: "user", id: "u1" },
          properties: {
            [NOTION.authorStatus]: { status: { name: "Published" } },
            [NOTION.siteStatus]: { select: { name: SCHEDULED } },
            [NOTION.checkedAt]: { date: { start: "2026-10-01T00:00:00.000Z" } },
            [NOTION.publishedAt]: { date: { start: "2026-10-02" } },
            Title: { title: [{ plain_text: "private title" }] },
          },
        },
        { in_trash: true, last_edited_time: "2026-10-02T14:00:00.000Z", properties: {} },
      ],
    });
    expect(rows).toEqual([
      {
        lastEditedTime: Date.parse("2026-10-02T14:00:00.000Z"),
        lastEditedBy: "u1",
        authorStatus: "Published",
        siteStatus: SCHEDULED,
        checkedAt: Date.parse("2026-10-01T00:00:00.000Z"),
        publishedAt: Date.parse("2026-10-02T00:00:00.000Z"),
      },
    ]);
    expect(parseRows({ object: "error" })).toBeNull();
  });

  it("recognizes the release workflow's run names", () => {
    const runs = parseRuns({
      workflow_runs: [
        {
          id: 5,
          head_branch: "main",
          status: "completed",
          display_title: "Website release (cron)",
          created_at: "2026-10-02T13:00:00Z",
          run_started_at: "2026-10-02T13:00:05Z",
          updated_at: "2026-10-02T13:03:00Z",
        },
        { id: 6, head_branch: "main", status: "completed", display_title: "Something else" },
        {
          id: 7,
          head_branch: "other",
          status: "in_progress",
          display_title: "Website release (cron)",
        },
      ],
    });
    expect(runs?.map((entry) => [entry.id, entry.operation, entry.trigger])).toEqual([
      [5, "release", "cron"],
      [6, null, null],
    ]);
  });

  it("keeps its constants in step with the content config and the status write-back", () => {
    expect(NOTION.authorStatus).toBe(siteConfig.notion.propertyNames.status);
    expect(NOTION.publishedAt).toBe(siteConfig.notion.propertyNames.publishedAt);
    const statuses: readonly string[] = WEBSITE_STATUSES;
    for (const status of [SCHEDULED, NOT_ONLINE, ...PENDING]) expect(statuses).toContain(status);
  });

  it("uses safe defaults for invalid settings", () => {
    expect(
      settingsFrom({ QUIET_MINUTES: "-1", MAX_AUTO_RELEASES_PER_DAY: "x" } as never),
    ).toMatchObject({
      quietMinutes: 25,
      maxAutoReleasesPerDay: 6,
      reconcileUtcHour: 10,
    });
  });
});

describe("scheduled handler", () => {
  const env = {
    GITHUB_DISPATCH_TOKEN: "not-a-real-github-token",
    NOTION_WEBHOOK_SECRET: "not-a-real-secret-000000000000000000000000",
    NOTION_TOKEN: "not-a-real-notion-token",
    NOTION_DATA_SOURCE_ID: "00000000-0000-4000-8000-000000000000",
    GITHUB_REPOSITORY: "ziyixi/todofy",
    RELEASE_WORKFLOW: "website-release.yml",
    CANONICAL_HOST: "www.ziyixi.science",
    NOTION_API_VERSION: "2026-03-11",
    AUTO_PUBLISH: "true",
  };
  const listing = (runs: unknown[]) => Response.json({ workflow_runs: runs });
  const finished = {
    id: 1,
    head_branch: "main",
    status: "completed",
    display_title: "Website release (cron)",
    created_at: new Date(NOW - 120 * MINUTE).toISOString(),
    run_started_at: new Date(NOW - 120 * MINUTE).toISOString(),
    updated_at: new Date(NOW - 118 * MINUTE).toISOString(),
  };
  const reconcileRun = {
    ...finished,
    id: 2,
    display_title: "Website release (reconcile)",
    created_at: new Date(NOW - 300 * MINUTE).toISOString(),
  };
  const editedPage = {
    last_edited_time: new Date(NOW - 60 * MINUTE).toISOString(),
    last_edited_by: { object: "user", id: "author" },
    properties: { [NOTION.authorStatus]: { status: { name: "Published" } } },
  };

  afterEach(() => vi.unstubAllGlobals());

  it("dispatches one fixed cron release with three subrequests", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(listing([finished, reconcileRun]))
      .mockResolvedValueOnce(Response.json({ results: [editedPage] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", upstream);
    await expect(runDetector(env, new Date(NOW))).resolves.toMatchObject({
      code: "DISPATCH_CHANGES",
      counts: { edited: 1 },
    });
    expect(upstream).toHaveBeenCalledTimes(3);
    const [notionUrl, notionInit] = upstream.mock.calls[1]!;
    expect(notionUrl).toBe(
      `https://api.notion.com/v1/data_sources/${env.NOTION_DATA_SOURCE_ID}/query`,
    );
    expect(notionInit?.headers).toMatchObject({ "Notion-Version": "2026-03-11" });
    expect(JSON.parse(String(upstream.mock.calls[2]![1]?.body))).toEqual({
      ref: "main",
      inputs: {
        operation: "release",
        confirmation: "release:www.ziyixi.science",
        force_build: false,
        allow_empty: false,
        trigger: "cron",
      },
    });
  });

  it("does nothing while a release runs, when switched off, or without Notion credentials", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(listing([{ ...finished, status: "queued" }]));
    vi.stubGlobal("fetch", upstream);
    await expect(runDetector(env, new Date(NOW))).resolves.toEqual({ code: "RUN_ACTIVE" });
    expect(upstream).toHaveBeenCalledTimes(1);
    await expect(runDetector({ ...env, AUTO_PUBLISH: "false" }, new Date(NOW))).resolves.toEqual({
      code: "AUTO_PUBLISH_OFF",
    });
    await expect(runDetector({ ...env, NOTION_TOKEN: "" }, new Date(NOW))).resolves.toEqual({
      code: "NOT_CONFIGURED",
    });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("reports upstream failures as codes without dispatching", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(listing([finished]))
        .mockResolvedValueOnce(new Response("private details", { status: 400 })),
    );
    await expect(runDetector(env, new Date(NOW))).resolves.toEqual({
      code: "NOTION_UNAVAILABLE",
      notionStatus: 400,
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("boom")));
    await expect(runDetector(env, new Date(NOW))).resolves.toEqual({ code: "DETECTOR_ERROR" });
  });

  it("logs only the result code and counts", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(listing([finished, reconcileRun]))
        .mockResolvedValueOnce(Response.json({ results: [editedPage] }))
        .mockResolvedValueOnce(new Response(null, { status: 204 })),
    );
    const pending: Promise<unknown>[] = [];
    worker.scheduled({ scheduledTime: NOW, cron: "7,22,37,52 * * * *" }, env, {
      waitUntil: (promise) => pending.push(promise),
    });
    await Promise.all(pending);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(JSON.parse(line)).toEqual({
      relay: "detector",
      code: "DISPATCH_CHANGES",
      counts: { rows: 1, edited: 1, due: 0, pending: 0 },
    });
    for (const secret of [env.GITHUB_DISPATCH_TOKEN, env.NOTION_TOKEN, env.NOTION_DATA_SOURCE_ID]) {
      expect(line).not.toContain(secret);
    }
    log.mockRestore();
  });
});

describe("relay wrangler.toml", () => {
  it("keeps the buttons' workers.dev URL, one cron and only non-secret vars", async () => {
    const config = parse(await readFile("relay/wrangler.toml", "utf8")) as {
      name: string;
      workers_dev: boolean;
      preview_urls: boolean;
      triggers: { crons: string[] };
      observability: { logs: { invocation_logs: boolean } };
      vars: Record<string, string>;
    };
    expect(config.name).toBe("ziyixi-notion-publish");
    expect(config.workers_dev).toBe(true);
    expect(config.preview_urls).toBe(false);
    expect(config.triggers.crons).toEqual(["7,22,37,52 * * * *"]);
    expect(config.observability.logs.invocation_logs).toBe(false);
    expect(config.vars).toMatchObject({
      GITHUB_REPOSITORY: "ziyixi/todofy",
      RELEASE_WORKFLOW: "website-release.yml",
      CANONICAL_HOST: new URL(siteConfig.canonicalOrigin).host,
      NOTION_API_VERSION: siteConfig.notion.apiVersion,
      AUTO_PUBLISH: "true",
    });
    for (const name of [
      "GITHUB_DISPATCH_TOKEN",
      "NOTION_WEBHOOK_SECRET",
      "NOTION_TOKEN",
      "NOTION_DATA_SOURCE_ID",
    ]) {
      expect(config.vars).not.toHaveProperty(name);
    }
  });
});
