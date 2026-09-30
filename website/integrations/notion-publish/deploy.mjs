import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const names = ["GITHUB_DISPATCH_TOKEN", "NOTION_WEBHOOK_SECRET"];
for (const name of names) {
  if (!process.env[name]) throw new Error(`Missing ${name}; configure it in .env.local.`);
}
if (process.env.NOTION_WEBHOOK_SECRET.length < 32) {
  throw new Error("NOTION_WEBHOOK_SECRET must contain at least 32 characters.");
}

// Only these two bindings are uploaded; never pass the whole website env file.
const directory = mkdtempSync(join(tmpdir(), "ziyixi-publish-secrets-"));
try {
  const secretsPath = join(directory, "secrets.json");
  writeFileSync(
    secretsPath,
    JSON.stringify(Object.fromEntries(names.map((name) => [name, process.env[name]]))),
    { mode: 0o600 },
  );
  const result = spawnSync(
    "npx",
    ["--yes", "wrangler@4.141.0", "deploy", "--secrets-file", secretsPath],
    { cwd: fileURLToPath(new URL(".", import.meta.url)), stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
