import { create } from "@ziyixi/proto/protobuf";
import { EmptySchema } from "@ziyixi/proto/protobuf/wkt";
import { conflict, missing, precondition, storage } from "./errors.ts";
import { resourceId, type CatalogRow, type CatalogTable } from "./model.ts";
import { commit, fingerprint, replay } from "./receipts.ts";

// UNION keeps this bounded by the actual project set even if an old import contained a cycle.
const family = `WITH RECURSIVE family(id) AS (
  SELECT id FROM projects WHERE id=?
  UNION SELECT p.id FROM projects p JOIN family f ON p.parent_id=f.id WHERE p.deleted_at IS NULL
)`;

function containedWrites(
  db: D1Database,
  table: CatalogTable,
  id: string,
  now: number,
): D1PreparedStatement[] {
  if (table === "projects") {
    return [
      db
        .prepare(
          `${family} UPDATE tasks SET deleted_at=?,updated_at=?,revision=revision+1
        WHERE project_id IN (SELECT id FROM family) AND deleted_at IS NULL`,
        )
        .bind(id, now, now),
      db
        .prepare(
          `${family} UPDATE sections SET deleted_at=?,updated_at=?,revision=revision+1
        WHERE project_id IN (SELECT id FROM family) AND deleted_at IS NULL`,
        )
        .bind(id, now, now),
      db
        .prepare(
          `${family} UPDATE projects SET deleted_at=?,updated_at=?,revision=revision+1
        WHERE id IN (SELECT id FROM family) AND deleted_at IS NULL`,
        )
        .bind(id, now, now),
    ];
  }
  if (table === "sections") {
    return [
      db
        .prepare(
          `WITH RECURSIVE contained(id) AS (
        SELECT id FROM tasks WHERE section_id=? AND deleted_at IS NULL
        UNION SELECT t.id FROM tasks t JOIN contained c ON t.parent_id=c.id WHERE t.deleted_at IS NULL
      ) UPDATE tasks SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id IN (SELECT id FROM contained)`,
        )
        .bind(id, now, now),
      db
        .prepare(
          "UPDATE sections SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?",
        )
        .bind(now, now, id),
    ];
  }
  if (table === "labels") {
    return [
      db
        .prepare(
          `UPDATE tasks SET label_ids=(SELECT json_group_array(value) FROM json_each(tasks.label_ids)
        WHERE value<>?),updated_at=?,revision=revision+1
        WHERE deleted_at IS NULL AND EXISTS(SELECT 1 FROM json_each(tasks.label_ids) WHERE value=?)`,
        )
        .bind(id, now, id),
      db
        .prepare(
          "UPDATE labels SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?",
        )
        .bind(now, now, id),
    ];
  }
  return [
    db
      .prepare(
        "UPDATE filters SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?",
      )
      .bind(now, now, id),
  ];
}

/** Catalog deletion follows Todoist semantics; history and unrelated tasks remain in place. */
export async function deleteCatalog(
  db: D1Database,
  table: CatalogTable,
  input: { name: string; etag: string; requestId: string },
  now: number,
) {
  const hash = await fingerprint(`delete:${table}`, input);
  if ((await replay(db, input.requestId, hash)) !== null)
    return create(EmptySchema);
  const id = resourceId(input.name, table);
  const row = await storage(() =>
    db
      .prepare(`SELECT * FROM ${table} WHERE id=? AND deleted_at IS NULL`)
      .bind(id)
      .first<CatalogRow>(),
  );
  if (!row) missing();
  if (String(row.revision) !== input.etag) conflict();
  if (table === "projects" && row.inbox)
    precondition("Inbox cannot be deleted");
  await commit(
    db,
    {
      requestId: input.requestId,
      hash,
      table,
      id,
      revision: row.revision,
      response: "{}",
      now,
    },
    containedWrites(db, table, id, now),
  );
  return create(EmptySchema);
}
