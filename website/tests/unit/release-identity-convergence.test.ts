import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const identity = {
  codeSha: "a".repeat(40),
  configHash: "b".repeat(64),
  contentHash: "c".repeat(64),
  schemaVersion: 1,
};

async function makeHarness() {
  const directory = await mkdtemp(path.join(tmpdir(), "ziyixi-identity-convergence-test-"));
  temporaryDirectories.push(directory);
  const bin = path.join(directory, "bin");
  const expected = path.join(directory, "expected.json");
  const stale = path.join(directory, "stale.json");
  const log = path.join(directory, "requests.log");
  const apiCount = path.join(directory, "api-count");
  const publicCount = path.join(directory, "public-count");
  const output = path.join(directory, "github-output");
  await mkdir(bin);
  await Promise.all([
    writeFile(expected, JSON.stringify(identity)),
    writeFile(stale, JSON.stringify({ ...identity, codeSha: "d".repeat(40) })),
    writeFile(log, ""),
    writeFile(apiCount, "0"),
    writeFile(publicCount, "0"),
    writeFile(output, ""),
    writeFile(
      path.join(bin, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
printf '%s\\n' "$url" >>"$FAKE_LOG"
if [[ "$url" == https://api.vercel.com/v13/deployments/* ]]; then
  count=$(( $(cat "$FAKE_API_COUNT") + 1 ))
  printf '%s\\n' "$count" >"$FAKE_API_COUNT"
  id=dpl_candidate
  if (( count >= \${FAKE_FOREIGN_ID_AT:-999} )); then id=dpl_foreign; fi
  printf '{"id":"%s","projectId":"prj_test","target":"production","readyState":"READY"}\\n' "$id"
  exit 0
fi
if [[ "$url" == https://www.ziyixi.science/build-info.json ]]; then
  count=$(( $(cat "$FAKE_PUBLIC_COUNT") + 1 ))
  printf '%s\\n' "$count" >"$FAKE_PUBLIC_COUNT"
  output=''
  headers=''
  for ((index=1; index<=$#; index++)); do
    value="\${!index}"
    if [[ "$value" == --output ]]; then next=$((index + 1)); output="\${!next}"; fi
    if [[ "$value" == --dump-header ]]; then next=$((index + 1)); headers="\${!next}"; fi
  done
  printf 'HTTP/2 200\\r\\ncache-control: %s\\r\\ncf-cache-status: DYNAMIC\\r\\nx-vercel-cache: HIT\\r\\nx-vercel-id: iad1::test-request\\r\\nset-cookie: secret-not-for-logs\\r\\n\\r\\n' "\${FAKE_CACHE_CONTROL:-no-store, max-age=0}" >"$headers"
  if [[ "\${FAKE_INVALID_IDENTITY:-false}" == true ]]; then
    printf 'invalid-json' >"$output"
  elif (( count >= \${FAKE_IDENTITY_READY_AT:-2} )); then
    cp "$FAKE_EXPECTED" "$output"
  else
    cp "$FAKE_STALE" "$output"
  fi
  exit 0
fi
printf 'unexpected fake curl URL: %s\\n' "$url" >&2
exit 91
`,
    ),
    writeFile(
      path.join(bin, "sleep"),
      '#!/usr/bin/env bash\nprintf "sleep %s\\n" "$*" >>"$FAKE_LOG"\n',
    ),
    writeFile(
      path.join(bin, "pnpm"),
      '#!/usr/bin/env bash\nprintf "pnpm %s\\n" "$*" >>"$FAKE_LOG"\n[[ "$*" == test:deployment ]]\n',
    ),
  ]);
  await Promise.all(["curl", "sleep", "pnpm"].map((name) => chmod(path.join(bin, name), 0o755)));
  return {
    expected,
    stale,
    log,
    apiCount,
    publicCount,
    output,
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      FAKE_API_COUNT: apiCount,
      FAKE_PUBLIC_COUNT: publicCount,
      FAKE_EXPECTED: expected,
      FAKE_STALE: stale,
      FAKE_LOG: log,
      GITHUB_OUTPUT: output,
      VERCEL_TOKEN: "test-token",
      VERCEL_ORG_ID: "team_test",
      VERCEL_PROJECT_ID: "prj_test",
    },
  };
}

function verify(
  harness: Awaited<ReturnType<typeof makeHarness>>,
  options: { wait?: boolean; env?: Partial<NodeJS.ProcessEnv> } = {},
) {
  return execFileAsync(
    "bash",
    [
      "scripts/release/verify-deployment.sh",
      "--mode",
      "production",
      "--base-url",
      "https://www.ziyixi.science",
      "--expected-build-info",
      harness.expected,
      "--expected-deployment-id",
      "dpl_candidate",
      ...(options.wait === false ? [] : ["--wait-for-identity"]),
    ],
    { cwd: process.cwd(), env: { ...harness.env, ...options.env } },
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("post-promotion public identity convergence", () => {
  it("re-resolves the immutable deployment before accepting a converged public identity", async () => {
    const harness = await makeHarness();
    const result = await verify(harness);
    const lines = (await readFile(harness.log, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain("https://api.vercel.com/v13/deployments/");
    expect(lines[1]).toBe("https://www.ziyixi.science/build-info.json");
    expect(lines[2]).toBe("sleep 5");
    expect(lines[3]).toBe(lines[0]);
    expect(lines[4]).toBe(lines[1]);
    expect(lines[5]).toBe("pnpm test:deployment");
    expect(result.stderr).toContain(`expected codeSha=${identity.codeSha}`);
    expect(result.stderr).toContain(`actual codeSha=${"d".repeat(40)}`);
    expect(result.stderr).toContain("cf-cache-status= DYNAMIC");
    expect(result.stderr).toContain("x-vercel-cache= HIT");
    expect(result.stderr).toContain("x-vercel-id= iad1::test-request");
    expect(result.stderr).not.toContain("secret-not-for-logs");
    expect(await readFile(harness.output, "utf8")).toContain("deployment_id=dpl_candidate");
  });

  it("fails after the bounded attempts if public identity never converges", async () => {
    const harness = await makeHarness();
    await expect(verify(harness, { env: { FAKE_IDENTITY_READY_AT: "999" } })).rejects.toMatchObject(
      {
        code: 1,
        stderr: expect.stringContaining("attempt 12/12"),
      },
    );
    expect((await readFile(harness.apiCount, "utf8")).trim()).toBe("12");
    expect((await readFile(harness.publicCount, "utf8")).trim()).toBe("12");
    expect(await readFile(harness.log, "utf8")).not.toContain("pnpm test:deployment");
    expect(await readFile(harness.output, "utf8")).toBe("");
  });

  it("does not retry normal verification without the explicit convergence flag", async () => {
    const harness = await makeHarness();
    await expect(verify(harness, { wait: false })).rejects.toMatchObject({ code: 1 });
    expect((await readFile(harness.publicCount, "utf8")).trim()).toBe("1");
    expect(await readFile(harness.log, "utf8")).not.toContain("sleep");
  });

  it("fails immediately if a different deployment takes over while waiting", async () => {
    const harness = await makeHarness();
    await expect(verify(harness, { env: { FAKE_FOREIGN_ID_AT: "2" } })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Vercel deployment ID does not match the expected ID"),
    });
    expect((await readFile(harness.apiCount, "utf8")).trim()).toBe("2");
    expect((await readFile(harness.publicCount, "utf8")).trim()).toBe("1");
    expect(await readFile(harness.output, "utf8")).toBe("");
  });

  it.each([{ FAKE_CACHE_CONTROL: "public, max-age=14400" }, { FAKE_INVALID_IDENTITY: "true" }])(
    "rejects unsafe or invalid responses without retrying: %j",
    async (env) => {
      const harness = await makeHarness();
      await expect(verify(harness, { env })).rejects.toMatchObject({ code: 1 });
      expect((await readFile(harness.publicCount, "utf8")).trim()).toBe("1");
      expect(await readFile(harness.log, "utf8")).not.toContain("sleep");
      expect(await readFile(harness.output, "utf8")).toBe("");
    },
  );

  it("continues comparing the complete identity when codeSha is already correct", async () => {
    const harness = await makeHarness();
    await writeFile(harness.stale, JSON.stringify({ ...identity, contentHash: "e".repeat(64) }));
    await verify(harness);
    expect((await readFile(harness.publicCount, "utf8")).trim()).toBe("2");
  });
});
