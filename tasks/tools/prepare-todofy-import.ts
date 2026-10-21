#!/usr/bin/env node
// The one-time Todofy import (docs/backup.md "One-time Todofy import"), run by
// .github/workflows/tasks-todofy-import.yml:
//   --exports                          prints the read-only queries, one per line: "<app>\t<name>\t<SQL>"
//   --dir <dir>                        reads each answer from <dir>/<name>.json and prints counts only
//   --dir <dir> --output <file>        also writes the SQL to a private file (0600, outside the repository)
//   --dir <dir> --expect-none          fails when anything is still pending: the check after the import
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPORTS, TodofyImportError, todofyImportSql, prepareTodofyImport } from './todofy-import.ts';
import { ExportError, privateText } from './todoist-export.mjs';

async function main() {
  const args = process.argv.slice(2);
  const option = (key: string) => {
    const index = args.indexOf(key);
    return index < 0 ? undefined : args[index + 1];
  };
  if (args.includes('--exports')) {
    for (const { app, name, sql } of EXPORTS) console.log(`${app}\t${name}\t${sql}`);
    return;
  }
  const dir = option('--dir');
  const output = option('--output');
  if (!dir) throw new TodofyImportError('USE_EXPORTS_OR_DIR');
  const answers: Record<string, unknown> = {};
  for (const { name } of EXPORTS) answers[name] = JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8'));
  const plan = prepareTodofyImport(answers);
  if (output) await privateText(output, todofyImportSql(plan));
  console.log(
    JSON.stringify({
      event: 'tasks_todofy_import',
      mode: output ? 'private_sql_prepared' : 'dry_run',
      ...plan.counts,
    }),
  );
  if (args.includes('--expect-none') && plan.counts.pending) throw new TodofyImportError('TODOFY_IMPORT_PENDING');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    // Codes only: an exception's own message (a JSON syntax error, say) could quote the exports.
    const known = error instanceof TodofyImportError || error instanceof ExportError;
    console.error(known ? error.message : 'TODOFY_IMPORT_FAILED');
    process.exitCode = 1;
  });
