/**
 * The daily reconcile release without the Notion relay (docs/release.md, "Daily schedule"): the dispatch
 * half. It runs in the second job of a scheduled run of website-release.yml, only after the secret-free
 * check (scheduled-reconcile.ts) found the reconcile due, on the newest CI-green main commit after
 * `pnpm install`, with the production environment's Notion credentials (read only here) and a
 * GITHUB_TOKEN that may dispatch workflows. It never releases by itself:
 *
 *   1. checks again with fresh runs and the latest record (scheduled-reconcile.ts decideScheduled);
 *   2. reads Notion exactly as the relay's detector does (readNotionRows) and holds while the relay would
 *      (QUIET_PERIOD: an author edit newer than the relay's QUIET_MINUTES; FAILURES_TODAY): the next
 *      scheduled hour checks again;
 *   3. otherwise dispatches the relay's exact reconcile release (releaseInputs(relay, "reconcile"): run
 *      name "Website release (reconcile)"), so the relay sees it like its own (running release, release
 *      window, today's reconcile, failures), and waits until GitHub lists it.
 *
 * The relay's settings and names come from relay/wrangler.toml [vars]. Prints result codes only, never a
 * token, a response body or Notion content.
 *
 *   node --import tsx scripts/release/scheduled-dispatch.ts   # writes dispatched=true|false and code=<CODE>
 */
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parse } from "smol-toml";

import { decide, readNotionRows, releaseWindow, settingsFrom } from "../../relay/src/detector";
import type { RelayEnv } from "../../relay/src/env";
import { parseRuns, releaseInputs } from "../../relay/src/github";
import {
  decideScheduled,
  getRunListing,
  latestRecordState,
  RELEASE_WORKFLOW,
  runContext,
  runsFromListing,
  type GitHubOptions,
  type ScheduledCode,
} from "./scheduled-reconcile";

export const RECONCILE_RUN_NAME = "Website release (reconcile)";
/** How long to wait until GitHub lists the dispatched run (polls × interval). */
export const LISTED_POLLS = 12;
export const LISTED_INTERVAL_MS = 5_000;

export type DispatchCode =
  | Exclude<ScheduledCode, "DUE">
  | "QUIET_PERIOD"
  | "NOTION_UNAVAILABLE"
  | "DISPATCHED"
  | "DISPATCHED_NOT_LISTED";

export interface DispatchResult {
  dispatched: boolean;
  code: DispatchCode;
}

type RelayVars = Pick<
  RelayEnv,
  | "GITHUB_REPOSITORY"
  | "RELEASE_WORKFLOW"
  | "CANONICAL_HOST"
  | "NOTION_API_VERSION"
  | "QUIET_MINUTES"
  | "MAX_AUTO_RELEASES_PER_DAY"
  | "RECONCILE_UTC_HOUR"
  | "IGNORED_EDITOR_IDS"
>;

/** The relay's committed vars; they must name this repository, this workflow and this site. */
export async function readRelayVars(
  file: string,
  expected: { repository: string; siteUrl: string },
): Promise<RelayVars> {
  const config = parse(await readFile(file, "utf8")) as { vars?: Record<string, unknown> };
  const vars = Object.fromEntries(
    Object.entries(config.vars ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  ) as Partial<RelayVars>;
  const relay: RelayVars = {
    GITHUB_REPOSITORY: vars.GITHUB_REPOSITORY ?? "",
    RELEASE_WORKFLOW: vars.RELEASE_WORKFLOW ?? "",
    CANONICAL_HOST: vars.CANONICAL_HOST ?? "",
    NOTION_API_VERSION: vars.NOTION_API_VERSION ?? "",
    QUIET_MINUTES: vars.QUIET_MINUTES,
    MAX_AUTO_RELEASES_PER_DAY: vars.MAX_AUTO_RELEASES_PER_DAY,
    RECONCILE_UTC_HOUR: vars.RECONCILE_UTC_HOUR,
    IGNORED_EDITOR_IDS: vars.IGNORED_EDITOR_IDS,
  };
  if (relay.GITHUB_REPOSITORY !== expected.repository) {
    throw new Error("relay/wrangler.toml GITHUB_REPOSITORY is not this repository.");
  }
  if (relay.RELEASE_WORKFLOW !== RELEASE_WORKFLOW) {
    throw new Error(`relay/wrangler.toml RELEASE_WORKFLOW is not ${RELEASE_WORKFLOW}.`);
  }
  if (relay.CANONICAL_HOST !== new URL(expected.siteUrl).host) {
    throw new Error("relay/wrangler.toml CANONICAL_HOST is not the SITE_URL host.");
  }
  if (!relay.NOTION_API_VERSION) throw new Error("relay/wrangler.toml has no NOTION_API_VERSION.");
  return relay;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function scheduledDispatch(input: {
  now: number;
  currentRunId: number;
  options: GitHubOptions;
  relay: RelayVars;
  notion: { token: string; dataSourceId: string };
  wait?: (ms: number) => Promise<void>;
}): Promise<DispatchResult> {
  const { now, currentRunId, options, relay } = input;
  const fetchImpl = options.fetchImpl ?? fetch;
  // 1. Again, with fresh runs: a reconcile or a release may have started since the check job.
  const listing = await getRunListing(options);
  const check = decideScheduled({
    now,
    currentRunId,
    runs: runsFromListing(listing),
    latestState: await latestRecordState(options),
  });
  if (!check.due) return { dispatched: false, code: check.code as Exclude<ScheduledCode, "DUE"> };

  // 2. The relay's quiet period, with the relay's own reading of runs and Notion.
  const runs = parseRuns(listing);
  if (!runs) throw new Error("GitHub returned an unexpected run listing.");
  const env: RelayEnv = {
    ...relay,
    NOTION_TOKEN: input.notion.token,
    NOTION_DATA_SOURCE_ID: input.notion.dataSourceId,
  };
  const read = await readNotionRows(
    env,
    releaseWindow(runs, now),
    now,
    AbortSignal.timeout(20_000),
  );
  if ("failure" in read) return { dispatched: false, code: "NOTION_UNAVAILABLE" };
  const relayDecision = decide({ now, runs, rows: read.rows, settings: settingsFrom(env) });
  if (relayDecision.action === "skip") {
    if (relayDecision.code === "QUIET_PERIOD") return { dispatched: false, code: "QUIET_PERIOD" };
    if (relayDecision.code === "FAILURES_TODAY")
      return { dispatched: false, code: "FAILURES_TODAY" };
  }

  // 3. The relay's reconcile dispatch, by this run's GITHUB_TOKEN (a workflow_dispatch by GITHUB_TOKEN
  // starts a run, as Website deploy's does).
  const before = new Set(runs.map((run) => run.id));
  const response = await fetchImpl(
    `${options.apiUrl}/repos/${options.repository}/actions/workflows/${RELEASE_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: releaseInputs(env, "reconcile") }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  );
  // Never echo the response body.
  if (response.status !== 200 && response.status !== 204) {
    throw new Error(`GitHub dispatch failed with HTTP ${response.status}.`);
  }
  // Until GitHub lists the new run, the relay could not see it; wait so this run (which the relay sees
  // as running) ends only after the dispatched one is visible.
  const wait = input.wait ?? sleep;
  for (let poll = 0; poll < LISTED_POLLS; poll += 1) {
    await wait(LISTED_INTERVAL_MS);
    const listed = runsFromListing(await getRunListing(options));
    if (listed.some((run) => !before.has(run.id) && run.name === RECONCILE_RUN_NAME)) {
      return { dispatched: true, code: "DISPATCHED" };
    }
  }
  return { dispatched: true, code: "DISPATCHED_NOT_LISTED" };
}

export async function main(
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
  relayConfig = path.join(process.cwd(), "relay", "wrangler.toml"),
): Promise<DispatchResult> {
  const { currentRunId, options } = runContext(env);
  if (!env.NOTION_TOKEN || !env.NOTION_DATA_SOURCE_ID) {
    throw new Error("NOTION_TOKEN and NOTION_DATA_SOURCE_ID are required.");
  }
  const relay = await readRelayVars(relayConfig, {
    repository: options.repository,
    siteUrl: env.SITE_URL ?? "",
  });
  const result = await scheduledDispatch({
    now,
    currentRunId,
    options,
    relay,
    notion: { token: env.NOTION_TOKEN, dataSourceId: env.NOTION_DATA_SOURCE_ID },
  });
  const lines = `dispatched=${result.dispatched}\ncode=${result.code}\n`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines);
  process.stdout.write(lines);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .then((result) => {
      process.stdout.write(
        result.code === "DISPATCHED"
          ? `::notice::Dispatched ${RECONCILE_RUN_NAME}; see Actions → Website release.\n`
          : result.code === "DISPATCHED_NOT_LISTED"
            ? `::warning::Dispatched ${RECONCILE_RUN_NAME}, but GitHub did not list it within a minute.\n`
            : result.code === "NOTION_UNAVAILABLE"
              ? "::warning::Daily reconcile release held: Notion did not answer; the next scheduled hour checks again.\n"
              : `::notice::Daily reconcile release not dispatched (${result.code}).\n`,
      );
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `scheduled-dispatch error: ${error instanceof Error ? error.message : "failed"}\n`,
      );
      process.exitCode = 1;
    });
}
