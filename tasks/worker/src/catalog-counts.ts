import { addDays, localDate } from "@ziyixi/task-dates";
import type { TaskCount } from "@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb";
import { taskFilter } from "./filters.ts";
import type { CatalogRow } from "./model.ts";
import { storage } from "./errors.ts";

interface CountRow {
  view: string;
  id: string;
  count: number;
}

/** Counts use the same open-task scope as ListTasks, without fetching task bodies. */
export async function catalogCounts(
  db: D1Database,
  catalog: {
    projects: CatalogRow[];
    labels: CatalogRow[];
    filters: CatalogRow[];
  },
  zone: string,
  now: number,
): Promise<Omit<TaskCount, "$typeName">[]> {
  const today = localDate(now, zone);
  const active = "t.deleted_at IS NULL AND t.completed=0";
  const visible = `${active} AND t.project_archived=0`;
  const results = await storage(() =>
    db.batch<CountRow>([
      db
        .prepare(
          `SELECT 'inbox' AS view,'' AS id,COUNT(*) AS count FROM tasks t
      WHERE ${visible} AND t.parent_id='' AND (t.project_id='' OR t.project_id IN
        (SELECT id FROM projects WHERE inbox=1 AND deleted_at IS NULL))
      UNION ALL SELECT 'today','',COUNT(*) FROM tasks t
      WHERE ${visible} AND t.due_date<>'' AND t.due_date<=?
      UNION ALL SELECT 'upcoming','',COUNT(*) FROM tasks t
      WHERE ${visible} AND t.due_date>=? AND t.due_date<?`,
        )
        .bind(today, today, addDays(today, 7)),
      db.prepare(`SELECT 'project' AS view,t.project_id AS id,COUNT(*) AS count FROM tasks t
      WHERE ${active} AND t.parent_id='' GROUP BY t.project_id`),
      db.prepare(`SELECT 'label' AS view,tl.label_id AS id,COUNT(*) AS count FROM task_labels tl
      JOIN tasks t ON t.id=tl.task_id WHERE ${visible} GROUP BY tl.label_id`),
    ]),
  );
  const counts = results.flatMap((result) => result.results);
  for (const [view, items] of [
    ["project", catalog.projects],
    ["label", catalog.labels],
  ] as const) {
    for (const item of items) {
      if (!counts.some((row) => row.view === view && row.id === item.id))
        counts.push({ view, id: item.id, count: 0 });
    }
  }
  // One parameter holds each chunk's values, keeping saved-filter counts below D1's
  // binding limit. Twenty filters per statement also bounds a 500-filter catalog to 25 reads.
  for (let start = 0; start < catalog.filters.length; start += 20) {
    const values: (string | number)[] = [];
    const value = (item: string | number) => {
      const index = values.push(item) - 1;
      return `json_extract(?1,'$[${String(index)}]')`;
    };
    const filters = catalog.filters.slice(start, start + 20);
    const columns = filters.map((filter, column) => {
      const parsed = taskFilter(filter.query ?? "", today);
      let index = 0;
      const predicate = parsed.sql.replace(/\?/g, () =>
        value(parsed.values[index++] as string | number),
      );
      return `COUNT(*) FILTER (WHERE ${predicate}) AS count_${String(column)}`;
    });
    const statement = db.prepare(
      `SELECT ${columns.join(",")} FROM tasks t WHERE ${visible}`,
    );
    const response = await storage(() =>
      (values.length
        ? statement.bind(JSON.stringify(values))
        : statement
      ).first<Record<string, number>>(),
    );
    for (const [index, filter] of filters.entries())
      counts.push({
        view: "filter",
        id: filter.id,
        count: response?.[`count_${String(index)}`] ?? 0,
      });
  }
  return counts.filter(
    (row) =>
      row.view !== "project" ||
      catalog.projects.some((project) => project.id === row.id),
  );
}
