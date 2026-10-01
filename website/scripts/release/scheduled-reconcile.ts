/**
 * The daily reconcile release without the Notion relay (docs/release.md, "Daily schedule"). The relay's
 * change detector dispatches one `release` (trigger `reconcile`) at its first tick at or after 10:00 UTC;
 * website-release.yml also runs on a GitHub Actions schedule at 10:30 UTC, and its first job runs this
 * file to decide whether that run goes on to the release job. It reconciles only when the relay's
 * reconcile would have dispatched and the release gate would let an ordinary release through:
 *
 *   NO_RELEASE_RECORD  no website-release record yet (bootstrap first): skip
 *   RECOVERY_GATE      the latest record is not `success`: only recovery may cross the gate: skip
 *   RECONCILED_TODAY   a reconcile run (the relay's or an earlier scheduled one) was created today: skip
 *   FAILURES_TODAY     3 release runs failed today (the relay's failure stop): skip
 *   RECONCILE          otherwise: the release job runs an ordinary release (identity unchanged = no deploy)
 *
 * The release job enforces the gate again; this only keeps a blocked or already reconciled day from
 * starting a run that would fail or repeat. It has no dependencies and only erasable TypeScript, so the
 * job runs it with plain `node` (no install) on the newest CI-green main commit, with a GITHUB_TOKEN that
 * may only read Actions runs and Deployments. It prints result codes only, never a response body.
 *
 *   node scripts/release/scheduled-reconcile.ts   # writes reconcile=true|false and code=<CODE>
 */
import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The run name of a scheduled run (website-release.yml `run-name`). The relay's RUN_NAME does not match it. */
export const SCHEDULED_RUN_NAME = "Website scheduled reconcile";
/** The relay's run-name parser (relay/src/github.ts): "Website <operation> (<trigger>)". */
export const DISPATCHED_RUN_NAME =
  /^Website (release|status|bootstrap|recovery) \((manual|button|cron|reconcile|pending|push)\)$/;
/** As the relay's MAX_FAILED_RELEASES_PER_DAY (relay/src/detector.ts). */
export const MAX_FAILED_RELEASES_PER_DAY = 3;
/** The release records (payload.ts RELEASE_ENVIRONMENT and RELEASE_TASK). */
export const RECORD_ENVIRONMENT = "production";
export const RECORD_TASK = "website-release";
export const RELEASE_WORKFLOW = "website-release.yml";

export interface RunInfo {
  id: number;
  name: string;
  createdAt: number;
  conclusion: string | null;
}

export type ScheduledCode =
  "NO_RELEASE_RECORD" | "RECOVERY_GATE" | "RECONCILED_TODAY" | "FAILURES_TODAY" | "RECONCILE";

export interface ScheduledDecision {
  reconcile: boolean;
  code: ScheduledCode;
}

function utcMidnight(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function isReconcile(run: RunInfo): boolean {
  return run.name === SCHEDULED_RUN_NAME || DISPATCHED_RUN_NAME.exec(run.name)?.[2] === "reconcile";
}

function isRelease(run: RunInfo): boolean {
  return run.name === SCHEDULED_RUN_NAME || DISPATCHED_RUN_NAME.exec(run.name)?.[1] === "release";
}

/**
 * `latestState` is the newest status of the newest website-release record, or null without any record.
 * `runs` are this workflow's runs on main; the current run is left out by its ID.
 */
export function decideScheduled(input: {
  now: number;
  currentRunId: number;
  runs: readonly RunInfo[];
  latestState: string | null;
}): ScheduledDecision {
  if (input.latestState === null) return { reconcile: false, code: "NO_RELEASE_RECORD" };
  if (input.latestState !== "success") return { reconcile: false, code: "RECOVERY_GATE" };
  const today = utcMidnight(input.now);
  const others = input.runs.filter(
    (run) =>
      run.id !== input.currentRunId && Number.isFinite(run.createdAt) && run.createdAt >= today,
  );
  if (others.some(isReconcile)) return { reconcile: false, code: "RECONCILED_TODAY" };
  const failed = others.filter((run) => isRelease(run) && run.conclusion === "failure").length;
  if (failed >= MAX_FAILED_RELEASES_PER_DAY) return { reconcile: false, code: "FAILURES_TODAY" };
  return { reconcile: true, code: "RECONCILE" };
}

export interface GitHubOptions {
  apiUrl: string;
  token: string;
  repository: string;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function getJson(options: GitHubOptions, pathname: string): Promise<unknown> {
  if (!options.token) throw new Error("GITHUB_TOKEN is required to read the runs and records.");
  const response = await (options.fetchImpl ?? fetch)(
    `${options.apiUrl}/repos/${options.repository}${pathname}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  );
  // Never echo the response body.
  if (!response.ok) throw new Error(`GitHub GET ${pathname} failed with HTTP ${response.status}.`);
  return (await response.json()) as unknown;
}

function time(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

/** The newest 50 runs of the release workflow on main (what the relay lists too). */
export async function listRuns(options: GitHubOptions): Promise<RunInfo[]> {
  const listing = await getJson(
    options,
    `/actions/workflows/${RELEASE_WORKFLOW}/runs?branch=main&per_page=50`,
  );
  if (!isRecord(listing) || !Array.isArray(listing.workflow_runs)) {
    throw new Error("GitHub returned an unexpected run listing.");
  }
  const runs: RunInfo[] = [];
  for (const run of listing.workflow_runs) {
    if (!isRecord(run) || typeof run.id !== "number" || run.head_branch !== "main") continue;
    runs.push({
      id: run.id,
      name: typeof run.display_title === "string" ? run.display_title : "",
      createdAt: time(run.created_at),
      conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
    });
  }
  return runs;
}

type Row = Record<string, unknown> & { id: number; created_at: string };

/** The newest row of one page (records and statuses): by creation time, then ID. */
function newest(rows: unknown): Row | undefined {
  if (!Array.isArray(rows)) throw new Error("GitHub returned a non-array page.");
  return rows
    .filter(
      (row): row is Row =>
        isRecord(row) && typeof row.id === "number" && typeof row.created_at === "string",
    )
    .sort(
      (left, right) => right.created_at.localeCompare(left.created_at) || right.id - left.id,
    )[0];
}

/** The newest status of the newest website-release record (as the release's gate reads it), or null. */
export async function latestRecordState(options: GitHubOptions): Promise<string | null> {
  const record = newest(
    await getJson(
      options,
      `/deployments?environment=${RECORD_ENVIRONMENT}&task=${RECORD_TASK}&per_page=100`,
    ),
  );
  if (!record) return null;
  const status = newest(await getJson(options, `/deployments/${record.id}/statuses?per_page=100`));
  return typeof status?.state === "string" ? status.state : "missing";
}

export async function main(
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
): Promise<ScheduledDecision> {
  const repository = env.GITHUB_REPOSITORY ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be owner/name.");
  }
  const currentRunId = Number(env.GITHUB_RUN_ID);
  if (!Number.isSafeInteger(currentRunId)) throw new Error("GITHUB_RUN_ID must be the run's ID.");
  const options = {
    apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
    token: env.GITHUB_TOKEN ?? "",
    repository,
  };
  const decision = decideScheduled({
    now,
    currentRunId,
    runs: await listRuns(options),
    latestState: await latestRecordState(options),
  });
  const lines = `reconcile=${decision.reconcile}\ncode=${decision.code}\n`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines);
  process.stdout.write(lines);
  return decision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .then((decision) => {
      process.stdout.write(
        decision.reconcile
          ? "::notice::Daily reconcile release: due; the release job runs an ordinary release.\n"
          : `::notice::Daily reconcile release skipped (${decision.code}); nothing was released.\n`,
      );
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `scheduled-reconcile error: ${error instanceof Error ? error.message : "failed"}\n`,
      );
      process.exitCode = 1;
    });
}
