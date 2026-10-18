#!/usr/bin/env node
// The one-time FlowDay estimate backfill (docs/backup.md): a dry run prints counts only; --output writes the SQL
// to a private file (0600, outside the repository) for `wrangler d1 execute --file`.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EstimateBackfillError, estimateBackfillSql, prepareEstimateBackfill } from './estimate-backfill.ts';
import { ExportError, privateText } from './todoist-export.mjs';

async function main() {
  const args = process.argv.slice(2);
  const option = (key: string) => {
    const index = args.indexOf(key);
    return index < 0 ? undefined : args[index + 1];
  };
  const flowday = option('--flowday');
  const tasks = option('--tasks');
  const output = option('--output');
  if (!flowday || !tasks) throw new EstimateBackfillError('USE_FLOWDAY_AND_TASKS');
  const plan = prepareEstimateBackfill(
    JSON.parse(await readFile(flowday, 'utf8')),
    JSON.parse(await readFile(tasks, 'utf8')),
    Date.now(),
  );
  if (output) await privateText(output, estimateBackfillSql(plan));
  console.log(
    JSON.stringify({
      event: 'flowday_estimate_backfill',
      mode: output ? 'private_sql_prepared' : 'dry_run',
      override_count: plan.overrides,
      update_count: plan.updates.length,
      unchanged_count: plan.unchanged,
      skipped_missing_count: plan.skipped.missing,
      skipped_invalid_value_count: plan.skipped.invalidValue,
      skipped_invalid_id_count: plan.skipped.invalidId,
    }),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    // Codes only: an exception's own message could quote the exports.
    const known = error instanceof EstimateBackfillError || error instanceof ExportError;
    console.error(known ? error.message : 'ESTIMATE_BACKFILL_FAILED');
    process.exitCode = 1;
  });
