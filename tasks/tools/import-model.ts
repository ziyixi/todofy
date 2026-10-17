import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { validDate, validTimezone, localDate, zonedInstant } from '../../packages/task-dates/src/index.ts';
import { validateTaskFields } from '../worker/src/task-validation.ts';
import { validateCatalogFields } from '../worker/src/catalog.ts';
import { checkedId, type CatalogRow, type CatalogTable, type TaskRow } from '../worker/src/model.ts';

export class ImportError extends Error {}
type Source = Record<string, unknown>;
type ImportedTask = TaskRow & { completed_base_count: number };
interface CompletionRow {
  id: string;
  task_id: string;
  title: string;
  completed_at: number;
  due_date: string;
  project_id: string;
  task_created_at: number;
  imported: 1;
}
export interface ImportIssue {
  code: string;
  kind: string;
  id: string;
}
export interface ImportPlan {
  digest: string;
  timeZone: string;
  exportedAt: number;
  projects: CatalogRow[];
  sections: CatalogRow[];
  labels: CatalogRow[];
  filters: CatalogRow[];
  tasks: ImportedTask[];
  completions: CompletionRow[];
  recoveredHistoricalLabels: number;
  issues: ImportIssue[];
  gaps: string[];
}
function object(value: unknown): Source {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ImportError('SNAPSHOT_OBJECT_INVALID');
  return value as Source;
}
function text(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') throw new ImportError('SNAPSHOT_TEXT_INVALID');
  return value;
}
function number(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ImportError('SNAPSHOT_NUMBER_INVALID');
  return value;
}
function timestamp(value: unknown, fallback?: number): number {
  if (value === null || value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new ImportError('TASK_TIMESTAMP_MISSING');
  }
  const valueMs = Date.parse(text(value));
  if (!Number.isFinite(valueMs)) throw new ImportError('TASK_TIMESTAMP_INVALID');
  return valueMs;
}
function collection(snapshot: Source, key: string): Source[] {
  const value = snapshot[key];
  if (!Array.isArray(value)) throw new ImportError('SNAPSHOT_COLLECTION_MISSING');
  return value.map(object).filter((row) => !row.is_deleted);
}
function unique(rows: Source[]): Source[] {
  const found = new Map<string, Source>();
  for (const row of rows) {
    const id = checkedId(text(row.id));
    if (found.has(id)) throw new ImportError('DUPLICATE_RESOURCE_ID');
    found.set(id, row);
  }
  return [...found.values()];
}
// Todoist's documented named colors, normalized once during import; source snapshots retain the originals.
const colors: Record<string, string> = {
  berry_red: '#b8255f',
  red: '#db4035',
  orange: '#ff9933',
  yellow: '#fad000',
  olive_green: '#afb83b',
  lime_green: '#7ecc49',
  green: '#299438',
  mint_green: '#6accbc',
  teal: '#158fad',
  sky_blue: '#14aaf5',
  light_blue: '#96c3eb',
  blue: '#4073ff',
  grape: '#884dff',
  violet: '#af38eb',
  lavender: '#eb96eb',
  magenta: '#e05194',
  salmon: '#ff8d85',
  charcoal: '#808080',
  grey: '#b8b8b8',
  taupe: '#ccac93',
};
function color(value: unknown): string {
  const name = text(value);
  if (!name || /^#[a-f0-9]{6}$/i.test(name)) return name;
  if (!colors[name]) throw new ImportError('COLOR_UNSUPPORTED');
  return colors[name];
}
function catalogRow(row: Source, table: CatalogTable, exportedAt: number): CatalogRow {
  const common: CatalogRow = {
    id: checkedId(text(row.id)),
    title: text(row.name),
    sort_order: number(row.child_order ?? row.section_order ?? row.item_order),
    revision: 1,
    created_at: timestamp(row.added_at ?? row.created_at, exportedAt),
    updated_at: timestamp(row.updated_at, exportedAt),
    deleted_at: null,
  };
  if (table === 'projects')
    Object.assign(common, {
      parent_id: text(row.parent_id),
      color: color(row.color),
      favorite: Number(Boolean(row.is_favorite)),
      archived: Number(Boolean(row.is_archived)),
      inbox: Number(Boolean(row.inbox_project)),
    });
  if (table === 'sections')
    Object.assign(common, { project_id: checkedId(text(row.project_id)), archived: Number(Boolean(row.is_archived)) });
  if (table === 'labels')
    Object.assign(common, { color: color(row.color), favorite: Number(Boolean(row.is_favorite)) });
  if (table === 'filters')
    Object.assign(common, { query: text(row.query), favorite: Number(Boolean(row.is_favorite)) });
  return common;
}
function topological<T extends { id: string; parent_id?: string }>(rows: T[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const sorted: T[] = [];
  function visit(row: T, depth: number): void {
    if (done.has(row.id)) return;
    if (visiting.has(row.id) || depth > 32) throw new ImportError('HIERARCHY_CYCLE_OR_DEPTH');
    visiting.add(row.id);
    if (row.parent_id) {
      const parent = byId.get(row.parent_id);
      if (!parent) throw new ImportError('PARENT_RESOURCE_MISSING');
      visit(parent, depth + 1);
    }
    visiting.delete(row.id);
    done.add(row.id);
    sorted.push(row);
  }
  for (const row of rows) visit(row, 1);
  return sorted;
}
function sortedPositions(rows: Source[], group: (row: Source) => string): Map<string, number> {
  const groups = new Map<string, Source[]>();
  for (const row of rows) {
    const key = group(row);
    const previous = groups.get(key) ?? [];
    previous.push(row);
    groups.set(key, previous);
  }
  const positions = new Map<string, number>();
  for (const members of groups.values()) {
    members.sort((a, b) =>
      typeof a.order_key === 'string' && typeof b.order_key === 'string'
        ? a.order_key < b.order_key
          ? -1
          : a.order_key > b.order_key
            ? 1
            : 0
        : number(a.child_order ?? a.section_order ?? a.item_order) -
          number(b.child_order ?? b.section_order ?? b.item_order),
    );
    members.forEach((row, index) => positions.set(text(row.id), (index + 1) * 1024));
  }
  return positions;
}
function taskRow(row: Source, labels: CatalogRow[], complete: boolean, zone: string): ImportedTask {
  const due = row.due ? object(row.due) : {};
  const dueText = text(due.date);
  const rawInstant = text(due.datetime) || (dueText.includes('T') ? dueText : '');
  const dueZone = rawInstant ? text(due.timezone, zone) || zone : '';
  const instant =
    rawInstant && !/(Z|[+-]\d{2}:\d{2})$/.test(rawInstant)
      ? zonedInstant(rawInstant.length === 16 ? `${rawInstant}:00` : rawInstant, dueZone)
      : rawInstant;
  const deadline = row.deadline ? text(object(row.deadline).date) : '';
  const duration = row.duration ? object(row.duration) : {};
  if (duration.unit && duration.unit !== 'minute' && duration.unit !== 'day')
    throw new ImportError('DURATION_UNIT_UNSUPPORTED');
  const completedCount=number(row.completed_count);
  if(!Number.isInteger(completedCount)||completedCount<0)throw new ImportError('COMPLETION_COUNT_INVALID');
  const labelValues = row.labels ?? [];
  if (!Array.isArray(labelValues)) throw new ImportError('TASK_LABELS_INVALID');
  const labelIds = labelValues.map((value) => {
    const given = text(value);
    const matches = labels.filter((label) => label.id === given || label.title === given);
    if (matches.length !== 1) throw new ImportError('TASK_LABEL_IDENTITY_UNRESOLVED');
    return matches[0]?.id;
  });
  return {
    id: checkedId(text(row.id)),
    title: text(row.content),
    description: text(row.description),
    project_id: text(row.project_id),
    section_id: text(row.section_id),
    parent_id: text(row.parent_id),
    label_ids: JSON.stringify(labelIds),
    priority: 5 - number(row.priority, 1),
    sort_order: number(row.child_order),
    due_date: instant ? localDate(Date.parse(instant), dueZone) : dueText.slice(0, 10),
    due_datetime: instant,
    due_timezone: dueZone,
    deadline,
    duration_minutes: number(duration.amount) * (duration.unit === 'day' ? 1440 : 1),
    recurrence: due.is_recurring ? text(due.string) : '',
    completed: Number(complete),
    completed_at: complete ? timestamp(row.completed_at) : null,
    completed_base_count: completedCount,
    revision: 1,
    created_at: timestamp(row.added_at ?? row.created_at),
    updated_at: timestamp(
      row.updated_at,
      row.completed_at ? timestamp(row.completed_at) : timestamp(row.added_at ?? row.created_at),
    ),
    deleted_at: null,
  };
}

/** Normalizes only an explicit private snapshot. It never calls Todoist or Cloudflare. */
export function prepareImport(value: unknown): ImportPlan {
  const source = object(value);
  if (source.version !== 1 || source.source !== 'todoist') throw new ImportError('SNAPSHOT_VERSION_INVALID');
  const exportedAt = timestamp(source.exported_at);
  const timeZone = text(source.time_zone);
  if (!validTimezone(timeZone)) throw new ImportError('ACCOUNT_TIMEZONE_INVALID');
  const issues: ImportIssue[] = [];
  const issue = (code: string, kind: string, id: string) => issues.push({ code, kind, id });
  const catalog = (table: CatalogTable) =>
    unique(collection(source, table)).map((row) => {
      const result = catalogRow(row, table, exportedAt);
      try {
        validateCatalogFields(table, result);
      } catch {
        issue(table === 'filters' ? 'FILTER_UNSUPPORTED' : 'CATALOG_VALUE_INVALID', table, result.id);
      }
      return result;
    });
  const projects = topological(catalog('projects'));
  const sections = catalog('sections');
  const labels = catalog('labels');
  const sourceLabels = [...labels];
  const filters = catalog('filters');
  if (projects.filter((p) => p.inbox === 1).length !== 1) throw new ImportError('EXACTLY_ONE_INBOX_REQUIRED');
  const active = unique(collection(source, 'tasks'));
  const histories = collection(source, 'completed');
  for (const history of histories) {
    const values = history.labels ?? [];
    if (!Array.isArray(values)) throw new ImportError('TASK_LABELS_INVALID');
    for (const value of values) {
      const name = text(value);
      if (labels.some((label) => label.id === name || label.title === name)) continue;
      if (labels.some((label) => label.title.toLowerCase() === name.toLowerCase()))
        throw new ImportError('HISTORICAL_LABEL_NAME_CONFLICT');
      const recovered = catalogRow({
        id: `imported-label-${createHash('sha256').update(name).digest('hex')}`,
        name, is_favorite: false,
      }, 'labels', exportedAt);
      recovered.sort_order = Math.max(0, ...labels.map((label) => label.sort_order)) + 1;
      try { validateCatalogFields('labels', recovered); }
      catch { issue('CATALOG_VALUE_INVALID', 'labels', recovered.id); }
      labels.push(recovered);
    }
  }
  for (const [kind, rows] of Object.entries({ projects, sections, labels, filters }))
    if (rows.length > 500) issue('CATALOG_CAPACITY_EXCEEDED', kind, '');
  const activeIds = new Set(active.map((task) => text(task.id)));
  const current = new Map(active.map((row) => [text(row.id), { row, complete: Boolean(row.checked) }]));
  for (const row of [...histories].sort((a, b) => timestamp(a.completed_at) - timestamp(b.completed_at))) {
    const id = checkedId(text(row.id));
    if (!activeIds.has(id)) current.set(id, { row, complete: true });
  }
  const taskPositions = sortedPositions(
    [...current.values()].map((item) => item.row),
    (row) => `${text(row.project_id)}:${text(row.section_id)}:${text(row.parent_id)}`,
  );
  const tasks = topological(
    [...current.values()].map(({ row, complete }) => {
      const task = taskRow(row, activeIds.has(text(row.id)) ? sourceLabels : labels, complete, timeZone);
      task.sort_order = taskPositions.get(task.id) ?? 0;
      try {
        validateTaskFields(task);
      } catch {
        issue(task.recurrence ? 'TASK_DATE_OR_RECURRENCE_UNSUPPORTED' : 'TASK_VALUE_INVALID', 'tasks', task.id);
      }
      return task;
    }),
  );
  const projectIds = new Set(projects.map((p) => p.id));
  const sectionById = new Map(sections.map((s) => [s.id, s]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  for (const section of sections)
    if (!projectIds.has(section.project_id ?? '')) throw new ImportError('SECTION_PROJECT_MISSING');
  for (const task of tasks) {
    if (task.project_id && !projectIds.has(task.project_id)) throw new ImportError('TASK_PROJECT_MISSING');
    if (task.section_id && sectionById.get(task.section_id)?.project_id !== task.project_id)
      throw new ImportError('TASK_SECTION_MISMATCH');
    if (task.parent_id && taskById.get(task.parent_id)?.project_id !== task.project_id)
      throw new ImportError('TASK_PARENT_PROJECT_MISMATCH');
  }
  const events = source.completion_events === undefined ? [] : collection(source, 'completion_events');
  const activityTaskIds = new Set(events.map((event) => checkedId(text(event.object_id))));
  const completionRows = new Map<string, CompletionRow>();
  for (const row of histories) {
    const taskId = checkedId(text(row.id));
    if (activityTaskIds.has(taskId)) continue;
    const completedAt = timestamp(row.completed_at);
    const identity = `${taskId}:${String(completedAt)}`;
    if (completionRows.has(identity)) continue;
    completionRows.set(identity, {
      id: `todoist-${createHash('sha256').update(identity).digest('hex')}`,
      task_id: taskId,
      title: text(row.content),
      completed_at: completedAt,
      due_date: row.due ? text(object(row.due).date).slice(0, 10) : '',
      project_id: text(row.project_id),
      task_created_at: timestamp(row.added_at ?? row.created_at),
      imported: 1,
    });
  }
  const eventIdentities = new Map<string, string>();
  for (const event of events) {
    if (event.object_type !== 'item' || event.event_type !== 'completed')
      throw new ImportError('COMPLETION_EVENT_INVALID');
    const taskId = checkedId(text(event.object_id));
    const completedAt = timestamp(event.event_date);
    const identity = `${taskId}:${String(completedAt)}`;
    const eventId = event.id === undefined || event.id === null
      ? identity
      : typeof event.id === 'number' && Number.isSafeInteger(event.id)
        ? String(event.id)
        : text(event.id);
    const previous = eventIdentities.get(eventId);
    if (previous && previous !== identity) throw new ImportError('COMPLETION_EVENT_IDENTITY_CONFLICT');
    eventIdentities.set(eventId, identity);
    const currentTask = taskById.get(taskId);
    const extra = event.extra_data ? object(event.extra_data) : {};
    const due = text(extra.due_date).slice(0, 10);
    completionRows.set(`activity:${eventId}`, {
      id: `todoist-${createHash('sha256').update(`activity:${eventId}`).digest('hex')}`,
      task_id: taskId,
      title: text(extra.content, currentTask?.title ?? ''),
      completed_at: completedAt,
      due_date: validDate(due) ? due : '',
      project_id: text(event.parent_project_id),
      task_created_at: currentTask?.created_at ?? 0,
      imported: 1,
    });
  }
  const completions = [...completionRows.values()].sort((a, b) =>
    a.completed_at - b.completed_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const occurrenceCounts = new Map<string, number>();
  for (const completion of completions)
    occurrenceCounts.set(completion.task_id, (occurrenceCounts.get(completion.task_id) ?? 0) + 1);
  const gaps = [];
  for (const task of tasks) {
    const sourceTask = current.get(task.id)?.row;
    if (sourceTask?.completed_count !== undefined && sourceTask.completed_count !== null) continue;
    if (task.recurrence && !gaps.includes('RECURRING_COMPLETION_COUNT_MISSING'))
      gaps.push('RECURRING_COMPLETION_COUNT_MISSING');
    task.completed_base_count = occurrenceCounts.get(task.id) ?? Number(Boolean(task.completed));
  }
  if (source.archived_contents_verified !== true) gaps.push('ARCHIVED_CONTENTS_UNVERIFIED');
  if (source.recurring_history_verified !== true) gaps.push('RECURRING_HISTORY_UNVERIFIED');
  return {
    digest: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    timeZone,
    exportedAt,
    projects,
    sections,
    labels,
    filters,
    tasks,
    completions,
    recoveredHistoricalLabels: labels.length - sourceLabels.length,
    issues,
    gaps,
  };
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ImportError('NONFINITE_SQL_VALUE');
    return String(value);
  }
  if (typeof value !== 'string') throw new ImportError('INVALID_SQL_VALUE');
  return `CAST(X'${Buffer.from(value, 'utf8').toString('hex')}' AS TEXT)`;
}
function insert(table: string, row: object): string {
  const pairs = Object.entries(row).filter(
    ([key]) => !['child_count', 'completed_child_count', 'completed_count', 'parent_title'].includes(key),
  );
  return `INSERT INTO ${table}(${pairs.map(([key]) => key).join(',')}) VALUES(${pairs.map(([, value]) => literal(value)).join(',')}) ON CONFLICT(id) DO NOTHING;`;
}
/** Frozen SQL may resume only the same snapshot and only before any owner/application mutation. */
export function importStatements(plan: ImportPlan, previewIncomplete = false): string[] {
  if (plan.issues.length) throw new ImportError('IMPORT_HAS_UNSUPPORTED_VALUES');
  if (plan.gaps.length && !previewIncomplete) throw new ImportError('IMPORT_COVERAGE_NOT_VERIFIED');
  const digest = literal(plan.digest);
  const empty = ['tasks', 'projects', 'sections', 'labels', 'filters', 'completions', 'requests']
    .map((table) => `NOT EXISTS(SELECT 1 FROM ${table})`)
    .join(' AND ');
  const same = `EXISTS(SELECT 1 FROM requests WHERE id='native-import' AND fingerprint=${digest}) AND NOT EXISTS(SELECT 1 FROM requests WHERE id<>'native-import')`;
  const guard = `INSERT INTO requests(id,fingerprint,response,created_at,revision_guard) VALUES('native-import',${digest},'{}',${String(plan.exportedAt)},CASE WHEN (${empty}) OR (${same}) THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET fingerprint=CASE WHEN requests.fingerprint=excluded.fingerprint THEN requests.fingerprint ELSE NULL END;`;
  return [
    guard,
    ...plan.projects.map((r) => insert('projects', r)),
    ...plan.sections.map((r) => insert('sections', r)),
    ...plan.labels.map((r) => insert('labels', r)),
    ...plan.filters.map((r) => insert('filters', r)),
    ...plan.tasks.map((r) => insert('tasks', r)),
    ...plan.completions.map((r) => insert('completions', r)),
  ];
}
