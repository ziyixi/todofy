import type { RelayEnv } from "./env";

export interface DispatchInputs {
  operation: "release";
  confirmation: string;
  force_build: false;
  allow_empty: false;
  trigger: "manual" | "cron";
  request_id: string;
}

export const ACTIVE_STATUSES = new Set([
  "queued",
  "in_progress",
  "requested",
  "waiting",
  "pending",
]);
export interface RunSummary {
  id: number;
  attempt: number;
  status: string;
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
  requestId: string | null;
}

export function workflowApi(env: RelayEnv): string {
  return `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${env.RELEASE_WORKFLOW}`;
}
export function runUrl(env: RelayEnv, id: number | string): string {
  return `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${id}`;
}
export function githubHeaders(env: RelayEnv): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "ziyixi-notion-publish",
  };
}
export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function utc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
export function id(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Only bounded provider metadata is returned; never include a provider response in an error. */
export async function githubJson(
  env: RelayEnv,
  path: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}${path}`, {
    headers: githubHeaders(env),
    signal,
    redirect: "manual",
  });
  if (!response.ok)
    throw new Error(response.status === 403 ? "github_permission_denied" : "github_unavailable");
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error("github_response_invalid");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("github_response_invalid");
  }
}
export function parseRuns(listing: unknown): RunSummary[] {
  const rows = object(listing)?.workflow_runs;
  if (!Array.isArray(rows)) throw new Error("github_response_invalid");
  return rows
    .flatMap((row) => {
      const run = object(row);
      if (
        !run ||
        run.head_branch !== "main" ||
        !id(run.id) ||
        !id(run.run_attempt) ||
        !utc(run.created_at) ||
        !utc(run.updated_at)
      )
        return [];
      const requestId =
        typeof run.display_title === "string"
          ? (/\[([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]/.exec(
              run.display_title,
            )?.[1] ?? null)
          : null;
      return [
        {
          id: run.id,
          attempt: run.run_attempt,
          status: typeof run.status === "string" ? run.status : "unknown",
          conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
          createdAt: run.created_at,
          updatedAt: run.updated_at,
          requestId,
        },
      ];
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id);
}
/** A request lookup must still find its run after later releases, so it reads the larger page. */
export const LOOKUP_RUN_PAGE = 50;
/** Each run is ~11 KiB of JSON; read only as many as the caller can use. */
export async function listRuns(
  env: RelayEnv,
  perPage: number,
  signal: AbortSignal,
): Promise<RunSummary[]> {
  return parseRuns(
    await githubJson(
      env,
      `/actions/workflows/${env.RELEASE_WORKFLOW}/runs?branch=main&per_page=${perPage}`,
      signal,
    ),
  );
}
export async function dispatch(
  env: RelayEnv,
  inputs: DispatchInputs,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(`${workflowApi(env)}/dispatches`, {
    method: "POST",
    headers: { ...githubHeaders(env), "Content-Type": "application/json" },
    signal,
    redirect: "manual",
    body: JSON.stringify({ ref: "main", inputs }),
  });
}
export function releaseInputs(
  env: RelayEnv,
  trigger: DispatchInputs["trigger"],
  requestId: string,
): DispatchInputs {
  return {
    operation: "release",
    confirmation: `release:${env.CANONICAL_HOST}`,
    force_build: false,
    allow_empty: false,
    trigger,
    request_id: requestId,
  };
}
