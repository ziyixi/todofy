import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decide,
  MAX_FAILED_RELEASES_PER_DAY as RELAY_MAX_FAILED,
  NOTION,
  type DetectorSettings,
} from "../../relay/src/detector";
import { ACTIVE_STATUSES as RELAY_ACTIVE, parseRuns } from "../../relay/src/github";
import { RELEASE_ENVIRONMENT, RELEASE_TASK } from "../../scripts/release/payload";
import {
  main as dispatchMain,
  readRelayVars,
  RECONCILE_RUN_NAME,
  scheduledDispatch,
} from "../../scripts/release/scheduled-dispatch";
import {
  ACTIVE_STATUSES,
  decideScheduled,
  DISPATCHED_RUN_NAME,
  latestRecordState,
  listRuns,
  main,
  MAX_FAILED_RELEASES_PER_DAY,
  RECORD_ENVIRONMENT,
  RECORD_TASK,
  RELEASE_WORKFLOW,
  SCHEDULED_RUN_NAME,
  type RunInfo,
} from "../../scripts/release/scheduled-reconcile";

const NOW = Date.parse("2026-10-02T10:31:00Z");
const TODAY = (time: string) => Date.parse(`2026-10-02T${time}Z`);
const YESTERDAY = Date.parse("2026-10-01T10:31:00Z");
const CURRENT = 500;

function run(
  id: number,
  name: string,
  createdAt: number,
  conclusion: string | null = "success",
  status = conclusion === null ? "in_progress" : "completed",
): RunInfo {
  return { id, name, status, createdAt, conclusion };
}

function decideWith(runs: RunInfo[], latestState: string | null = "success") {
  return decideScheduled({ now: NOW, currentRunId: CURRENT, runs, latestState });
}

describe("scheduled reconcile decision", () => {
  it("is due once a day while the gate is open and nothing runs", () => {
    expect(decideWith([])).toEqual({ due: true, code: "DUE" });
    // This run's own entry, yesterday's reconcile, earlier scheduled runs (they may have held) and today's
    // other releases do not count.
    expect(
      decideWith([
        run(CURRENT, SCHEDULED_RUN_NAME, TODAY("10:30:05"), null),
        run(1, RECONCILE_RUN_NAME, YESTERDAY),
        run(2, SCHEDULED_RUN_NAME, TODAY("09:30:00")),
        run(3, "Website release (push)", TODAY("09:00:00")),
        run(4, "Website release (cron)", TODAY("09:30:00"), "failure"),
        run(5, "Website status (button)", TODAY("09:40:00")),
      ]),
    ).toEqual({ due: true, code: "DUE" });
  });

  it("skips when a reconcile release (the relay's or a dispatched one) was created today", () => {
    for (const conclusion of ["success", "failure", null]) {
      expect(decideWith([run(1, RECONCILE_RUN_NAME, TODAY("10:07:00"), conclusion)])).toEqual({
        due: false,
        code: "RECONCILED_TODAY",
      });
    }
    // A run just after UTC midnight is today's; even during a recovery gate the code says why.
    expect(decideWith([run(1, RECONCILE_RUN_NAME, TODAY("00:00:00"))], "failure").code).toBe(
      "RECONCILED_TODAY",
    );
  });

  it("waits for a running release instead of calling its in_progress record a recovery gate", () => {
    expect([...ACTIVE_STATUSES].sort()).toEqual([...RELAY_ACTIVE].sort());
    for (const status of ACTIVE_STATUSES) {
      expect(
        decideWith(
          [run(1, "Website release (push)", TODAY("10:20:00"), null, status)],
          "in_progress",
        ),
      ).toEqual({ due: false, code: "RELEASE_RUNNING" });
    }
    // A queued run from yesterday is still running.
    expect(decideWith([run(1, "Website release (cron)", YESTERDAY, null, "queued")]).code).toBe(
      "RELEASE_RUNNING",
    );
    // This run itself is running and does not count.
    expect(decideWith([run(CURRENT, SCHEDULED_RUN_NAME, TODAY("10:30:00"), null)]).code).toBe(
      "DUE",
    );
  });

  it("never dispatches during a recovery gate or before the bootstrap", () => {
    // Nothing runs: an in_progress record is an interrupted release, which blocks like a failure.
    for (const state of ["in_progress", "failure", "error", "inactive", "missing"]) {
      expect(decideWith([], state)).toEqual({ due: false, code: "RECOVERY_GATE" });
    }
    expect(decideWith([], null)).toEqual({ due: false, code: "NO_RELEASE_RECORD" });
  });

  it("stops after the relay's daily number of failed releases", () => {
    expect(MAX_FAILED_RELEASES_PER_DAY).toBe(RELAY_MAX_FAILED);
    const failures = [
      run(1, "Website release (push)", TODAY("08:00:00"), "failure"),
      run(2, "Website release (cron)", TODAY("08:30:00"), "failure"),
    ];
    expect(decideWith(failures).code).toBe("DUE");
    // Recovery, status, cancelled and scheduled runs are not failed releases.
    expect(
      decideWith([
        ...failures,
        run(3, "Website recovery (manual)", TODAY("09:00:00"), "failure"),
        run(4, "Website status (button)", TODAY("09:00:00"), "failure"),
        run(5, "Website release (button)", TODAY("09:10:00"), "cancelled"),
        run(6, SCHEDULED_RUN_NAME, TODAY("09:30:00"), "failure"),
      ]).code,
    ).toBe("DUE");
    expect(
      decideWith([...failures, run(3, "Website release (button)", TODAY("09:00:00"), "failure")]),
    ).toEqual({ due: false, code: "FAILURES_TODAY" });
  });
});

describe("scheduled reconcile and the relay", () => {
  const listing = (title: string, extra: Record<string, unknown> = {}) => ({
    workflow_runs: [
      {
        id: 1,
        head_branch: "main",
        display_title: title,
        status: "completed",
        created_at: "2026-10-02T10:30:00Z",
        run_started_at: "2026-10-02T10:30:00Z",
        updated_at: "2026-10-02T10:32:00Z",
        ...extra,
      },
    ],
  });
  const settings: DetectorSettings = {
    quietMinutes: 25,
    maxAutoReleasesPerDay: 6,
    reconcileUtcHour: 10,
    ignoredEditors: new Set(),
  };
  const afternoon = Date.parse("2026-10-02T11:07:00Z");

  it("names scheduled runs so the relay ignores them, and dispatches a run the relay reads as its reconcile", () => {
    expect(parseRuns(listing(SCHEDULED_RUN_NAME))?.[0]).toMatchObject({
      operation: null,
      trigger: null,
    });
    expect(parseRuns(listing(RECONCILE_RUN_NAME))?.[0]).toMatchObject({
      operation: "release",
      trigger: "reconcile",
    });
    expect(DISPATCHED_RUN_NAME.exec(SCHEDULED_RUN_NAME)).toBeNull();
    expect(DISPATCHED_RUN_NAME.exec(RECONCILE_RUN_NAME)?.slice(1)).toEqual([
      "release",
      "reconcile",
    ]);
  });

  it("leaves the relay nothing to repeat after a dispatched reconcile, and moves no window when it held", () => {
    const edited = {
      id: "page",
      lastEditedTime: Date.parse("2026-10-02T10:20:00Z"),
      lastEditedBy: "author",
      authorStatus: "Published",
      siteStatus: "已同步",
      checkedAt: Date.parse("2026-10-01T10:00:00Z"),
      publishedAt: null,
    };
    // A dispatched reconcile ran (10:30 to 10:32): the relay finds today's reconcile, and the edit
    // before it is inside that release, so nothing is dispatched.
    const dispatched = parseRuns(listing(RECONCILE_RUN_NAME))!;
    expect(decide({ now: afternoon, runs: dispatched, rows: [edited], settings })).toMatchObject({
      action: "skip",
      code: "NO_CHANGE",
    });
    // A scheduled run that only checked (or held) is invisible to the relay: its reconcile is still
    // due and the edit still counts as unpublished.
    const held = parseRuns(listing(SCHEDULED_RUN_NAME))!;
    expect(decide({ now: afternoon, runs: held, rows: [edited], settings })).toMatchObject({
      action: "dispatch",
      counts: { edited: 1 },
    });
  });

  it("agrees with the workflow, the relay's settings and the release records", async () => {
    const workflow = await readFile("../.github/workflows/website-release.yml", "utf8");
    expect(workflow).toContain(`'${SCHEDULED_RUN_NAME}'`);
    expect(workflow).toContain("    - cron: '30 10-15 * * *'");
    const relay = parse(await readFile("relay/wrangler.toml", "utf8")) as {
      vars: Record<string, string>;
    };
    expect(relay.vars.RELEASE_WORKFLOW).toBe(RELEASE_WORKFLOW);
    // The schedule's first hour is after the relay's reconcile hour, so a working relay reconciles first.
    expect(Number(relay.vars.RECONCILE_UTC_HOUR)).toBeLessThanOrEqual(10);
    expect([RECORD_ENVIRONMENT, RECORD_TASK]).toEqual([RELEASE_ENVIRONMENT, RELEASE_TASK]);
    await expect(
      readRelayVars("relay/wrangler.toml", {
        repository: "ziyixi/todofy",
        siteUrl: "https://www.ziyixi.science",
      }),
    ).resolves.toMatchObject({ QUIET_MINUTES: "25", CANONICAL_HOST: "www.ziyixi.science" });
    await expect(
      readRelayVars("relay/wrangler.toml", {
        repository: "someone/else",
        siteUrl: "https://www.ziyixi.science",
      }),
    ).rejects.toThrow(/GITHUB_REPOSITORY/);
    await expect(
      readRelayVars("relay/wrangler.toml", {
        repository: "ziyixi/todofy",
        siteUrl: "https://ziyixi.science",
      }),
    ).rejects.toThrow(/CANONICAL_HOST/);
  });
});

/** A fake GitHub API: the run listing, the records and their statuses. */
function github(data: {
  runs?: unknown[];
  records?: unknown[];
  statuses?: Record<number, unknown[]>;
  status?: number;
}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
    expect(init?.redirect).toBe("error");
    if (data.status) return new Response("secret body", { status: data.status });
    if (url.pathname === "/repos/ziyixi/todofy/actions/workflows/website-release.yml/runs") {
      return Response.json({ workflow_runs: data.runs ?? [] });
    }
    if (url.pathname === "/repos/ziyixi/todofy/deployments") {
      expect(url.searchParams.get("environment")).toBe("production");
      expect(url.searchParams.get("task")).toBe("website-release");
      return Response.json(data.records ?? []);
    }
    const statuses = /^\/repos\/ziyixi\/todofy\/deployments\/(\d+)\/statuses$/.exec(url.pathname);
    if (statuses) return Response.json(data.statuses?.[Number(statuses[1])] ?? []);
    return new Response("not found", { status: 404 });
  });
  return {
    calls,
    options: {
      apiUrl: "https://api.github.test",
      token: "token",
      repository: "ziyixi/todofy",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    },
  };
}

describe("scheduled reconcile GitHub reads", () => {
  it("lists main's runs of the release workflow with their names", async () => {
    const { options, calls } = github({
      runs: [
        {
          id: 7,
          head_branch: "main",
          display_title: "Website release (reconcile)",
          created_at: "2026-10-02T10:07:00Z",
          conclusion: null,
        },
        { id: 8, head_branch: "feature", display_title: "Website release (reconcile)" },
        { id: "9", head_branch: "main" },
      ],
    });
    await expect(listRuns(options)).resolves.toEqual([
      run(7, "Website release (reconcile)", TODAY("10:07:00"), null, "unknown"),
    ]);
    expect(calls).toEqual([
      "/repos/ziyixi/todofy/actions/workflows/website-release.yml/runs?branch=main&per_page=50",
    ]);
  });

  it("reads the newest status of the newest record, as the gate does", async () => {
    const records = [
      { id: 10, created_at: "2026-10-01T00:00:00Z" },
      { id: 11, created_at: "2026-10-02T00:00:00Z" },
    ];
    const statuses = {
      11: [
        { id: 1, created_at: "2026-10-02T00:01:00Z", state: "in_progress" },
        { id: 2, created_at: "2026-10-02T00:05:00Z", state: "success" },
      ],
    };
    await expect(latestRecordState(github({ records, statuses }).options)).resolves.toBe("success");
    await expect(
      latestRecordState(github({ records, statuses: { 11: [statuses[11][0]] } }).options),
    ).resolves.toBe("in_progress");
    await expect(latestRecordState(github({ records }).options)).resolves.toBe("missing");
    await expect(latestRecordState(github({ records: [] }).options)).resolves.toBeNull();
  });

  it("fails without a token and never echoes a response body", async () => {
    await expect(listRuns({ ...github({}).options, token: "" })).rejects.toThrow(/GITHUB_TOKEN/);
    const failing = listRuns(github({ status: 403 }).options);
    await expect(failing).rejects.toThrow(/HTTP 403/);
    await expect(failing).rejects.not.toThrow(/secret body/);
  });

  it("writes the decision to GITHUB_OUTPUT", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "scheduled-reconcile-"));
    const output = path.join(directory, "output");
    const fake = github({
      runs: [
        {
          id: 7,
          head_branch: "main",
          display_title: "Website release (reconcile)",
          created_at: "2026-10-02T10:07:00Z",
          status: "completed",
          conclusion: "success",
        },
      ],
      records: [{ id: 11, created_at: "2026-10-02T00:00:00Z" }],
      statuses: { 11: [{ id: 1, created_at: "2026-10-02T00:05:00Z", state: "success" }] },
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.stubGlobal("fetch", fake.options.fetchImpl);
    try {
      const decision = await main(
        {
          GITHUB_REPOSITORY: "ziyixi/todofy",
          GITHUB_RUN_ID: String(CURRENT),
          GITHUB_API_URL: "https://api.github.test",
          GITHUB_TOKEN: "token",
          GITHUB_OUTPUT: output,
        },
        NOW,
      );
      expect(decision).toEqual({ due: false, code: "RECONCILED_TODAY" });
      expect(await readFile(output, "utf8")).toBe("due=false\ncode=RECONCILED_TODAY\n");
      await expect(main({ GITHUB_REPOSITORY: "x", GITHUB_RUN_ID: "1" }, NOW)).rejects.toThrow(
        /owner\/name/,
      );
      await expect(main({ GITHUB_REPOSITORY: "a/b", GITHUB_RUN_ID: "x" }, NOW)).rejects.toThrow(
        /GITHUB_RUN_ID/,
      );
    } finally {
      vi.unstubAllGlobals();
      stdout.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("scheduled reconcile dispatch", () => {
  const relay = {
    GITHUB_REPOSITORY: "ziyixi/todofy",
    RELEASE_WORKFLOW: "website-release.yml",
    CANONICAL_HOST: "www.ziyixi.science",
    NOTION_API_VERSION: "2026-03-11",
    QUIET_MINUTES: "25",
    MAX_AUTO_RELEASES_PER_DAY: "6",
    RECONCILE_UTC_HOUR: "10",
  };
  const ghRun = (id: number, title: string, createdAt: string, status = "completed") => ({
    id,
    head_branch: "main",
    display_title: title,
    status,
    conclusion: status === "completed" ? "success" : null,
    created_at: createdAt,
    run_started_at: createdAt,
    updated_at: createdAt,
  });
  const self = ghRun(CURRENT, SCHEDULED_RUN_NAME, "2026-10-02T10:30:00Z", "in_progress");
  const yesterdaysRelease = ghRun(1, "Website release (cron)", "2026-10-01T12:00:00Z");
  const page = (minutesAgo: number) => ({
    id: "page",
    last_edited_time: new Date(NOW - minutesAgo * 60_000).toISOString(),
    last_edited_by: { object: "user", id: "author" },
    properties: { [NOTION.authorStatus]: { status: { name: "Published" } } },
  });

  /** GitHub and Notion: the listing before and after the dispatch, the record, the Notion rows. */
  function upstream(data: {
    runs: unknown[];
    afterDispatch?: unknown[];
    state?: string;
    notion?: unknown[];
    notionStatus?: number;
    dispatchStatus?: number;
  }) {
    const calls: string[] = [];
    let dispatchedBody: unknown;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.host}${url.pathname}`);
      if (url.host === "api.notion.com") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer notion");
        if (data.notionStatus) return new Response("private", { status: data.notionStatus });
        return Response.json({ results: data.notion ?? [], has_more: false, next_cursor: null });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
      if (url.pathname.endsWith("/dispatches")) {
        expect(method).toBe("POST");
        dispatchedBody = JSON.parse(String(init?.body));
        return new Response(null, { status: data.dispatchStatus ?? 204 });
      }
      if (url.pathname.endsWith("/runs")) {
        return Response.json({
          workflow_runs:
            dispatchedBody !== undefined ? (data.afterDispatch ?? data.runs) : data.runs,
        });
      }
      if (url.pathname.endsWith("/deployments")) {
        return Response.json([{ id: 11, created_at: "2026-10-02T00:00:00Z" }]);
      }
      if (url.pathname.endsWith("/deployments/11/statuses")) {
        return Response.json([
          { id: 1, created_at: "2026-10-02T00:05:00Z", state: data.state ?? "success" },
        ]);
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchImpl);
    return {
      calls,
      dispatched: () => dispatchedBody,
      input: {
        now: NOW,
        currentRunId: CURRENT,
        options: {
          apiUrl: "https://api.github.com",
          token: "token",
          repository: "ziyixi/todofy",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
        relay,
        notion: { token: "notion", dataSourceId: "00000000-0000-4000-8000-000000000000" },
        wait: async () => undefined,
      },
    };
  }

  afterEach(() => vi.unstubAllGlobals());

  it("dispatches exactly the relay's reconcile release and waits until GitHub lists it", async () => {
    const fake = upstream({
      runs: [self, yesterdaysRelease],
      afterDispatch: [
        ghRun(501, RECONCILE_RUN_NAME, "2026-10-02T10:31:05Z", "queued"),
        self,
        yesterdaysRelease,
      ],
      notion: [page(120)],
    });
    await expect(scheduledDispatch(fake.input)).resolves.toEqual({
      dispatched: true,
      code: "DISPATCHED",
    });
    expect(fake.dispatched()).toEqual({
      ref: "main",
      inputs: {
        operation: "release",
        confirmation: "release:www.ziyixi.science",
        force_build: false,
        allow_empty: false,
        trigger: "reconcile",
      },
    });
    expect(fake.calls.filter((call) => call.endsWith("/dispatches"))).toEqual([
      "POST api.github.com/repos/ziyixi/todofy/actions/workflows/website-release.yml/dispatches",
    ]);
  });

  it("holds during the relay's quiet period and dispatches nothing", async () => {
    const fake = upstream({ runs: [self, yesterdaysRelease], notion: [page(10)] });
    await expect(scheduledDispatch(fake.input)).resolves.toEqual({
      dispatched: false,
      code: "QUIET_PERIOD",
    });
    expect(fake.dispatched()).toBeUndefined();
    // 26 minutes after the edit the relay would publish, and so does the schedule.
    const later = upstream({
      runs: [self, yesterdaysRelease],
      afterDispatch: [ghRun(501, RECONCILE_RUN_NAME, "2026-10-02T10:31:05Z", "queued")],
      notion: [page(26)],
    });
    await expect(scheduledDispatch(later.input)).resolves.toMatchObject({ code: "DISPATCHED" });
  });

  it("checks again before reading Notion: a reconcile, a running release or a gate since the check", async () => {
    const reconciled = upstream({
      runs: [ghRun(9, RECONCILE_RUN_NAME, "2026-10-02T10:30:30Z", "queued"), self],
    });
    await expect(scheduledDispatch(reconciled.input)).resolves.toEqual({
      dispatched: false,
      code: "RECONCILED_TODAY",
    });
    const running = upstream({
      runs: [ghRun(9, "Website release (push)", "2026-10-02T10:30:30Z", "in_progress"), self],
      state: "in_progress",
    });
    await expect(scheduledDispatch(running.input)).resolves.toMatchObject({
      code: "RELEASE_RUNNING",
    });
    const gated = upstream({ runs: [self], state: "error" });
    await expect(scheduledDispatch(gated.input)).resolves.toMatchObject({ code: "RECOVERY_GATE" });
    for (const fake of [reconciled, running, gated]) {
      expect(fake.calls.some((call) => call.includes("notion"))).toBe(false);
      expect(fake.dispatched()).toBeUndefined();
    }
  });

  it("holds without echoing anything when Notion fails, and fails on a refused dispatch", async () => {
    const notionDown = upstream({ runs: [self], notionStatus: 503 });
    await expect(scheduledDispatch(notionDown.input)).resolves.toEqual({
      dispatched: false,
      code: "NOTION_UNAVAILABLE",
    });
    expect(notionDown.dispatched()).toBeUndefined();
    const refused = upstream({ runs: [self], dispatchStatus: 403 });
    await expect(scheduledDispatch(refused.input)).rejects.toThrow(/HTTP 403\.$/);
    // Dispatched, but GitHub never listed it within the wait.
    const unlisted = upstream({ runs: [self] });
    await expect(scheduledDispatch(unlisted.input)).resolves.toEqual({
      dispatched: true,
      code: "DISPATCHED_NOT_LISTED",
    });
  });

  it("needs the run context and Notion credentials, and writes the result to GITHUB_OUTPUT", async () => {
    const env = {
      GITHUB_REPOSITORY: "ziyixi/todofy",
      GITHUB_RUN_ID: String(CURRENT),
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_TOKEN: "token",
      SITE_URL: "https://www.ziyixi.science",
    };
    await expect(dispatchMain(env, NOW, "relay/wrangler.toml")).rejects.toThrow(/NOTION_TOKEN/);
    upstream({ runs: [ghRun(9, RECONCILE_RUN_NAME, "2026-10-02T10:07:00Z"), self] });
    const directory = await mkdtemp(path.join(tmpdir(), "scheduled-dispatch-"));
    const output = path.join(directory, "output");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(
        dispatchMain(
          {
            ...env,
            NOTION_TOKEN: "notion",
            NOTION_DATA_SOURCE_ID: "x",
            GITHUB_OUTPUT: output,
          },
          NOW,
          "relay/wrangler.toml",
        ),
      ).resolves.toEqual({ dispatched: false, code: "RECONCILED_TODAY" });
      expect(await readFile(output, "utf8")).toBe("dispatched=false\ncode=RECONCILED_TODAY\n");
    } finally {
      stdout.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
