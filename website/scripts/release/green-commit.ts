/**
 * Which main commit a release may build: the newest one whose push run of ci.yml passed the CI gate
 * (the monorepo's single required check). A release never deploys code that CI has not passed: not a
 * [skip ci] commit, not a commit whose checks failed or are still running.
 *
 * This file has no dependencies and only erasable TypeScript, so website-release.yml runs it with plain
 * `node` before `pnpm install` (the newest main is not trusted to install and run anything yet):
 *
 *   node scripts/release/green-commit.ts   # prints the SHA, run in a full clone of main
 *
 * `pnpm release context` then checks the pinned commit again with the pinned code.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const GATE_CHECK_NAME = "CI gate";
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
/** How many first-parent commits of main are searched for a passed gate. */
export const MAX_CANDIDATES = 50;

export interface GreenCommitOptions {
  apiUrl: string;
  token: string;
  repository: string;
  fetchImpl?: typeof fetch;
}

const SHA = /^[0-9a-f]{40}$/;

async function getJson(options: GreenCommitOptions, pathname: string): Promise<unknown> {
  if (!options.token) throw new Error("GITHUB_TOKEN is required to read the CI results.");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * True when a completed, successful "CI gate" check of GitHub Actions belongs to a ci.yml run
 * triggered by a push to main for exactly this commit. Push runs diff from the last successful main
 * run (.github/scripts/ci_changes.py), so a passed gate means every website change up to this commit
 * passed Website checks. Pull-request and branch runs do not count.
 */
export async function passedGate(options: GreenCommitOptions, sha: string): Promise<boolean> {
  if (!SHA.test(sha)) throw new Error("A commit SHA must be 40 lowercase hex characters.");
  const listing = await getJson(
    options,
    `/commits/${sha}/check-runs?check_name=${encodeURIComponent(GATE_CHECK_NAME)}&filter=latest&per_page=100`,
  );
  const runs = isRecord(listing) && Array.isArray(listing.check_runs) ? listing.check_runs : [];
  for (const check of runs) {
    if (!isRecord(check) || check.name !== GATE_CHECK_NAME) continue;
    if (check.status !== "completed" || check.conclusion !== "success") continue;
    if (check.head_sha !== sha) continue;
    if (!isRecord(check.app) || check.app.slug !== "github-actions") continue;
    const match =
      typeof check.details_url === "string"
        ? /\/actions\/runs\/(\d+)\/job\/\d+/.exec(check.details_url)
        : null;
    if (!match) continue;
    const run = await getJson(options, `/actions/runs/${match[1]}`);
    if (
      isRecord(run) &&
      typeof run.path === "string" &&
      run.path.split("@", 1)[0] === CI_WORKFLOW_PATH &&
      run.event === "push" &&
      run.head_branch === "main" &&
      run.head_sha === sha &&
      isRecord(run.repository) &&
      run.repository.full_name === options.repository
    ) {
      return true;
    }
  }
  return false;
}

/** The newest candidate (newest first) that passed the gate. */
export async function newestGreenCommit(
  options: GreenCommitOptions,
  candidates: readonly string[],
): Promise<string> {
  for (const sha of candidates.slice(0, MAX_CANDIDATES)) {
    if (await passedGate(options, sha)) return sha;
  }
  throw new Error(
    `None of the newest ${Math.min(candidates.length, MAX_CANDIDATES)} commits on main passed the CI gate; nothing to release.`,
  );
}

/** The first-parent history of the checked-out main, newest first. */
export function mainCandidates(cwd: string): string[] {
  const output = execFileSync(
    "git",
    ["rev-list", "--first-parent", `--max-count=${MAX_CANDIDATES}`, "HEAD"],
    { cwd, encoding: "utf8" },
  );
  return output.split("\n").filter((line) => SHA.test(line));
}

export function optionsFromEnvironment(env: NodeJS.ProcessEnv = process.env): GreenCommitOptions {
  const repository = env.GITHUB_REPOSITORY ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be owner/name.");
  }
  return {
    apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
    token: env.GITHUB_TOKEN ?? "",
    repository,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  newestGreenCommit(optionsFromEnvironment(), mainCandidates(process.cwd()))
    .then((sha) => {
      process.stdout.write(`${sha}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `green-commit error: ${error instanceof Error ? error.message : "failed"}\n`,
      );
      process.exitCode = 1;
    });
}
