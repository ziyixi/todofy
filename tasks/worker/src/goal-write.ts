import { ObjectiveSchema, KeyResultSchema, type Objective, type KeyResult } from '@ziyixi/proto/tasks/ui/v1/goals_pb';
import type {
  CreateObjectiveRequest,
  UpdateObjectiveRequest,
  CreateKeyResultRequest,
  UpdateKeyResultRequest,
} from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { conflict, invalid, precondition } from './errors.ts';
import { checkedId, camelCase } from './model.ts';
import { fingerprint, replay } from './receipts.ts';
import { commitChecked, type Check } from './focus.ts';
import {
  goalId,
  keyResultMessage,
  objectiveMessage,
  storedMilestones,
  type KeyResultRow,
  type ObjectiveRow,
} from './goal-model.ts';
import { getKeyResult, getObjective } from './goal-read.ts';
import { goalPaths, validateKeyResult, validateObjective } from './goal-validation.ts';

const objectiveColumns = ['title', 'description', 'source_url', 'sort_order', 'archived'] as const;
const resultColumns = [
  'objective_id',
  'title',
  'floor_text',
  'target_text',
  'notes',
  'kind',
  'completed',
  'milestones',
  'focus_start_month',
  'focus_end_month',
  'focus_text',
  'source_url',
  'sort_order',
  'archived',
] as const;

function etag(current: number, supplied: string): void {
  if (!supplied) invalid('An etag is required');
  if (String(current) !== supplied) conflict();
}
function objectiveValues(value: Objective) {
  return {
    title: value.title.trim(),
    description: value.description,
    year: value.year,
    source_url: value.sourceUrl,
    sort_order: value.sortOrder,
    archived: Number(value.archived),
  };
}
function resultValues(value: KeyResult, previous: string, now: number) {
  return {
    objective_id: value.objectiveId,
    title: value.title.trim(),
    floor_text: value.floorText,
    target_text: value.targetText,
    notes: value.notes,
    kind: value.kind || 'outcome',
    completed: Number(value.completed),
    milestones: storedMilestones(value.milestones, previous, now),
    focus_start_month: value.focusStartMonth,
    focus_end_month: value.focusEndMonth,
    focus_text: value.focusText,
    source_url: value.sourceUrl,
    sort_order: value.sortOrder,
    archived: Number(value.archived),
  };
}
export async function createObjective(db: D1Database, input: CreateObjectiveRequest, now: number) {
  const hash = await fingerprint('createObjective', input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return fromWire(ObjectiveSchema, JSON.parse(previous)).message;
  if (!input.objective) invalid();
  const row: ObjectiveRow = {
    ...objectiveValues(input.objective),
    id: input.objectiveId ? checkedId(input.objectiveId) : crypto.randomUUID(),
    revision: 1,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  validateObjective(row);
  const columns = ['id', ...objectiveColumns, 'year', 'created_at', 'updated_at'] as const;
  const response = await commitChecked(
    db,
    {
      requestId: input.requestId,
      hash,
      table: 'objectives',
      id: row.id,
      revision: null,
      response: JSON.stringify(toWire(ObjectiveSchema, objectiveMessage(row))),
      now,
    },
    [
      db
        .prepare(`INSERT INTO objectives(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
        .bind(...columns.map((column) => row[column])),
    ],
    [
      {
        sql: '(SELECT count(*) FROM objectives WHERE year=? AND deleted_at IS NULL)<20',
        values: [row.year],
        message: 'A year holds at most 20 Objectives',
      },
    ],
  );
  return fromWire(ObjectiveSchema, JSON.parse(response)).message;
}
export async function updateObjective(db: D1Database, input: UpdateObjectiveRequest, now: number) {
  const hash = await fingerprint('updateObjective', input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return fromWire(ObjectiveSchema, JSON.parse(previous)).message;
  if (!input.objective) invalid();
  const old = await getObjective(db, goalId(input.objective.name, 'objectives'));
  etag(old.revision, input.etag);
  const paths = goalPaths(input.updateMask, [...objectiveColumns, 'year']);
  if ((paths.includes('year') || input.objective.year) && input.objective.year !== old.year)
    invalid('An Objective year cannot change');
  const values = objectiveValues(input.objective);
  const row = { ...old, revision: old.revision + 1, updated_at: now };
  for (const field of paths) {
    if (field !== 'year') Object.assign(row, { [field]: values[field as keyof typeof values] });
  }
  validateObjective(row);
  const response = await commitChecked(
    db,
    {
      requestId: input.requestId,
      hash,
      table: 'objectives',
      id: row.id,
      revision: old.revision,
      response: JSON.stringify(toWire(ObjectiveSchema, objectiveMessage(row))),
      now,
    },
    [
      db
        .prepare(
          `UPDATE objectives SET ${objectiveColumns.map((column) => `${column}=?`).join(',')},revision=revision+1,updated_at=? WHERE id=?`,
        )
        .bind(...objectiveColumns.map((column) => row[column]), now, row.id),
    ],
    [],
  );
  return fromWire(ObjectiveSchema, JSON.parse(response)).message;
}
export async function createKeyResult(db: D1Database, input: CreateKeyResultRequest, now: number) {
  const hash = await fingerprint('createKeyResult', input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return fromWire(KeyResultSchema, JSON.parse(previous)).message;
  if (!input.keyResult) invalid();
  const objective = await getObjective(db, checkedId(input.keyResult.objectiveId));
  if (objective.archived) precondition('Choose an active Objective');
  const row: KeyResultRow = {
    ...resultValues(input.keyResult, '[]', now),
    id: input.keyResultId ? checkedId(input.keyResultId) : crypto.randomUUID(),
    year: objective.year,
    objective_archived: objective.archived,
    revision: 1,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  validateKeyResult(row);
  const columns = ['id', ...resultColumns, 'created_at', 'updated_at'] as const;
  const response = await commitChecked(
    db,
    {
      requestId: input.requestId,
      hash,
      table: 'key_results',
      id: row.id,
      revision: null,
      response: JSON.stringify(toWire(KeyResultSchema, keyResultMessage(row))),
      now,
    },
    [
      db
        .prepare(`INSERT INTO key_results(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
        .bind(...columns.map((column) => row[column])),
    ],
    [
      activeObjective(row.objective_id),
      {
        sql: '(SELECT count(*) FROM objectives o JOIN key_results k ON k.objective_id=o.id WHERE o.year=? AND k.deleted_at IS NULL)<100',
        values: [row.year],
        message: 'A year holds at most 100 Key Results',
      },
    ],
  );
  return fromWire(KeyResultSchema, JSON.parse(response)).message;
}
function activeObjective(id: string): Check {
  return {
    sql: 'EXISTS(SELECT 1 FROM objectives WHERE id=? AND deleted_at IS NULL AND archived=0)',
    values: [id],
    message: 'Choose an active Objective',
  };
}
export async function updateKeyResult(db: D1Database, input: UpdateKeyResultRequest, now: number) {
  const hash = await fingerprint('updateKeyResult', input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return fromWire(KeyResultSchema, JSON.parse(previous)).message;
  if (!input.keyResult) invalid();
  const old = await getKeyResult(db, goalId(input.keyResult.name, 'keyResults'));
  etag(old.revision, input.etag);
  const paths = goalPaths(input.updateMask, resultColumns);
  // Unmasked fields are not validated or written; a narrow edit need not carry milestone text.
  const value = {
    ...keyResultMessage(old),
    ...Object.fromEntries(
      paths.map((path) => [camelCase(path), input.keyResult?.[camelCase(path) as keyof KeyResult]]),
    ),
  } as KeyResult;
  const row: KeyResultRow = {
    ...old,
    ...resultValues(value, old.milestones, now),
    revision: old.revision + 1,
    updated_at: now,
  };
  const checks: Check[] = [];
  if (row.objective_id !== old.objective_id) {
    const objective = await getObjective(db, row.objective_id);
    if (objective.year !== old.year) invalid('A Key Result can move only within its year');
    if (objective.archived) precondition('Choose an active Objective');
    row.objective_archived = objective.archived;
    checks.push(activeObjective(row.objective_id));
  }
  validateKeyResult(row);
  const response = await commitChecked(
    db,
    {
      requestId: input.requestId,
      hash,
      table: 'key_results',
      id: row.id,
      revision: old.revision,
      response: JSON.stringify(toWire(KeyResultSchema, keyResultMessage(row))),
      now,
    },
    [
      db
        .prepare(
          `UPDATE key_results SET ${resultColumns.map((column) => `${column}=?`).join(',')},revision=revision+1,updated_at=? WHERE id=?`,
        )
        .bind(...resultColumns.map((column) => row[column]), now, row.id),
    ],
    checks,
  );
  return fromWire(KeyResultSchema, JSON.parse(response)).message;
}
