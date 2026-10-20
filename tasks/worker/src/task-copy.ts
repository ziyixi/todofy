import { TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import { localDate } from "@ziyixi/task-dates";
import type { DuplicateTaskRequest } from "@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb";
import { fromWire, toWire } from "@ziyixi/proto/wire-json";
import { conflict, invalid, precondition, storage } from "./errors.ts";
import { taskColumns, resourceId, taskMessage, type TaskRow } from "./model.ts";
import { commit, fingerprint, replay } from "./receipts.ts";
import { getTask } from "./task-read.ts";
import { validateTask } from "./task-validation.ts";

const MAX_COPY_TASKS = 100;
const family = `WITH RECURSIVE family(id,depth) AS (
  SELECT id,0 FROM tasks WHERE id=? AND deleted_at IS NULL
  UNION ALL SELECT t.id,f.depth+1 FROM tasks t JOIN family f ON t.parent_id=f.id
  WHERE t.deleted_at IS NULL AND t.completed=0 AND f.depth<31 LIMIT ${String(MAX_COPY_TASKS + 1)}
)`;
const withinLimit = `(SELECT count(*) FROM family)<=${String(MAX_COPY_TASKS)}
  AND NOT EXISTS(SELECT 1 FROM tasks t JOIN family f ON t.parent_id=f.id
    WHERE f.depth=31 AND t.deleted_at IS NULL AND t.completed=0)`;

/** A copy keeps its planning facts but no dependencies, and a copied commitment reads as weekly. */
export async function duplicateTask(
  db: D1Database,
  input: DuplicateTaskRequest,
  now: number,
  zone: string,
) {
  const hash = await fingerprint("duplicateTask", input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null)
    return fromWire(TaskSchema, JSON.parse(previous)).message;
  const sourceId = resourceId(input.name, "tasks");
  const source = await getTask(db, sourceId);
  if (!input.etag) invalid("An etag is required");
  if (String(source.revision) !== input.etag) conflict();
  const bounded = await storage(() =>
    db
      .prepare(`${family} SELECT ${withinLimit} AS allowed`)
      .bind(sourceId)
      .first<{ allowed: number }>(),
  );
  if (!bounded?.allowed)
    precondition("Duplicate supports up to 100 active tasks and 32 levels");
  const row: TaskRow = {
    ...source,
    id: crypto.randomUUID(),
    sort_order: source.sort_order + 0.5,
    completed: 0,
    completed_at: null,
    completed_count: 0,
    child_count: 0,
    completed_child_count: 0,
    revision: 1,
    created_at: now,
    updated_at: now,
    committed_week: "",
    dependencies: "[]",
  };
  await validateTask(db, row);
  const columns = ["id", ...taskColumns, "created_at", "updated_at"];
  const copiedValues = columns.map((column) => {
    if (column === "id") return "c.new_id";
    if (column === "parent_id") return "COALESCE(p.new_id,t.parent_id)";
    if (column === "sort_order")
      return "CASE WHEN c.depth=0 THEN t.sort_order+0.5 ELSE t.sort_order END";
    if (column === "created_at" || column === "updated_at") return "?";
    return `t.${column}`;
  });
  await commit(
    db,
    {
      requestId: input.requestId,
      hash,
      table: "tasks",
      id: sourceId,
      revision: source.revision,
      response: JSON.stringify(
        toWire(TaskSchema, taskMessage(row, localDate(now, zone))),
      ),
      now,
    },
    [
      // Recheck the bound inside the transaction, in case a child arrived after the read.
      db
        .prepare(
          `${family} UPDATE requests SET revision_guard=CASE WHEN ${withinLimit} THEN 1 ELSE 0 END WHERE id=?`,
        )
        .bind(sourceId, input.requestId),
      db
        .prepare(
          `UPDATE tasks SET sort_order=sort_order+1,revision=revision+1,updated_at=?
      WHERE project_id=? AND section_id=? AND parent_id=? AND deleted_at IS NULL
        AND (sort_order>? OR (sort_order=? AND id>?))`,
        )
        .bind(
          now,
          source.project_id,
          source.section_id,
          source.parent_id,
          source.sort_order,
          source.sort_order,
          sourceId,
        ),
      // Materialize IDs once and insert parents first; descriptions never leave D1 for the copy.
      db
        .prepare(
          `${family}, copies AS MATERIALIZED (
      SELECT id,depth,CASE WHEN depth=0 THEN ? ELSE lower(hex(randomblob(16))) END AS new_id FROM family
    ) INSERT INTO tasks(${columns.join(",")})
      SELECT ${copiedValues.join(",")} FROM copies c JOIN tasks t ON t.id=c.id
        LEFT JOIN copies p ON p.id=t.parent_id ORDER BY c.depth,t.sort_order,t.id`,
        )
        .bind(sourceId, row.id, now, now),
      db
        .prepare(
          "UPDATE requests SET response=json_set(response,'$.child_count',(SELECT count(*) FROM tasks WHERE parent_id=? AND deleted_at IS NULL)) WHERE id=?",
        )
        .bind(row.id, input.requestId),
    ],
  );
  const stored = await replay(db, input.requestId, hash);
  if (stored === null)
    throw new Error("Committed duplicate receipt is missing");
  return fromWire(TaskSchema, JSON.parse(stored)).message;
}
