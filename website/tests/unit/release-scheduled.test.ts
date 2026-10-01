import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse } from "smol-toml";
import { describe, expect, it, vi } from "vitest";

import { MAX_FAILED_RELEASES_PER_DAY as RELAY_MAX_FAILED } from "../../relay/src/detector";
import { parseRuns } from "../../relay/src/github";
import { RELEASE_ENVIRONMENT, RELEASE_TASK } from "../../scripts/release/payload";
import {
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
): RunInfo {
  return { id, name, createdAt, conclusion };
}

function decideWith(runs: RunInfo[], latestState: string | null = "success") {
  return decideScheduled({ now: NOW, currentRunId: CURRENT, runs, latestState });
}

describe("scheduled reconcile decision", () => {
  it("reconciles once a day while the gate is open", () => {
    expect(decideWith([])).toEqual({ reconcile: true, code: "RECONCILE" });
    // This run's own entry, yesterday's reconcile and today's other releases do not count.
    expect(
      decideWith([
        run(CURRENT, SCHEDULED_RUN_NAME, TODAY("10:30:05"), null),
        run(1, "Website release (reconcile)", YESTERDAY),
        run(2, SCHEDULED_RUN_NAME, YESTERDAY),
        run(3, "Website release (push)", TODAY("09:00:00")),
        run(4, "Website release (cron)", TODAY("09:30:00"), "failure"),
        run(5, "Website status (button)", TODAY("09:40:00")),
      ]),
    ).toEqual({ reconcile: true, code: "RECONCILE" });
  });

  it("skips when the relay or an earlier scheduled run already reconciled today", () => {
    for (const name of ["Website release (reconcile)", SCHEDULED_RUN_NAME]) {
      for (const conclusion of ["success", "failure", null]) {
        expect(decideWith([run(1, name, TODAY("10:07:00"), conclusion)])).toEqual({
          reconcile: false,
          code: "RECONCILED_TODAY",
        });
      }
    }
    // A run just after UTC midnight is today's.
    expect(decideWith([run(1, "Website release (reconcile)", TODAY("00:00:00"))]).code).toBe(
      "RECONCILED_TODAY",
    );
  });

  it("never runs during a recovery gate or before the bootstrap", () => {
    for (const state of ["in_progress", "failure", "error", "inactive", "missing"]) {
      expect(decideWith([], state)).toEqual({ reconcile: false, code: "RECOVERY_GATE" });
    }
    expect(decideWith([], null)).toEqual({ reconcile: false, code: "NO_RELEASE_RECORD" });
  });

  it("stops after the relay's daily number of failed releases", () => {
    expect(MAX_FAILED_RELEASES_PER_DAY).toBe(RELAY_MAX_FAILED);
    const failures = [
      run(1, "Website release (push)", TODAY("08:00:00"), "failure"),
      run(2, "Website release (cron)", TODAY("08:30:00"), "failure"),
    ];
    expect(decideWith(failures).code).toBe("RECONCILE");
    // Recovery, status and cancelled runs are not failed releases.
    expect(
      decideWith([
        ...failures,
        run(3, "Website recovery (manual)", TODAY("09:00:00"), "failure"),
        run(4, "Website status (button)", TODAY("09:00:00"), "failure"),
        run(5, "Website release (button)", TODAY("09:10:00"), "cancelled"),
      ]).code,
    ).toBe("RECONCILE");
    expect(
      decideWith([...failures, run(3, "Website release (button)", TODAY("09:00:00"), "failure")]),
    ).toEqual({ reconcile: false, code: "FAILURES_TODAY" });
  });
});

describe("scheduled reconcile and the relay", () => {
  it("names scheduled runs so the relay's parser ignores them, and parses dispatched names as the relay does", () => {
    const listing = (title: string) => ({
      workflow_runs: [{ id: 1, head_branch: "main", display_title: title, status: "completed" }],
    });
    expect(parseRuns(listing(SCHEDULED_RUN_NAME))?.[0]).toMatchObject({
      operation: null,
      trigger: null,
    });
    expect(parseRuns(listing("Website release (reconcile)"))?.[0]).toMatchObject({
      operation: "release",
      trigger: "reconcile",
    });
    expect(DISPATCHED_RUN_NAME.exec(SCHEDULED_RUN_NAME)).toBeNull();
  });

  it("agrees with the workflow, the relay's settings and the release records", async () => {
    const workflow = await readFile("../.github/workflows/website-release.yml", "utf8");
    expect(workflow).toContain(`'${SCHEDULED_RUN_NAME}'`);
    expect(workflow).toContain("    - cron: '30 10 * * *'");
    const relay = parse(await readFile("relay/wrangler.toml", "utf8")) as {
      vars: Record<string, string>;
    };
    expect(relay.vars.RELEASE_WORKFLOW).toBe(RELEASE_WORKFLOW);
    // The schedule runs after the relay's reconcile hour, so a working relay reconciles first.
    expect(Number(relay.vars.RECONCILE_UTC_HOUR)).toBeLessThanOrEqual(10);
    expect([RECORD_ENVIRONMENT, RECORD_TASK]).toEqual([RELEASE_ENVIRONMENT, RELEASE_TASK]);
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
      run(7, "Website release (reconcile)", TODAY("10:07:00"), null),
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
      expect(decision).toEqual({ reconcile: false, code: "RECONCILED_TODAY" });
      expect(await readFile(output, "utf8")).toBe("reconcile=false\ncode=RECONCILED_TODAY\n");
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
