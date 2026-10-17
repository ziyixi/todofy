#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareImport, importStatements, ImportError } from './import-model.ts';
import { privateText } from './todoist-export.mjs';

async function main() {
  const args = process.argv.slice(2);
  const inputIndex = args.indexOf('--input');
  if (inputIndex < 0 || !args[inputIndex + 1]) throw new ImportError('USE_INPUT_SNAPSHOT');
  const snapshot: unknown = JSON.parse(await readFile(resolve(args[inputIndex + 1]), 'utf8'));
  const plan = prepareImport(snapshot);
  const outputIndex = args.indexOf('--output');
  if (outputIndex >= 0) {
    const output = args[outputIndex + 1];
    if (!output) throw new ImportError('OUTPUT_PATH_REQUIRED');
    const statements = importStatements(plan, args.includes('--preview-incomplete'));
    await privateText(output, statements.join('\n') + '\n');
  }
  // Only counts and safe codes go to the terminal; content remains in the explicit private files.
  console.log(
    JSON.stringify({
      event: 'tasks_import_plan',
      mode: outputIndex < 0 ? 'dry_run' : 'private_sql_prepared',
      counts: {
        projects: plan.projects.length,
        sections: plan.sections.length,
        labels: plan.labels.length,
        filters: plan.filters.length,
        tasks: plan.tasks.length,
        completions: plan.completions.length,
        recovered_historical_labels: plan.recoveredHistoricalLabels,
      },
      issue_count: plan.issues.length,
      issue_codes: [...new Set(plan.issues.map((issue) => issue.code))],
      coverage_gaps: plan.gaps,
    }),
  );
  if (plan.issues.length) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof ImportError ? error.message : 'TASKS_IMPORT_FAILED');
    process.exitCode = 1;
  });
}
