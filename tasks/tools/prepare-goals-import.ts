#!/usr/bin/env node
/** One-time private annual OKR import. It inserts definitions only, never progress or task associations. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBJECTIVE_LIMIT,
  KEY_RESULT_LIMIT,
  type ObjectiveRow,
  type KeyResultRow,
} from "../worker/src/goal-model.ts";
import {
  checkedGoalUrl,
  validateKeyResult,
  validateObjective,
} from "../worker/src/goal-validation.ts";
import { privateText } from "./todoist-export.mjs";

export class GoalImportError extends Error {}
type Input = Record<string, unknown>;
export interface GoalImportPlan {
  year: number;
  objectives: ObjectiveRow[];
  keyResults: KeyResultRow[];
}
function object(value: unknown): Input {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new GoalImportError("GOAL_IMPORT_OBJECT_REQUIRED");
  return value as Input;
}
function text(value: unknown, required = false): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || (required && !value.trim()))
    throw new GoalImportError("GOAL_IMPORT_TEXT_INVALID");
  return value;
}
function list(value: unknown): Input[] {
  if (!Array.isArray(value))
    throw new GoalImportError("GOAL_IMPORT_LIST_REQUIRED");
  return value.map(object);
}
function sourceKey(value: unknown, seen: Set<string>): string {
  const key = text(value, true);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(key) || seen.has(key))
    throw new GoalImportError("GOAL_IMPORT_SOURCE_KEY_INVALID");
  seen.add(key);
  return key;
}
function id(source: string, year: number, kind: string, key: string): string {
  return `okr-${createHash("sha256")
    .update(JSON.stringify([source, year, kind, key]))
    .digest("hex")
    .slice(0, 32)}`;
}

export function prepareGoalsImport(value: unknown): GoalImportPlan {
  const input = object(value);
  const year = input.year;
  if (typeof year !== "number" || !Number.isInteger(year))
    throw new GoalImportError("GOAL_IMPORT_YEAR_INVALID");
  const source = checkedGoalUrl(text(input.source_url, true));
  const at = Date.parse(text(input.imported_at, true));
  if (!Number.isFinite(at))
    throw new GoalImportError("GOAL_IMPORT_TIME_INVALID");
  const plan: GoalImportPlan = { year, objectives: [], keyResults: [] };
  const objectiveKeys = new Set<string>();
  const resultKeys = new Set<string>();
  for (const [order, given] of list(input.objectives).entries()) {
    const key = sourceKey(given.key, objectiveKeys);
    const objective: ObjectiveRow = {
      id: id(source, year, "objective", key),
      year,
      title: text(given.title, true).trim(),
      description: text(given.description),
      source_url: source,
      sort_order: order + 1,
      archived: 0,
      revision: 1,
      created_at: at,
      updated_at: at,
      deleted_at: null,
    };
    validateObjective(objective);
    plan.objectives.push(objective);
    for (const [resultOrder, givenResult] of list(
      given.key_results,
    ).entries()) {
      const resultKey = sourceKey(givenResult.key, resultKeys);
      const result: KeyResultRow = {
        id: id(source, year, "key-result", resultKey),
        objective_id: objective.id,
        year,
        objective_archived: 0,
        title: text(givenResult.title, true).trim(),
        floor_text: text(givenResult.floor_text),
        target_text: text(givenResult.target_text),
        notes: text(givenResult.notes),
        kind: text(givenResult.kind) || "outcome",
        completed: 0,
        milestones: "[]",
        focus_start_month: "",
        focus_end_month: "",
        focus_text: "",
        source_url: source,
        sort_order: resultOrder + 1,
        archived: 0,
        revision: 1,
        created_at: at,
        updated_at: at,
        deleted_at: null,
      };
      validateKeyResult(result);
      plan.keyResults.push(result);
    }
  }
  if (
    !plan.objectives.length ||
    plan.objectives.length > OBJECTIVE_LIMIT ||
    plan.keyResults.length > KEY_RESULT_LIMIT
  )
    throw new GoalImportError("GOAL_IMPORT_SIZE_INVALID");
  return plan;
}

function literal(value: string | number | null): string {
  if (value === null) return "NULL";
  return typeof value === "number"
    ? String(value)
    : `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
}
function insert(
  table: string,
  row: Record<string, string | number | null>,
): string {
  const entries = Object.entries(row);
  return `INSERT INTO ${table}(${entries.map(([column]) => column).join(",")}) VALUES(${entries.map(([, value]) => literal(value)).join(",")}) ON CONFLICT(id) DO NOTHING;`;
}
/** Stable source-derived IDs make reruns additive; an existing owner-edited definition is never overwritten. */
export function goalImportStatements(plan: GoalImportPlan): string[] {
  return [
    ...plan.objectives.map((objective) =>
      insert("objectives", { ...objective }),
    ),
    ...plan.keyResults.map(
      ({ year: _year, objective_archived: _archived, ...result }) => {
        void _year;
        void _archived;
        return insert("key_results", result);
      },
    ),
  ];
}

async function main() {
  const args = process.argv.slice(2);
  const inputIndex = args.indexOf("--input");
  if (inputIndex < 0 || !args[inputIndex + 1])
    throw new GoalImportError("USE_PRIVATE_GOALS_INPUT");
  const plan = prepareGoalsImport(
    JSON.parse(await readFile(resolve(args[inputIndex + 1]), "utf8")),
  );
  const outputIndex = args.indexOf("--output");
  if (outputIndex >= 0) {
    const output = args[outputIndex + 1];
    if (!output) throw new GoalImportError("GOAL_IMPORT_OUTPUT_REQUIRED");
    await privateText(output, goalImportStatements(plan).join("\n") + "\n");
  }
  console.log(
    JSON.stringify({
      event: "goals_import_plan",
      mode: outputIndex < 0 ? "dry_run" : "private_sql_prepared",
      year: plan.year,
      objectives: plan.objectives.length,
      key_results: plan.keyResults.length,
    }),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof GoalImportError ? error.message : "GOALS_IMPORT_INVALID",
    );
    process.exitCode = 1;
  });
}
