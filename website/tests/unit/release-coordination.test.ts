import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const temporaryDirectories: string[] = [];

const candidateIdentity = {
  codeSha: "a".repeat(40),
  configHash: "b".repeat(64),
  contentHash: "c".repeat(64),
  schemaVersion: 1,
};
const baselineIdentity = {
  ...candidateIdentity,
  codeSha: "d".repeat(40),
  contentHash: "e".repeat(64),
};

function deploymentPayload(options: {
  candidateId: string;
  candidateUrl: string;
  identity: typeof candidateIdentity;
  operation?: "bootstrap" | "recovery" | "release";
  previousId: string | null;
}) {
  return {
    schemaVersion: 2,
    task: "website-release",
    operation: options.operation ?? "release",
    identity: options.identity,
    candidateDeploymentId: options.candidateId,
    candidateDeploymentUrl: options.candidateUrl,
    previousProductionDeploymentId: options.previousId,
    contentRegistry: { registryVersion: 1, posts: {} },
    verificationContract: {
      canonicalOrigin: "https://www.ziyixi.science",
      emptyStateText: "Writing will appear here.",
      sourceMode: "empty",
      routes: [],
    },
  };
}

async function makeHarness() {
  const directory = await mkdtemp(path.join(tmpdir(), "ziyixi-release-coordination-test-"));
  temporaryDirectories.push(directory);
  const bin = path.join(directory, "bin");
  const log = path.join(directory, "commands.log");
  const current = path.join(directory, "current-id.txt");
  const githubOutput = path.join(directory, "github-output.txt");
  const buildInfo = path.join(directory, "candidate-build-info.json");
  await execFileAsync("mkdir", ["-p", bin]);
  await Promise.all([
    writeFile(log, "", "utf8"),
    writeFile(githubOutput, "", "utf8"),
    writeFile(buildInfo, `${JSON.stringify(candidateIdentity)}\n`, "utf8"),
    writeFile(
      path.join(bin, "pnpm"),
      `#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\\n' "$*" >>"$FAKE_COMMAND_LOG"
if [[ "\${1:-}" == exec && "\${2:-}" == vercel && "\${3:-}" == promote && "\${4:-}" == status ]]; then
  if [[ -n "\${FAKE_PROMOTE_SETTLE_TO:-}" ]]; then printf '%s\\n' "$FAKE_PROMOTE_SETTLE_TO" >"$FAKE_CURRENT_ID"; fi
  exit "\${FAKE_PROMOTE_STATUS_EXIT:-0}"
fi
if [[ "\${1:-}" == exec && "\${2:-}" == vercel && "\${3:-}" == rollback && "\${4:-}" == status ]]; then
  if [[ -n "\${FAKE_ROLLBACK_SETTLE_TO:-}" ]]; then printf '%s\\n' "$FAKE_ROLLBACK_SETTLE_TO" >"$FAKE_CURRENT_ID"; fi
  exit "\${FAKE_ROLLBACK_STATUS_EXIT:-0}"
fi
if [[ "\${1:-}" == exec && "\${2:-}" == vercel && "\${3:-}" == rollback ]]; then
  : >"$FAKE_ROLLBACK_REQUEST_FILE"
  if [[ "\${FAKE_ROLLBACK_EXIT:-0}" == 0 ]]; then printf '%s\\n' "$FAKE_RESTORE_ID" >"$FAKE_CURRENT_ID"; fi
  exit "\${FAKE_ROLLBACK_EXIT:-0}"
fi
if [[ "\${1:-}" == test:deployment ]]; then exit 0; fi
printf 'unexpected fake pnpm invocation: %s\\n' "$*" >&2
exit 91
`,
      "utf8",
    ),
    writeFile(
      path.join(bin, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\\n' "$*" >>"$FAKE_COMMAND_LOG"
url="\${!#}"
output=''
headers=''
for ((index=1; index<=$#; index++)); do
  value="\${!index}"
  if [[ "$value" == --output ]]; then next=$((index + 1)); output="\${!next}"; fi
  if [[ "$value" == --dump-header ]]; then next=$((index + 1)); headers="\${!next}"; fi
done
if [[ "$url" == https://api.vercel.com/v9/projects/* ]]; then
  if [[ -n "\${FAKE_ROLLING_RELEASE:-}" ]]; then
    printf '{"id":"%s","rollingRelease":{"enabled":true},"lastAliasRequest":null}\\n' "$VERCEL_PROJECT_ID"
    exit 0
  fi
  if [[ -n "\${FAKE_DELAYED_PROMOTION:-}" && ! -f "$FAKE_ROLLBACK_REQUEST_FILE" && "$(cat "$FAKE_CURRENT_ID")" != dpl_candidate ]]; then
    printf '%s\\n' dpl_candidate >"$FAKE_CURRENT_ID"
    printf '{"id":"%s","lastAliasRequest":{"jobStatus":"in-progress","type":"promote","toDeploymentId":"dpl_candidate"}}\\n' "$VERCEL_PROJECT_ID"
    exit 0
  fi
  if [[ -n "\${FAKE_DELAYED_PROMOTION:-}" && ! -f "$FAKE_ROLLBACK_REQUEST_FILE" ]]; then
    printf '%s\\n' dpl_candidate >"$FAKE_CURRENT_ID"
    printf '{"id":"%s","lastAliasRequest":{"jobStatus":"succeeded","type":"promote","toDeploymentId":"dpl_candidate"}}\\n' "$VERCEL_PROJECT_ID"
    exit 0
  fi
  if [[ -f "$FAKE_ROLLBACK_REQUEST_FILE" ]]; then
    if [[ -n "\${FAKE_ALIAS_STATUS_UNKNOWN:-}" ]]; then
      printf '{"id":"%s","lastAliasRequest":{"jobStatus":"mystery","type":"rollback","toDeploymentId":"%s"}}\\n' "$VERCEL_PROJECT_ID" "$FAKE_RESTORE_ID"
      exit 0
    fi
    if [[ -n "\${FAKE_ROLLBACK_SETTLE_TO:-}" ]]; then printf '%s\\n' "$FAKE_ROLLBACK_SETTLE_TO" >"$FAKE_CURRENT_ID"; fi
    printf '{"id":"%s","lastAliasRequest":{"jobStatus":"succeeded","type":"rollback","toDeploymentId":"%s"}}\\n' "$VERCEL_PROJECT_ID" "$FAKE_RESTORE_ID"
    exit 0
  fi
  printf '{"id":"%s","lastAliasRequest":null}\\n' "$VERCEL_PROJECT_ID"
  exit 0
fi
if [[ "$url" == https://api.vercel.com/* ]]; then
  locator="\${url#https://api.vercel.com/v13/deployments/}"
  locator="\${locator%%\\?*}"
  if [[ "$locator" == restore.example.vercel.app ]]; then id="$FAKE_RESTORE_ID"; else id="$(cat "$FAKE_CURRENT_ID")"; fi
  printf '{"id":"%s","projectId":"%s","target":"production","readyState":"READY"}\\n' "$id" "$VERCEL_PROJECT_ID"
  exit 0
fi
if [[ "$url" == "$SITE_URL/build-info.json" ]]; then
  [[ -n "$output" ]] && cp "$FAKE_BUILD_INFO" "$output"
  [[ -n "$headers" ]] && printf 'HTTP/2 200\\r\\ncache-control: no-store, max-age=0\\r\\n\\r\\n' >"$headers"
  exit 0
fi
if [[ "$url" == "$GITHUB_API_URL"/* ]]; then
  if [[ "$url" == *'/deployments?environment='* && -n "\${FAKE_GITHUB_DEPLOYMENTS:-}" ]]; then
    cat "$FAKE_GITHUB_DEPLOYMENTS"
    exit 0
  fi
  if [[ "$url" == *'/deployments/22/statuses'* && -n "\${FAKE_GITHUB_BLOCKING_STATUSES:-}" ]]; then
    cat "$FAKE_GITHUB_BLOCKING_STATUSES"
    exit 0
  fi
  if [[ "$url" == *'/deployments/21/statuses'* && -n "\${FAKE_GITHUB_BASELINE_STATUSES:-}" ]]; then
    cat "$FAKE_GITHUB_BASELINE_STATUSES"
    exit 0
  fi
  printf '{}\\n'
  exit 0
fi
printf 'unexpected fake curl URL: %s\\n' "$url" >&2
exit 92
`,
      "utf8",
    ),
  ]);
  await Promise.all([chmod(path.join(bin, "pnpm"), 0o755), chmod(path.join(bin, "curl"), 0o755)]);
  return {
    buildInfo,
    current,
    directory,
    env: {
      ...process.env,
      FAKE_BUILD_INFO: buildInfo,
      FAKE_COMMAND_LOG: log,
      FAKE_CURRENT_ID: current,
      FAKE_RESTORE_ID: "dpl_restore",
      FAKE_ROLLBACK_REQUEST_FILE: path.join(directory, "rollback-requested.txt"),
      GITHUB_API_URL: "https://api.github.test",
      GITHUB_OUTPUT: githubOutput,
      GITHUB_REPOSITORY: "ziyixi/website",
      GITHUB_TOKEN: "test-github-token",
      PATH: `${bin}:/usr/bin:/bin`,
      SITE_URL: "https://www.ziyixi.science",
      VERCEL_OPERATION_STATUS_TIMEOUT: "2s",
      VERCEL_OPERATION_STATUS_POLL_SECONDS: "0",
      VERCEL_ORG_ID: "team_test",
      VERCEL_PROJECT_ID: "prj_test",
      VERCEL_TOKEN: "test-vercel-token",
    },
    githubOutput,
    log,
  };
}

async function rollbackFixture(harness: Awaited<ReturnType<typeof makeHarness>>) {
  const restoreBuildInfo = path.join(harness.directory, "restore-build-info.json");
  const targetRecord = path.join(harness.directory, "target-record.json");
  await Promise.all([
    writeFile(restoreBuildInfo, `${JSON.stringify(baselineIdentity)}\n`, "utf8"),
    writeFile(
      targetRecord,
      `${JSON.stringify({
        baseline: {
          payload: deploymentPayload({
            candidateId: "dpl_restore",
            candidateUrl: "https://restore.example.vercel.app",
            identity: baselineIdentity,
            previousId: null,
          }),
        },
      })}\n`,
      "utf8",
    ),
  ]);
  return { restoreBuildInfo, targetRecord };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("asynchronous Vercel recovery coordination", () => {
  it("waits for a delayed promotion before deciding whether rollback is needed", async () => {
    const harness = await makeHarness();
    const fixture = await rollbackFixture(harness);
    await writeFile(harness.current, "dpl_restore\n", "utf8");

    await execFileAsync(
      "bash",
      [
        "scripts/release/rollback.sh",
        "--expected-current-id",
        "dpl_candidate",
        "--restore-id",
        "dpl_restore",
        "--restore-url",
        "https://restore.example.vercel.app",
        "--restore-build-info",
        fixture.restoreBuildInfo,
        "--target-record",
        fixture.targetRecord,
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...harness.env,
          FAKE_DELAYED_PROMOTION: "true",
        },
      },
    );

    expect((await readFile(harness.current, "utf8")).trim()).toBe("dpl_restore");
    const log = await readFile(harness.log, "utf8");
    expect(log).toContain("/v9/projects/prj_test?rollbackInfo=true&teamId=team_test");
    expect(log.indexOf("/v9/projects/prj_test")).toBeLessThan(log.indexOf("vercel rollback https"));
  });

  it("reconciles a rollback command timeout and fails closed when status is unknown", async () => {
    const completed = await makeHarness();
    const completedFixture = await rollbackFixture(completed);
    await writeFile(completed.current, "dpl_candidate\n", "utf8");
    await expect(
      execFileAsync(
        "bash",
        [
          "scripts/release/rollback.sh",
          "--expected-current-id",
          "dpl_candidate",
          "--restore-id",
          "dpl_restore",
          "--restore-url",
          "https://restore.example.vercel.app",
          "--restore-build-info",
          completedFixture.restoreBuildInfo,
          "--target-record",
          completedFixture.targetRecord,
        ],
        {
          cwd: repositoryRoot,
          env: {
            ...completed.env,
            FAKE_ROLLBACK_EXIT: "124",
            FAKE_ROLLBACK_SETTLE_TO: "dpl_restore",
          },
        },
      ),
    ).resolves.toBeDefined();
    expect((await readFile(completed.current, "utf8")).trim()).toBe("dpl_restore");

    const unknown = await makeHarness();
    const unknownFixture = await rollbackFixture(unknown);
    await writeFile(unknown.current, "dpl_candidate\n", "utf8");
    await expect(
      execFileAsync(
        "bash",
        [
          "scripts/release/rollback.sh",
          "--expected-current-id",
          "dpl_candidate",
          "--restore-id",
          "dpl_restore",
          "--restore-url",
          "https://restore.example.vercel.app",
          "--restore-build-info",
          unknownFixture.restoreBuildInfo,
          "--target-record",
          unknownFixture.targetRecord,
        ],
        {
          cwd: repositoryRoot,
          env: {
            ...unknown.env,
            FAKE_ALIAS_STATUS_UNKNOWN: "true",
            FAKE_ROLLBACK_EXIT: "124",
          },
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("unknown Vercel alias mutation status"),
    });
  });

  it("rejects rolling releases and bounds every project-status request", async () => {
    const harness = await makeHarness();
    const fixture = await rollbackFixture(harness);
    await writeFile(harness.current, "dpl_restore\n", "utf8");

    await expect(
      execFileAsync(
        "bash",
        [
          "scripts/release/rollback.sh",
          "--expected-current-id",
          "dpl_candidate",
          "--restore-id",
          "dpl_restore",
          "--restore-url",
          "https://restore.example.vercel.app",
          "--restore-build-info",
          fixture.restoreBuildInfo,
          "--target-record",
          fixture.targetRecord,
        ],
        {
          cwd: repositoryRoot,
          env: { ...harness.env, FAKE_ROLLING_RELEASE: "true" },
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Rolling Releases must be disabled"),
    });

    const log = await readFile(harness.log, "utf8");
    expect(log).toContain("--connect-timeout 10 --max-time 30");
    expect(log).not.toContain("vercel rollback https");
  });
});

describe("interrupted success-record recovery", () => {
  it("carries the blocked record payload through the recovery gate for later proof", async () => {
    const harness = await makeHarness();
    const deployments = path.join(harness.directory, "deployments.json");
    const blockingStatuses = path.join(harness.directory, "blocking-statuses.json");
    const baselineStatuses = path.join(harness.directory, "baseline-statuses.json");
    const baselineOut = path.join(harness.directory, "baseline.json");
    const gateState = path.join(harness.directory, "gate-state.json");
    const blockingPayload = deploymentPayload({
      candidateId: "dpl_candidate",
      candidateUrl: "https://candidate.example.vercel.app",
      identity: candidateIdentity,
      previousId: "dpl_restore",
    });
    const trustedPayload = deploymentPayload({
      candidateId: "dpl_restore",
      candidateUrl: "https://restore.example.vercel.app",
      identity: baselineIdentity,
      previousId: null,
    });
    await Promise.all([
      writeFile(
        deployments,
        `${JSON.stringify([
          {
            id: 22,
            created_at: "2026-09-21T02:00:00Z",
            payload: blockingPayload,
          },
          {
            id: 21,
            created_at: "2026-09-21T01:00:00Z",
            payload: trustedPayload,
          },
        ])}\n`,
        "utf8",
      ),
      writeFile(
        blockingStatuses,
        `${JSON.stringify([
          { id: 220, created_at: "2026-09-21T02:01:00Z", state: "in_progress" },
        ])}\n`,
        "utf8",
      ),
      writeFile(
        baselineStatuses,
        `${JSON.stringify([{ id: 210, created_at: "2026-09-21T01:01:00Z", state: "success" }])}\n`,
        "utf8",
      ),
    ]);

    await execFileAsync(
      "bash",
      [
        "scripts/release/deployment-record.sh",
        "gate",
        "--operation",
        "recovery",
        "--baseline-out",
        baselineOut,
        "--state-out",
        gateState,
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...harness.env,
          FAKE_GITHUB_BASELINE_STATUSES: baselineStatuses,
          FAKE_GITHUB_BLOCKING_STATUSES: blockingStatuses,
          FAKE_GITHUB_DEPLOYMENTS: deployments,
        },
      },
    );

    const state = JSON.parse(await readFile(gateState, "utf8")) as {
      baseline: { deploymentId: string };
      blocking: { deploymentId: string; payload: typeof blockingPayload; state: string };
    };
    expect(state.blocking).toMatchObject({
      deploymentId: "22",
      payload: { candidateDeploymentId: "dpl_candidate" },
      state: "in_progress",
    });
    expect(state.baseline.deploymentId).toBe("21");
  });

  it("reverifies the live candidate before retrying its existing GitHub success status", async () => {
    const harness = await makeHarness();
    await writeFile(harness.current, "dpl_candidate\n", "utf8");
    const gateState = path.join(harness.directory, "gate-state.json");
    const baselineOut = path.join(harness.directory, "baseline.json");
    await writeFile(
      gateState,
      `${JSON.stringify({
        schemaVersion: 1,
        blocking: {
          deploymentId: "22",
          state: "in_progress",
          payload: deploymentPayload({
            candidateId: "dpl_candidate",
            candidateUrl: "https://candidate.example.vercel.app",
            identity: candidateIdentity,
            previousId: "dpl_restore",
          }),
        },
        baseline: {
          deploymentId: "21",
          payload: deploymentPayload({
            candidateId: "dpl_restore",
            candidateUrl: "https://restore.example.vercel.app",
            identity: baselineIdentity,
            previousId: null,
          }),
        },
      })}\n`,
      "utf8",
    );

    await execFileAsync(
      "bash",
      [
        "scripts/release/coordinate-recovery.sh",
        "--gate-state",
        gateState,
        "--baseline-out",
        baselineOut,
      ],
      { cwd: repositoryRoot, env: harness.env },
    );

    const reconciled = JSON.parse(await readFile(gateState, "utf8")) as {
      baseline: { deploymentId: string; payload: { candidateDeploymentId: string } };
      blocking: { state: string };
    };
    expect(reconciled.blocking.state).toBe("success");
    expect(reconciled.baseline.deploymentId).toBe("22");
    expect(reconciled.baseline.payload.candidateDeploymentId).toBe("dpl_candidate");
    expect(JSON.parse(await readFile(baselineOut, "utf8"))).toEqual({
      posts: {},
      registryVersion: 1,
    });
    expect(await readFile(harness.githubOutput, "utf8")).toContain(
      "previous_production_id=dpl_candidate",
    );
    const log = await readFile(harness.log, "utf8");
    expect(log).toContain("pnpm test:deployment");
    expect(log).toContain("/deployments/22/statuses");
  });
});
