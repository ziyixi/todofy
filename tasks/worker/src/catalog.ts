import {
  create,
  type DescMessage,
  type MessageShape,
} from "@ziyixi/proto/protobuf";
import { updatePaths } from "@ziyixi/proto/field-mask";
import { fromWire, toWire } from "@ziyixi/proto/wire-json";
import {
  ProjectSchema,
  SectionSchema,
  LabelSchema,
  SavedFilterSchema,
} from "@ziyixi/proto/tasks/ui/v1/task_pb";
import { CatalogSchema } from "@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb";
import { taskFilter } from "./filters.ts";
import { catalogCounts } from "./catalog-counts.ts";
import {
  catalogColumns,
  catalogMessage,
  camelCase,
  checkedId,
  resourceId,
  type CatalogRow,
  type CatalogTable,
} from "./model.ts";
import { conflict, invalid, missing, precondition, storage } from "./errors.ts";
import { commit, fingerprint, replay } from "./receipts.ts";
import { moveSectionTasks } from "./task-moves.ts";
export { deleteCatalog } from "./catalog-delete.ts";

const schemas = {
  projects: ProjectSchema,
  sections: SectionSchema,
  labels: LabelSchema,
  filters: SavedFilterSchema,
} as const;
export async function getCatalog(db: D1Database, zone: string, now = Date.now()) {
  const tables = Object.keys(schemas) as CatalogTable[];
  const results = await storage(() =>
    db.batch(
      tables.map((table) =>
        db.prepare(
          `SELECT * FROM ${table} WHERE deleted_at IS NULL ORDER BY sort_order,id LIMIT 501`,
        ),
      ),
    ),
  );
  if (results.some((r) => r.results.length > 500))
    precondition("Catalog exceeds the 500 entries per kind limit");
  const [projectResult, sectionResult, labelResult, filterResult] = results;
  if (!projectResult || !sectionResult || !labelResult || !filterResult)
    throw new Error("Incomplete catalog batch");
  const projects = projectResult.results as unknown as CatalogRow[];
  const sections = sectionResult.results as unknown as CatalogRow[];
  const labels = labelResult.results as unknown as CatalogRow[];
  const filters = filterResult.results as unknown as CatalogRow[];
  return create(CatalogSchema, {
    name: "catalog",
    projects: projects.map((r) => catalogMessage("projects", r)),
    sections: sections.map((r) => catalogMessage("sections", r)),
    labels: labels.map((r) => catalogMessage("labels", r)),
    filters: filters.map((r) => catalogMessage("filters", r)),
    timeZone: zone,
    taskCounts: await catalogCounts(db, { projects, labels, filters }, zone, now),
  });
}
export function validateCatalogFields(
  table: CatalogTable,
  row: CatalogRow,
): void {
  if (
    !row.title.trim() ||
    row.title.length >
      (table === "projects" || table === "sections" ? 200 : 100) ||
    !Number.isFinite(row.sort_order)
  )
    invalid();
  if (row.color && !/^#[0-9a-fA-F]{6}$/.test(row.color))
    invalid("Color must be a six-digit hex color");
  if (table === "filters") taskFilter(row.query ?? "", "2026-01-01");
}
async function validate(
  db: D1Database,
  table: CatalogTable,
  row: CatalogRow,
): Promise<void> {
  validateCatalogFields(table, row);
  if (table === "sections" || (table === "projects" && row.parent_id)) {
    const parent = table === "sections" ? row.project_id : row.parent_id;
    if (!parent) invalid("Section needs a project");
    checkedId(parent);
    const project = await storage(() =>
      db
        .prepare("SELECT id FROM projects WHERE id=? AND deleted_at IS NULL")
        .bind(parent)
        .first(),
    );
    if (!project) precondition("Parent project does not exist");
    if (table === "projects") {
      const cycle = await storage(() =>
        db
          .prepare(
            `WITH RECURSIVE ancestors(id,parent_id,depth) AS (
        SELECT id,parent_id,1 FROM projects WHERE id=? UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM projects p JOIN ancestors a ON p.id=a.parent_id WHERE a.depth<32
      ) SELECT id FROM ancestors WHERE id=? OR depth=32 LIMIT 1`,
          )
          .bind(parent, row.id)
          .first(),
      );
      if (cycle)
        invalid("Project hierarchy would contain a cycle or exceed 32 levels");
    }
  }
}
interface SaveInput {
  etag?: string;
  requestId: string;
  id: string;
  resource: { name: string; etag: string };
  updateMask?: { paths: string[] };
}
export async function saveCatalog<S extends DescMessage>(
  db: D1Database,
  table: CatalogTable,
  schema: S,
  input: SaveInput,
  createNew: boolean,
  now: number,
): Promise<MessageShape<S>> {
  const resource = input.resource as unknown as Record<string, unknown>;
  // Preserve existing request receipts: old filter messages did not contain the default color field.
  const hashInput = table === "filters" && resource.color === ""
    ? { ...input, resource: Object.fromEntries(Object.entries(resource).filter(([key]) => key !== "color")) }
    : input;
  const hash = await fingerprint(
    `${createNew ? "create" : "update"}:${table}`,
    hashInput,
  );
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return fromWire(schema, JSON.parse(previous)).message;
  const id = createNew
    ? input.id
      ? checkedId(input.id)
      : crypto.randomUUID()
    : resourceId(input.resource.name, table);
  const existing = createNew
    ? null
    : await storage(() =>
        db
          .prepare(`SELECT * FROM ${table} WHERE id=? AND deleted_at IS NULL`)
          .bind(id)
          .first<CatalogRow>(),
      );
  if (!createNew && !existing) missing();
  if (existing && String(existing.revision) !== input.etag) conflict();
  if (existing && !input.updateMask?.paths.length)
    invalid("An explicit update_mask is required");
  const fields = catalogColumns[table];
  const requested = createNew ? "*" : updatePaths(input.updateMask);
  const paths = requested === "*" ? fields : requested;
  const row: CatalogRow = existing
    ? { ...existing }
    : {
        id,
        title: "",
        sort_order: 0,
        revision: 0,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      };
  for (const field of paths) {
    if (!(fields as readonly string[]).includes(field))
      invalid("Unsupported catalog field");
    const value = resource[camelCase(field)];
    Object.assign(row, {
      [field]: typeof value === "boolean" ? Number(value) : value,
    });
  }
  row.title = row.title.trim();
  row.revision++;
  row.updated_at = now;
  await validate(db, table, row);
  const sectionMove = table === "sections" && existing !== null && row.project_id !== existing.project_id;
  const movedTasks = sectionMove ? await moveSectionTasks(db, id, row.project_id ?? "", now) : [];
  // Apply archive visibility after moving tasks to their section's new project.
  const writtenFields = sectionMove ? fields.filter((field) => field !== "archived") : fields;
  const columns = ["id", ...fields, "revision", "created_at", "updated_at"];
  const data = row as unknown as Record<string, string | number>;
  const write = createNew
    ? db
        .prepare(
          `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
        )
        .bind(...columns.map((c) => data[c]))
    : db
        .prepare(
          `UPDATE ${table} SET ${writtenFields.map((c) => `${c}=?`).join(",")},revision=revision+1,updated_at=? WHERE id=?`,
        )
        .bind(...writtenFields.map((c) => data[c]), now, id);
  const writes = [write, ...movedTasks];
  if (sectionMove && row.archived !== existing.archived)
    writes.push(db.prepare("UPDATE sections SET archived=? WHERE id=?").bind(row.archived ?? 0, id));
  const body = JSON.stringify(
    toWire(schema, catalogMessage(table, row) as unknown as MessageShape<S>),
  );
  const answer = await commit(
    db,
    {
      requestId: input.requestId,
      hash,
      table,
      id,
      revision: existing?.revision ?? null,
      response: body,
      now,
    },
    writes,
  );
  return fromWire(schema, JSON.parse(answer)).message;
}
