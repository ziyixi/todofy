import type { RelayEnv } from "./env";

/** Fixed inputs of website-release.yml; the relay never forwards anything from a request. */
export interface DispatchInputs {
  operation: "release" | "status";
  confirmation: string;
  force_build: false;
  allow_empty: false;
  trigger: "button" | "cron" | "reconcile";
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
  status: string;
  conclusion: string | null;
  createdAt: number;
  startedAt: number;
  updatedAt: number;
  /** From the run name "Website <operation> (<trigger>)"; null for other names. */
  operation: string | null;
  trigger: string | null;
}

const RUN_NAME =
  /^Website (release|status|bootstrap|recovery) \((manual|button|cron|reconcile|push)\)$/;

export function workflowApi(env: RelayEnv): string {
  return `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${env.RELEASE_WORKFLOW}`;
}

export function workflowUrl(env: RelayEnv): string {
  return `https://github.com/${env.GITHUB_REPOSITORY}/actions/workflows/${env.RELEASE_WORKFLOW}`;
}

export function runUrl(env: RelayEnv, id: number): string {
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

function time(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** Parses GitHub's run listing; null when the shape is unexpected. */
export function parseRuns(listing: unknown): RunSummary[] | null {
  if (!listing || typeof listing !== "object") return null;
  const runs = (listing as { workflow_runs?: unknown }).workflow_runs;
  if (!Array.isArray(runs)) return null;
  const parsed: RunSummary[] = [];
  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    const value = run as Record<string, unknown>;
    if (value.head_branch !== "main" || typeof value.id !== "number") continue;
    const name =
      typeof value.display_title === "string" ? RUN_NAME.exec(value.display_title) : null;
    const createdAt = time(value.created_at);
    parsed.push({
      id: value.id,
      status: typeof value.status === "string" ? value.status : "unknown",
      conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
      createdAt,
      startedAt: Number.isFinite(time(value.run_started_at))
        ? time(value.run_started_at)
        : createdAt,
      updatedAt: Number.isFinite(time(value.updated_at)) ? time(value.updated_at) : createdAt,
      operation: name?.[1] ?? null,
      trigger: name?.[2] ?? null,
    });
  }
  return parsed.sort((left, right) => right.createdAt - left.createdAt);
}

/** workerd supports redirect "manual"/"follow" only; manual plus a status check never forwards the token. */
export async function listRuns(env: RelayEnv, signal: AbortSignal): Promise<Response> {
  return fetch(`${workflowApi(env)}/runs?branch=main&per_page=50`, {
    headers: githubHeaders(env),
    signal,
    redirect: "manual",
  });
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

export function releaseInputs(env: RelayEnv, trigger: DispatchInputs["trigger"]): DispatchInputs {
  return {
    operation: "release",
    confirmation: `release:${env.CANONICAL_HOST}`,
    force_build: false,
    allow_empty: false,
    trigger,
  };
}

export function statusInputs(env: RelayEnv): DispatchInputs {
  return {
    operation: "status",
    confirmation: `status:${env.CANONICAL_HOST}`,
    force_build: false,
    allow_empty: false,
    trigger: "button",
  };
}
