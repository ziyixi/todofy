import { prepareImport, type ImportPlan } from './import-model.ts';
export class PlanningCutoverError extends Error {}
interface Identity {
  id: number;
  provider: string;
  external_id: string;
  created_at: number;
  closed_at: number | null;
  closed_as: string | null;
}
interface Edge {
  task_id: number;
  prerequisite_id: number;
  kind: string;
  baseline_count: number;
  created_at: number;
}
interface Mark {
  task_id: number;
  kind: string;
  period: string;
  created_at: number;
}
interface Metadata {
  plan_tasks: Identity[];
  plan_edges: Edge[];
  plan_marks: Mark[];
}
export interface PlanningCutover {
  imported: ImportPlan;
  metadata: Metadata;
  targetIds: number[];
  untouchedHistorical: number;
  issues: { code: string; id: number }[];
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PlanningCutoverError('PLANNING_METADATA_INVALID');
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new PlanningCutoverError('PLANNING_NUMBER_INVALID');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new PlanningCutoverError('PLANNING_TEXT_INVALID');
  return value;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new PlanningCutoverError('PLANNING_COLLECTION_MISSING');
  return value.map(object);
}
function metadataOf(value: unknown): Metadata {
  const input = object(value);
  const plan_tasks = rows(input.plan_tasks).map((row) => {
    const provider = text(row.provider);
    const external_id = text(row.external_id);
    if (!['todoist', 'tasks'].includes(provider) || !/^[A-Za-z0-9_-]{1,100}$/.test(external_id))
      throw new PlanningCutoverError('PLANNING_IDENTITY_INVALID');
    const closed_at = row.closed_at === null ? null : integer(row.closed_at);
    const closed_as = row.closed_as === null ? null : text(row.closed_as);
    if (
      (closed_at === null) !== (closed_as === null) ||
      (closed_as !== null && !['completed', 'deleted'].includes(closed_as))
    )
      throw new PlanningCutoverError('PLANNING_CLOSED_STATE_INVALID');
    return { id: integer(row.id), provider, external_id, created_at: integer(row.created_at), closed_at, closed_as };
  });
  const plan_edges = rows(input.plan_edges).map((row) => ({
    task_id: integer(row.task_id),
    prerequisite_id: integer(row.prerequisite_id),
    kind: text(row.kind),
    baseline_count: integer(row.baseline_count),
    created_at: integer(row.created_at),
  }));
  const plan_marks = rows(input.plan_marks).map((row) => ({
    task_id: integer(row.task_id),
    kind: text(row.kind),
    period: text(row.period),
    created_at: integer(row.created_at),
  }));
  const ids = new Set(plan_tasks.map((row) => row.id));
  if (ids.size !== plan_tasks.length || ids.has(0)) throw new PlanningCutoverError('PLANNING_IDENTITY_DUPLICATE');
  if (
    plan_edges.some((row) => !ids.has(row.task_id) || !ids.has(row.prerequisite_id)) ||
    plan_marks.some((row) => !ids.has(row.task_id))
  )
    throw new PlanningCutoverError('PLANNING_REFERENCE_MISSING');
  return { plan_tasks, plan_edges, plan_marks };
}

export function preparePlanningCutover(snapshot: unknown, metadataInput: unknown): PlanningCutover {
  const imported = prepareImport(snapshot);
  const metadata = metadataOf(metadataInput);
  const importedIds = new Set(imported.tasks.map((task) => task.id));
  const referenced = new Set([
    ...metadata.plan_edges.flatMap((edge) => [edge.task_id, edge.prerequisite_id]),
    ...metadata.plan_marks.map((mark) => mark.task_id),
  ]);
  const byExternal = new Map<string, Identity[]>();
  for (const row of metadata.plan_tasks) {
    const group = byExternal.get(row.external_id) ?? [];
    group.push(row);
    byExternal.set(row.external_id, group);
  }
  const issues: { code: string; id: number }[] = [];
  const targetIds: number[] = [];
  let untouchedHistorical = 0;
  for (const row of metadata.plan_tasks) {
    if ((byExternal.get(row.external_id)?.length ?? 0) > 1) {
      issues.push({ code: 'DUPLICATE_NATIVE_IDENTITY', id: row.id });
      continue;
    }
    if (row.provider === 'tasks') continue;
    if (importedIds.has(row.external_id)) {
      targetIds.push(row.id);
      continue;
    }
    if (row.closed_as === null || referenced.has(row.id))
      issues.push({ code: 'REFERENCED_SOURCE_TASK_MISSING', id: row.id });
    else untouchedHistorical++;
  }
  const completionCounts = new Map(imported.tasks.map((task) => [task.id, task.completed_base_count]));
  for (const completion of imported.completions.filter((row) => !row.imported)) {
    completionCounts.set(completion.task_id, (completionCounts.get(completion.task_id) ?? 0) + 1);
  }
  const identities = new Map(metadata.plan_tasks.map((row) => [row.id, row]));
  for (const edge of metadata.plan_edges) {
    const prerequisite = identities.get(edge.prerequisite_id);
    const importedCount = prerequisite ? completionCounts.get(prerequisite.external_id) : undefined;
    if (importedCount !== undefined && importedCount < edge.baseline_count) {
      issues.push({code:'COMPLETION_BASELINE_NOT_PRESERVED',id:edge.prerequisite_id});
    }
  }
  return { imported, metadata, targetIds, untouchedHistorical, issues };
}
function jsonSql(value: unknown): string {
  // Metadata strings remain data, including quotes. The SQL contains no business text.
  return `CAST(X'${new TextEncoder().encode(JSON.stringify(value)).reduce((hex, byte) => hex + byte.toString(16).padStart(2, '0'), '')}' AS TEXT)`;
}

/** One atomic statement; only provider changes on the existing internal IDs. */
export function planningCutoverSql(plan: PlanningCutover): string {
  if (plan.imported.issues.length || plan.imported.gaps.length)
    throw new PlanningCutoverError('TASK_IMPORT_NOT_VERIFIED');
  if (plan.issues.length) throw new PlanningCutoverError('PLANNING_IDENTITIES_UNRESOLVED');
  if (!plan.targetIds.length) return 'SELECT 0 AS migrated_count;\n';
  const identities = jsonSql(plan.metadata.plan_tasks);
  const edges = jsonSql(plan.metadata.plan_edges);
  const marks = jsonSql(plan.metadata.plan_marks);
  const targets = jsonSql(plan.targetIds);
  return `WITH
expected AS MATERIALIZED (SELECT value FROM json_each(${identities})),
edges AS MATERIALIZED (SELECT value FROM json_each(${edges})),
marks AS MATERIALIZED (SELECT value FROM json_each(${marks})),
valid AS MATERIALIZED (SELECT
  (SELECT count(*) FROM plan_tasks)=(SELECT count(*) FROM expected)
  AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN plan_tasks p ON p.id=e.value->>'id'
    WHERE p.id IS NULL OR p.external_id<>e.value->>'external_id' OR p.created_at<>e.value->>'created_at'
      OR p.closed_at IS NOT e.value->>'closed_at' OR p.closed_as IS NOT e.value->>'closed_as'
      OR (p.provider<>e.value->>'provider' AND NOT(e.value->>'provider'='todoist' AND p.provider='tasks' AND p.id IN(SELECT value FROM json_each(${targets})))))
  AND (SELECT count(*) FROM plan_edges)=(SELECT count(*) FROM edges)
  AND NOT EXISTS(SELECT 1 FROM edges e WHERE NOT EXISTS(SELECT 1 FROM plan_edges p WHERE p.task_id=e.value->>'task_id' AND p.prerequisite_id=e.value->>'prerequisite_id' AND p.kind=e.value->>'kind' AND p.baseline_count=e.value->>'baseline_count' AND p.created_at=e.value->>'created_at'))
  AND (SELECT count(*) FROM plan_marks)=(SELECT count(*) FROM marks)
  AND NOT EXISTS(SELECT 1 FROM marks m WHERE NOT EXISTS(SELECT 1 FROM plan_marks p WHERE p.task_id=m.value->>'task_id' AND p.kind=m.value->>'kind' AND p.period=m.value->>'period' AND p.created_at=m.value->>'created_at')) AS ok)
INSERT INTO plan_tasks(id,provider,external_id,created_at,closed_at,closed_as)
SELECT e.value->>'id',CASE WHEN valid.ok THEN 'tasks' ELSE json('PLANNING_STATE_CHANGED') END,e.value->>'external_id',e.value->>'created_at',e.value->>'closed_at',e.value->>'closed_as'
FROM expected e CROSS JOIN valid WHERE e.value->>'id' IN(SELECT value FROM json_each(${targets}))
ON CONFLICT(id) DO UPDATE SET provider=excluded.provider
RETURNING id,provider,external_id;
`;
}
