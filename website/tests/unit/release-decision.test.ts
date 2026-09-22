import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const repositoryRoot = process.cwd();
const identity = {
  codeSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  configHash: "b".repeat(64),
  contentHash: "c".repeat(64),
  schemaVersion: 1,
};

async function releaseDecision(options: {
  baseline: typeof identity | null;
  forceBuild?: boolean;
  operation?: "bootstrap" | "recovery" | "release";
  expected?: typeof identity;
}) {
  const directory = await mkdtemp(path.join(tmpdir(), "ziyixi-release-decision-test-"));
  temporaryDirectories.push(directory);
  const buildInfo = path.join(directory, "build-info.json");
  const gateState = path.join(directory, "gate-state.json");
  const githubOutput = path.join(directory, "github-output.txt");
  await Promise.all([
    writeFile(buildInfo, `${JSON.stringify(options.expected ?? identity)}\n`, "utf8"),
    writeFile(
      gateState,
      `${JSON.stringify({
        schemaVersion: 1,
        baseline: options.baseline ? { payload: { identity: options.baseline } } : null,
      })}\n`,
      "utf8",
    ),
    writeFile(githubOutput, "", "utf8"),
  ]);

  const result = await execFileAsync(
    "bash",
    [
      "scripts/release/decide-release.sh",
      "--operation",
      options.operation ?? "release",
      "--expected-build-info",
      buildInfo,
      "--gate-state",
      gateState,
      "--force-build",
      String(options.forceBuild ?? false),
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, GITHUB_OUTPUT: githubOutput },
    },
  );
  return { ...result, output: await readFile(githubOutput, "utf8") };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("production deployment decision", () => {
  it("skips an unchanged normal release without creating a new record", async () => {
    const result = await releaseDecision({ baseline: identity });
    expect(result.output).toContain("deploy_required=false");
    expect(result.output).toContain("reason=identity-unchanged");
  });

  it("deploys a changed identity and an explicitly forced identity", async () => {
    const changed = await releaseDecision({
      baseline: identity,
      expected: { ...identity, contentHash: "d".repeat(64) },
    });
    expect(changed.output).toContain("deploy_required=true");
    expect(changed.output).toContain("reason=identity-changed");

    const forced = await releaseDecision({ baseline: identity, forceBuild: true });
    expect(forced.output).toContain("deploy_required=true");
    expect(forced.output).toContain("reason=explicit-force-build");
  });

  it("always rebuilds recovery even when the identity is unchanged", async () => {
    const result = await releaseDecision({ baseline: identity, operation: "recovery" });
    expect(result.output).toContain("deploy_required=true");
    expect(result.output).toContain("reason=recovery-always-rebuilds");
  });

  it("rejects a normal release without a trusted baseline", async () => {
    await expect(releaseDecision({ baseline: null })).rejects.toMatchObject({
      stderr: expect.stringContaining("normal release requires a trusted baseline identity"),
    });
  });
});

describe("trusted empty-collection confirmation", () => {
  const baseEnvironment = {
    ...process.env,
    ALLOW_EMPTY: "true",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_TYPE: "branch",
    GITHUB_REPOSITORY: "ziyixi/website",
    GITHUB_TOKEN: "test-github-token",
    RELEASE_OPERATION: "release",
    SITE_URL: "https://www.ziyixi.science",
    VERCEL_AUTOMATION_BYPASS_SECRET: "test-bypass-token",
    VERCEL_ORG_ID: "team_test",
    VERCEL_PROJECT_ID: "prj_test",
    VERCEL_TOKEN: "test-vercel-token",
  };

  async function productionContextEnvironment(rollingRelease = false) {
    const directory = await mkdtemp(path.join(tmpdir(), "ziyixi-production-context-test-"));
    temporaryDirectories.push(directory);
    const bin = path.join(directory, "bin");
    const curl = path.join(bin, "curl");
    await mkdir(bin);
    await writeFile(
      curl,
      `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
expected="https://api.vercel.com/v9/projects/\${VERCEL_PROJECT_ID}?rollbackInfo=true&teamId=\${VERCEL_ORG_ID}"
[[ "$url" == "$expected" ]]
if [[ "\${FAKE_ROLLING_RELEASE:-}" == true ]]; then
  printf '{"id":"%s","rollingRelease":{"enabled":true},"lastAliasRequest":null}\\n' "$VERCEL_PROJECT_ID"
else
  printf '{"id":"%s"}\\n' "$VERCEL_PROJECT_ID"
fi
`,
      "utf8",
    );
    await chmod(curl, 0o755);
    return {
      ...baseEnvironment,
      FAKE_ROLLING_RELEASE: String(rollingRelease),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };
  }

  it("requires the allow-empty suffix when the one-run switch is enabled", async () => {
    const contextEnvironment = await productionContextEnvironment();
    await expect(
      execFileAsync("bash", ["scripts/release/assert-production-context.sh"], {
        cwd: repositoryRoot,
        env: {
          ...contextEnvironment,
          RELEASE_CONFIRMATION: "release:www.ziyixi.science",
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("release:www.ziyixi.science:allow-empty"),
    });

    await expect(
      execFileAsync("bash", ["scripts/release/assert-production-context.sh"], {
        cwd: repositoryRoot,
        env: {
          ...contextEnvironment,
          RELEASE_CONFIRMATION: "release:www.ziyixi.science:allow-empty",
        },
      }),
    ).resolves.toMatchObject({
      stderr: expect.stringContaining("trusted production context accepted"),
    });
  });

  it("rejects a project with Rolling Releases before accepting production context", async () => {
    await expect(
      execFileAsync("bash", ["scripts/release/assert-production-context.sh"], {
        cwd: repositoryRoot,
        env: {
          ...(await productionContextEnvironment(true)),
          RELEASE_CONFIRMATION: "release:www.ziyixi.science:allow-empty",
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Rolling Releases must be disabled"),
    });
  });
});
