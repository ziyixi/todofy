import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelayEnv } from "../../relay/src/env";
import { getSyncRequest, requestSync } from "../../relay/src/request";
import { getSyncStatus, nextCheck, opsStatus } from "../../relay/src/status";

const env: RelayEnv = {
  GITHUB_REPOSITORY: "owner/site",
  RELEASE_WORKFLOW: "website-release.yml",
  CANONICAL_HOST: "www.example.test",
  DAILY_SYNC_CRON: "17 10 * * *",
  GITHUB_DISPATCH_TOKEN: "synthetic-token",
};
const requestId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-10-04T12:00:00.000Z");
const identity = {
  codeSha: "a".repeat(40),
  contentHash: "b".repeat(64),
  configHash: "c".repeat(64),
  schemaVersion: 1,
};
const run = (id = 12, overrides = {}) => ({
  id,
  run_attempt: 1,
  head_branch: "main",
  status: "completed",
  conclusion: "success",
  created_at: "2026-10-04T10:17:00Z",
  updated_at: "2026-10-04T10:20:00Z",
  display_title: `Website release (manual) [${requestId}]`,
  ...overrides,
});
const check = (id = 12, overrides = {}) => ({
  id,
  created_at: "2026-10-04T10:18:00Z",
  payload: {
    schema_version: 1,
    task: "website-content-sync",
    run_id: id,
    run_attempt: 1,
    request_id: requestId,
    checked_at: "2026-10-04T10:18:00Z",
    decision: "unchanged",
    identity,
    ...overrides,
  },
});
const release = {
  id: 2,
  created_at: "2026-10-03T10:17:00Z",
  payload: {
    schemaVersion: 3,
    task: "website-release",
    identity,
    workerVersionId: "22222222-2222-4222-8222-222222222222",
    workflowUrl: "https://github.com/owner/site/actions/runs/2",
  },
};
function observe(
  options: {
    runs?: unknown[];
    checks?: unknown[];
    releases?: unknown[];
    states?: Record<string, { state: string; description?: string; created_at?: string }>;
    site?: Response;
  } = {},
) {
  const mocked = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/runs?")) return Response.json({ workflow_runs: options.runs ?? [run()] });
    if (url.includes("task=website-content-sync"))
      return Response.json(options.checks ?? [check()]);
    if (url.includes("task=website-release")) return Response.json(options.releases ?? [release]);
    const match = /\/deployments\/(\d+)\/statuses/.exec(url);
    if (match)
      return Response.json([
        options.states?.[match[1]!] ?? {
          state: "success",
          description: match[1] === "2" ? "Deployed and verified" : "SYNC_UNCHANGED",
          created_at: match[1] === "2" ? "2026-10-03T10:22:00Z" : "2026-10-04T10:20:00Z",
        },
      ]);
    if (url === "https://www.example.test/build-info.json")
      return options.site ?? Response.json(identity);
    throw new Error("Unexpected fixture URL");
  });
  vi.stubGlobal("fetch", mocked);
  return mocked;
}
/** Deployment IDs whose status was read, in request order. */
function statusReads(send: ReturnType<typeof observe>): string[] {
  return send.mock.calls.flatMap((call) => {
    const match = /\/deployments\/(\d+)\/statuses/.exec(String(call[0]));
    return match ? [match[1]!] : [];
  });
}
afterEach(() => vi.unstubAllGlobals());
describe("actual sync evidence", () => {
  it("no-change advances only complete check, retaining the verified publish time", async () => {
    observe();
    const status = await getSyncStatus(env, now);
    expect(status.last_check?.checked_at).toBe("2026-10-04T10:18:00Z");
    expect(status.latest_attempt?.state).toBe("unchanged");
    expect(status.last_publish?.verified_at).toBe("2026-10-03T10:22:00Z");
    expect((await opsStatus(env, now)).health).toBe("ok");
  });
  it("changed content in progress shows publishing without advancing last verified release", async () => {
    observe({
      runs: [run(12, { status: "in_progress", conclusion: null })],
      checks: [check(12, { decision: "changed" })],
      states: { 12: { state: "in_progress", description: "SYNC_DEPLOYING" } },
    });
    const status = await getSyncStatus(env, now);
    expect(status.active_run?.state).toBe("publishing");
    expect(status.last_check?.decision).toBe("deployment_required");
    expect(status.last_publish?.run_id).toBe("2");
  });
  it("a new queued run remains separate from the check that is already running", async () => {
    observe({
      runs: [
        run(13, { status: "queued", conclusion: null, created_at: "2026-10-04T10:21:00Z" }),
        run(12, { status: "in_progress", conclusion: null }),
      ],
    });
    const status = await getSyncStatus(env, now);
    expect(status.latest_attempt?.run_id).toBe("13");
    expect(status.active_run?.state).toBe("queued");
  });
  it("a completed green workflow without receipt is unconfirmed and does not invent a check", async () => {
    observe({ checks: [] });
    const status = await getSyncStatus(env, now);
    expect(status.latest_attempt?.state).toBe("unconfirmed");
    expect(status.last_check).toBeUndefined();
  });
  it("cancellation cannot reuse the previous attempt receipt", async () => {
    observe({ runs: [run(12, { run_attempt: 2, conclusion: "cancelled" })] });
    const status = await getSyncStatus(env, now);
    expect(status.latest_attempt?.error_code).toBe("sync_cancelled");
    expect(status.last_check?.checked_at).toBe("2026-10-04T10:18:00Z");
  });
  it("failed build retains a completed check and old verified publication", async () => {
    observe({
      runs: [run(12, { conclusion: "failure" })],
      checks: [check(12, { decision: "changed" })],
      states: { 12: { state: "failure", description: "SYNC_BUILD_FAILED" } },
    });
    const status = await getSyncStatus(env, now);
    expect(status.latest_attempt?.error_code).toBe("sync_build_failed");
    expect(status.last_check).toBeDefined();
    expect(status.last_publish?.run_id).toBe("2");
  });
  it("rejects incomplete or contradictory check evidence", async () => {
    observe({ checks: [check(12, { decision: "not_checked", identity: null })] });
    expect((await getSyncStatus(env, now)).error_code).toBe("github_response_invalid");
  });
  it("keeps provider failures observable instead of reusing an earlier success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    const status = await getSyncStatus(env, now);
    expect(status.error_code).toBe("github_permission_denied");
    expect(status.last_check).toBeUndefined();
  });
  it("reports website observation errors separately from GitHub availability", async () => {
    observe({ site: new Response("invalid JSON") });
    expect((await getSyncStatus(env, now)).error_code).toBe("website_observation_failed");
  });
  it("flags a reachable website whose public identity differs from its verified release", async () => {
    observe({ site: Response.json({ ...identity, contentHash: "d".repeat(64) }) });
    expect((await getSyncStatus(env, now)).error_code).toBe("website_identity_mismatch");
  });
  it("warns after 26 hours and uses a stable incident time", async () => {
    observe({ checks: [check(12, { checked_at: "2026-10-02T10:18:00Z" })] });
    const status = await opsStatus(env, now);
    expect(status.signals.find((s) => s.code === "website_sync_stale")?.since).toBe(
      "2026-10-02T10:18:00Z",
    );
  });
  it("returns next daily UTC time without a daylight-saving offset", () => {
    expect(nextCheck(env, now)).toBe("2026-10-05T10:17:00.000Z");
    expect(nextCheck(env, new Date("2026-11-02T08:00:00Z"))).toBe("2026-11-02T10:17:00.000Z");
  });
});
describe("subrequest budget", () => {
  it("a settled sync costs six subrequests and reads only ten runs", async () => {
    const send = observe();
    expect((await getSyncStatus(env, now)).latest_attempt?.state).toBe("unchanged");
    expect(send).toHaveBeenCalledTimes(6);
    expect(statusReads(send).sort()).toEqual(["12", "2"]);
    const runs = send.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes("/runs?"));
    expect(runs).toContain("per_page=10");
  });
  it("reads receipt statuses only for the latest and active runs out of 25 receipts", async () => {
    const send = observe({
      runs: [
        run(40, { created_at: "2026-10-04T10:40:00Z" }),
        run(39, { status: "in_progress", conclusion: null }),
      ],
      checks: Array.from({ length: 25 }, (_, index) => check(40 - index)),
    });
    const status = await getSyncStatus(env, now);
    expect(status.latest_attempt).toMatchObject({ run_id: "40", state: "unchanged" });
    expect(status.active_run).toMatchObject({ run_id: "39", state: "publishing" });
    expect(statusReads(send).sort()).toEqual(["2", "39", "40"]);
  });
  it("reads one receipt status when the latest run is also the active run", async () => {
    const send = observe({
      runs: [run(12, { status: "in_progress", conclusion: null })],
      states: { 12: { state: "in_progress", description: "SYNC_DEPLOYING" } },
    });
    expect((await getSyncStatus(env, now)).active_run?.state).toBe("publishing");
    expect(statusReads(send).filter((deployment) => deployment === "12")).toHaveLength(1);
  });
  it("still fails closed on an old malformed receipt whose status it never reads", async () => {
    const send = observe({
      checks: [check(12), check(11), check(10, { decision: "changed", identity: null })],
    });
    expect((await getSyncStatus(env, now)).error_code).toBe("github_response_invalid");
    expect(statusReads(send).filter((deployment) => deployment !== "2")).toEqual([]);
  });
  it("rejects two receipts for the same run attempt", async () => {
    observe({ checks: [check(12), { ...check(12), id: 13 }] });
    expect((await getSyncStatus(env, now)).error_code).toBe("github_response_invalid");
  });
  it("stops reading release statuses at the newest verified release", async () => {
    const releaseFor = (id: number) => ({
      ...release,
      id,
      payload: {
        ...release.payload,
        workflowUrl: `https://github.com/owner/site/actions/runs/${id}`,
      },
    });
    const send = observe({
      releases: [releaseFor(5), releaseFor(4), releaseFor(3)],
      states: { 5: { state: "failure", description: "Live verification failed" } },
    });
    expect((await getSyncStatus(env, now)).last_publish?.run_id).toBe("4");
    expect(statusReads(send).filter((deployment) => deployment !== "12")).toEqual(["5", "4"]);
  });
  it("a request lookup keeps the larger run page so older request IDs stay findable", async () => {
    const send = observe();
    await getSyncRequest(env, { request_id: requestId });
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]?.[0])).toContain("per_page=50");
  });
});
describe("manual sync dispatch", () => {
  it("binds acceptance to the actual GitHub run and always creates a fresh request", async () => {
    const send = vi.fn<typeof fetch>(async () => Response.json({ workflow_run_id: 123 }));
    vi.stubGlobal("fetch", send);
    const result = await requestSync(env, { request_id: requestId });
    expect(result).toMatchObject({
      state: "accepted",
      run_id: "123",
      run_url: "https://github.com/owner/site/actions/runs/123",
    });
    const init = send.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body)).inputs).toMatchObject({
      operation: "release",
      trigger: "manual",
      request_id: requestId,
      force_build: false,
      allow_empty: false,
    });
  });
  it.each([204, 500, 408])("does not invent a run or retry after HTTP %s", async (code) => {
    const send = vi.fn(async () => new Response(null, { status: code }));
    vi.stubGlobal("fetch", send);
    expect((await requestSync(env, { request_id: requestId })).state).toBe("unconfirmed");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("resolves a lost acceptance response by exact request identity without dispatching", async () => {
    const send = observe({ releases: [], checks: [] });
    const result = await getSyncRequest(env, { request_id: requestId });
    expect(result.run_id).toBe("12");
    expect(send.mock.calls.every((call) => !String(call[0]).includes("/dispatches"))).toBe(true);
  });
  it("does not associate another request's task with this request", async () => {
    observe({ runs: [run(12, { display_title: "Website release (cron)" })] });
    expect((await getSyncRequest(env, { request_id: requestId })).state).toBe("unconfirmed");
  });
  it("refuses invalid request input before any external call", async () => {
    const send = vi.fn();
    vi.stubGlobal("fetch", send);
    await expect(requestSync(env, { request_id: requestId, workflow: "other" })).rejects.toThrow(
      "invalid_input",
    );
    expect(send).not.toHaveBeenCalled();
  });
});
