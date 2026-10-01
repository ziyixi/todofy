import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { HostnameGuardCli } from "../../scripts/release/cloudflare";

// The release runs the monorepo's guard as its own process from website/ (../tools/cf-guard). These runs
// need no network: a config without routes sends no request, and one with routes stops at the missing
// token before any request.
describe("hostname guard (tools/cf-guard) from the release", () => {
  const cwd = path.resolve(__dirname, "../..");

  async function withConfig(body: string, run: (file: string) => Promise<void>) {
    const directory = await mkdtemp(path.join(tmpdir(), "website-guard-"));
    const file = path.join(directory, "wrangler.toml");
    await writeFile(
      file,
      `name = "synthetic"\naccount_id = "${"0".repeat(32)}"\n${body}\n`,
      "utf8",
    );
    try {
      await run(file);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  it("passes a config that lists no hostname", async () => {
    await withConfig("", async (configFile) => {
      await expect(
        new HostnameGuardCli({ cwd, env: { NODE_ENV: "test" }, configFile }).check(),
      ).resolves.toBeUndefined();
    });
  });

  it("refuses the release when the guard fails", async () => {
    await withConfig(
      'routes = [{ pattern = "www.example.com", custom_domain = true }]',
      async (configFile) => {
        await expect(
          new HostnameGuardCli({ cwd, env: { NODE_ENV: "test" }, configFile }).check(),
        ).rejects.toThrow(/hostname guard \(tools\/cf-guard\) refused .* \(exit 2\)/);
      },
    );
  });
});
