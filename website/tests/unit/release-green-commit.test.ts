import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_CANDIDATES,
  mainCandidates,
  newestGreenCommit,
  passedGate,
  type GreenCommitOptions,
} from "../../scripts/release/green-commit";

const REPO = "ziyixi/todofy";
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

interface Gate {
  sha: string;
  runId: number;
  conclusion?: string | null;
  status?: string;
  app?: string;
  event?: string;
  branch?: string;
  path?: string;
}

/** A fake GitHub API: CI gate check runs per commit and the workflow runs they belong to. */
function github(gates: Gate[]) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    const checks = /^\/repos\/ziyixi\/todofy\/commits\/([0-9a-f]{40})\/check-runs$/.exec(
      url.pathname,
    );
    if (checks) {
      expect(url.searchParams.get("check_name")).toBe("CI gate");
      return Response.json({
        check_runs: gates
          .filter((gate) => gate.sha === checks[1])
          .map((gate) => ({
            name: "CI gate",
            head_sha: gate.sha,
            status: gate.status ?? "completed",
            conclusion: gate.conclusion === undefined ? "success" : gate.conclusion,
            app: { slug: gate.app ?? "github-actions" },
            details_url: `https://github.com/${REPO}/actions/runs/${gate.runId}/job/${gate.runId * 10}`,
          })),
      });
    }
    const run = /^\/repos\/ziyixi\/todofy\/actions\/runs\/(\d+)$/.exec(url.pathname);
    const gate = run ? gates.find((entry) => entry.runId === Number(run[1])) : undefined;
    if (gate) {
      return Response.json({
        path: gate.path ?? ".github/workflows/ci.yml",
        event: gate.event ?? "push",
        head_branch: gate.branch ?? "main",
        head_sha: gate.sha,
        repository: { full_name: REPO },
      });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const options: GreenCommitOptions = {
    apiUrl: "https://api.github.com",
    token: "t",
    repository: REPO,
    fetchImpl,
  };
  return { options, calls };
}

describe("the commit a release builds", () => {
  it("accepts a successful CI gate of a push run of ci.yml on main for exactly that commit", async () => {
    const { options } = github([{ sha: A, runId: 1 }]);
    await expect(passedGate(options, A)).resolves.toBe(true);
  });

  it("does not count failed, running, pull-request, branch or other-workflow gates", async () => {
    for (const gate of [
      { conclusion: "failure" },
      { status: "in_progress", conclusion: null },
      { event: "pull_request" },
      { branch: "feature" },
      { path: ".github/workflows/other.yml" },
      { app: "some-other-app" },
    ]) {
      const { options } = github([{ sha: A, runId: 1, ...gate }]);
      await expect(passedGate(options, A), JSON.stringify(gate)).resolves.toBe(false);
    }
  });

  it("skips newer [skip ci], red or still-running commits and builds the newest green one", async () => {
    const { options } = github([
      { sha: B, runId: 2, conclusion: "failure" },
      { sha: C, runId: 3 },
    ]);
    // A has no run at all (a [skip ci] commit or part of a multi-commit push).
    await expect(newestGreenCommit(options, [A, B, C])).resolves.toBe(C);
  });

  it("refuses to release when no recent commit passed the gate, and needs a token", async () => {
    const { options, calls } = github([]);
    const many = Array.from({ length: MAX_CANDIDATES + 5 }, (_, index) =>
      index.toString(16).padStart(40, "0"),
    );
    await expect(newestGreenCommit(options, many)).rejects.toThrow(/passed the CI gate/);
    expect(calls).toHaveLength(MAX_CANDIDATES);
    await expect(passedGate({ ...options, token: "" }, A)).rejects.toThrow(/GITHUB_TOKEN/);
    await expect(passedGate(options, "HEAD")).rejects.toThrow(/40 lowercase/);
  });
});

/**
 * A landing in a throwaway repository: main is a, then x (landed while the branch was open); the branch
 * forked at a, merged x in (the branch stays the first parent) and main was fast-forwarded to its tip.
 */
async function landing(xCommitterDate?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "website-green-commit-"));
  const git = (args: string[], env: Record<string, string> = {}) =>
    execFileSync("git", ["-c", "user.name=ci", "-c", "user.email=ci@example.org", ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env },
    }).trim();
  const commit = async (name: string, env: Record<string, string> = {}) => {
    await writeFile(path.join(root, name), name);
    git(["add", "-A"]);
    git(["commit", "-qm", name], env);
    return git(["rev-parse", "HEAD"]);
  };
  git(["init", "-q"]);
  const a = await commit("a");
  git(["checkout", "-qb", "feature"]);
  await commit("b1");
  git(["checkout", "-q", "-"]);
  const x = await commit("x", xCommitterDate ? { GIT_COMMITTER_DATE: xCommitterDate } : {});
  git(["checkout", "-q", "feature"]);
  git(["merge", "-q", "--no-ff", "--no-edit", x]);
  const tip = await commit("t");
  return { root, a, x, tip, firstParents: git(["rev-list", "--first-parent", tip]).split("\n") };
}

describe("the candidates of main", () => {
  for (const [name, date] of [
    ["a landing that merged main into its branch", undefined],
    ["the same landing with x dated before a (a clock that ran behind)", "2001-01-01T00:00:00Z"],
  ] as const) {
    it(`release the previous main head after ${name}, not the branch's fork point`, async () => {
      const { root, a, x, tip, firstParents } = await landing(date);
      try {
        expect(firstParents).not.toContain(x);
        const candidates = mainCandidates(root);
        expect(candidates[0]).toBe(tip);
        // The tip's CI is still running; a and x passed the gate.
        const { options } = github([
          { sha: a, runId: 1 },
          { sha: x, runId: 2 },
        ]);
        await expect(newestGreenCommit(options, candidates)).resolves.toBe(x);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
