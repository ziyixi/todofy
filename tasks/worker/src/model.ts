import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import {
  TaskSchema,
  ProjectSchema,
  SectionSchema,
  LabelSchema,
  SavedFilterSchema,
  type Task,
  type Project,
  type Section,
  type Label,
  type SavedFilter,
} from '@ziyixi/proto/tasks/ui/v1/task_pb';
import { invalid } from './errors.ts';

export type Table = 'tasks' | 'projects' | 'sections' | 'labels' | 'filters';
export type CatalogTable = Exclude<Table, 'tasks'>;
export interface BaseRow {
  id: string;
  title: string;
  revision: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  sort_order: number;
}
export interface TaskRow extends BaseRow {
  description: string;
  project_id: string;
  section_id: string;
  parent_id: string;
  label_ids: string;
  priority: number;
  due_date: string;
  due_datetime: string;
  due_timezone: string;
  deadline: string;
  duration_minutes: number;
  recurrence: string;
  completed: number;
  completed_at: number | null;
  project_archived?: number;
  parent_title?: string;
  completed_count?: number;
  child_count?: number;
  completed_child_count?: number;
}
export interface CatalogRow extends BaseRow {
  parent_id?: string;
  project_id?: string;
  color?: string;
  favorite?: number;
  archived?: number;
  inbox?: number;
  query?: string;
}
export const taskColumns = [
  'title',
  'description',
  'project_id',
  'section_id',
  'parent_id',
  'label_ids',
  'priority',
  'sort_order',
  'due_date',
  'due_datetime',
  'due_timezone',
  'deadline',
  'duration_minutes',
  'recurrence',
] as const;
export const catalogColumns = {
  projects: ['title', 'parent_id', 'color', 'favorite', 'archived', 'inbox', 'sort_order'],
  sections: ['title', 'project_id', 'archived', 'sort_order'],
  labels: ['title', 'color', 'favorite', 'sort_order'],
  filters: ['title', 'query', 'favorite', 'sort_order'],
} as const;
export function taskProjection(includeDescription: boolean, prefix = 't.'): string {
  const columns = [
    'id',
    ...taskColumns,
    'completed',
    'completed_at',
    'project_archived',
    'revision',
    'created_at',
    'updated_at',
    'deleted_at',
  ];
  return columns
    .map((column) =>
      column === 'description' && !includeDescription
        ? `substr(${prefix}description,1,240) AS description`
        : `${prefix}${column}`,
    )
    .join(',');
}
export const childCounts = `(SELECT p.title FROM tasks p WHERE p.id=t.parent_id) AS parent_title,
  t.completed_base_count+(SELECT count(*) FROM completions h WHERE h.task_id=t.id AND h.imported=0) AS completed_count,
  (SELECT count(*) FROM tasks c WHERE c.parent_id=t.id AND c.deleted_at IS NULL) AS child_count,
  (SELECT count(*) FROM tasks c WHERE c.parent_id=t.id AND c.deleted_at IS NULL AND c.completed=1) AS completed_child_count`;
export function resourceId(name: string, table: Table): string {
  const prefix = `${table}/`;
  if (!name.startsWith(prefix)) invalid();
  return checkedId(name.slice(prefix.length));
}
export function checkedId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) invalid('Invalid resource ID');
  return id;
}
function base(row: BaseRow, table: Table) {
  return {
    name: `${table}/${row.id}`,
    id: row.id,
    title: row.title,
    sortOrder: row.sort_order,
    etag: String(row.revision),
    createTime: timestampFromMs(row.created_at),
    updateTime: timestampFromMs(row.updated_at),
  };
}
export function taskMessage(row: TaskRow): Task {
  return create(TaskSchema, {
    ...base(row, 'tasks'),
    description: row.description,
    descriptionPreview: row.description.slice(0, 240),
    projectId: row.project_id,
    sectionId: row.section_id,
    parentId: row.parent_id,
    labelIds: JSON.parse(row.label_ids) as string[],
    priority: row.priority,
    dueDate: row.due_date,
    dueDatetime: row.due_datetime,
    dueTimezone: row.due_timezone,
    deadline: row.deadline,
    durationMinutes: row.duration_minutes,
    recurrence: row.recurrence,
    completed: row.completed === 1,
    archived: row.project_archived === 1,
    parentTitle: row.parent_title ?? '',
    completedCount: row.completed_count ?? 0,
    childCount: row.child_count ?? 0,
    completedChildCount: row.completed_child_count ?? 0,
    ...(row.completed_at === null ? {} : { completeTime: timestampFromMs(row.completed_at) }),
  });
}
export function catalogMessage(table: 'projects', row: CatalogRow): Project;
export function catalogMessage(table: 'sections', row: CatalogRow): Section;
export function catalogMessage(table: 'labels', row: CatalogRow): Label;
export function catalogMessage(table: 'filters', row: CatalogRow): SavedFilter;
export function catalogMessage(table: CatalogTable, row: CatalogRow): Project | Section | Label | SavedFilter;
export function catalogMessage(table: CatalogTable, row: CatalogRow) {
  const common = base(row, table);
  switch (table) {
    case 'projects':
      return create(ProjectSchema, {
        ...common,
        parentId: row.parent_id ?? '',
        color: row.color ?? '',
        favorite: row.favorite === 1,
        archived: row.archived === 1,
        inbox: row.inbox === 1,
      });
    case 'sections':
      return create(SectionSchema, {
        ...common,
        projectId: row.project_id ?? '',
        archived: row.archived === 1,
      });
    case 'labels':
      return create(LabelSchema, {
        ...common,
        color: row.color ?? '',
        favorite: row.favorite === 1,
      });
    case 'filters':
      return create(SavedFilterSchema, {
        ...common,
        query: row.query ?? '',
        favorite: row.favorite === 1,
      });
  }
}
export function camelCase(field: string): string {
  return field.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
