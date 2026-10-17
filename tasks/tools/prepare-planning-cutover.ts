#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preparePlanningCutover, planningCutoverSql, PlanningCutoverError } from './planning-cutover.ts';
import { privateText } from './todoist-export.mjs';

async function main() {
  const args = process.argv.slice(2);
  const option = (key: string) => {
    const index = args.indexOf(key);
    return index < 0 ? undefined : args[index + 1];
  };
  const snapshot = option('--snapshot');
  const metadata = option('--metadata');
  const output = option('--output');
  if (!snapshot || !metadata) throw new PlanningCutoverError('USE_SNAPSHOT_AND_METADATA');
  const plan = preparePlanningCutover(
    JSON.parse(await readFile(snapshot, 'utf8')),
    JSON.parse(await readFile(metadata, 'utf8')),
  );
  if (output) await privateText(output, planningCutoverSql(plan));
  console.log(
    JSON.stringify({
      event: 'planning_identity_cutover',
      mode: output ? 'private_sql_prepared' : 'dry_run',
      matched_count: plan.targetIds.length,
      untouched_historical_count: plan.untouchedHistorical,
      issue_count: plan.issues.length,
      issue_codes: [...new Set(plan.issues.map((issue) => issue.code))],
      import_issue_count: plan.imported.issues.length,
      coverage_gaps: plan.imported.gaps,
    }),
  );
  if (plan.issues.length || plan.imported.issues.length || plan.imported.gaps.length) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error instanceof PlanningCutoverError ? error.message : 'PLANNING_CUTOVER_FAILED');
    process.exitCode = 1;
  });
