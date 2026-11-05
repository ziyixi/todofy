import { expect, test } from 'vitest';
import {
  camelCase,
  catalogMessage,
  checkedId,
  resourceId,
  taskMessage,
  taskProjection,
  type CatalogRow,
  type TaskRow,
} from '../src/model.ts';

test('checkedId and resourceId validate resource identifiers and table prefixes', () => {
  expect(checkedId('task_123-abc')).toBe('task_123-abc');
  expect(() => checkedId('')).toThrow('Invalid resource ID');
  expect(() => checkedId('a'.repeat(129))).toThrow('Invalid resource ID');
  expect(() => checkedId('has space')).toThrow('Invalid resource ID');

  expect(resourceId('tasks/task-1', 'tasks')).toBe('task-1');
  expect(resourceId('projects/proj-1', 'projects')).toBe('proj-1');
  expect(() => resourceId('projects/proj-1', 'tasks')).toThrow('Invalid task input');
  expect(() => resourceId('tasks/bad/id', 'tasks')).toThrow('Invalid resource ID');
});

test('camelCase and taskProjection format SQL column names and description previews', () => {
  expect(camelCase('effective_key_result_id')).toBe('effectiveKeyResultId');
  expect(camelCase('title')).toBe('title');

  const full = taskProjection(true);
  expect(full).toContain('t.description');
  expect(full).not.toContain('substr(');

  const preview = taskProjection(false, 'x.');
  expect(preview).toContain('substr(x.description,1,240) AS description');
  expect(preview).toContain('x.id');
});

test('taskMessage maps TaskRow fields, dependencies, dependents, completion timestamps, and planning view', () => {
  const row: TaskRow = {
    id: 'task-1',
    title: 'Prepare launch checklist',
    description: 'x'.repeat(260),
    project_id: 'proj-1',
    section_id: 'sec-1',
    parent_id: 'parent-1',
    label_ids: '["lbl-1"]',
    priority: 2,
    sort_order: 5,
    due_date: '2030-04-15',
    due_datetime: '',
    due_timezone: '',
    deadline: '2030-04-16',
    duration_minutes: 45,
    recurrence: '',
    kind: 'task',
    effort: 'deep',
    stage: 'ready',
    committed_week: '2030-W16',
    area: 'work',
    lead_days: 3,
    planning_flags: '["frog"]',
    key_result_id: 'kr-1',
    effective_key_result_id: 'kr-1',
    key_result_title: 'Ship v1',
    completed: 1,
    completed_at: 1_900_000_000_000,
    project_archived: 1,
    parent_title: 'Parent task',
    completed_count: 2,
    child_count: 3,
    completed_child_count: 1,
    dependencies: JSON.stringify([{ prerequisite_id: 'pre-1', title: 'Prerequisite', done: 1 }]),
    dependents: JSON.stringify([{ task_id: 'dep-1', title: 'Dependent' }]),
    revision: 7,
    created_at: 1_800_000_000_000,
    updated_at: 1_850_000_000_000,
    deleted_at: null,
  };

  const message = taskMessage(row, '2030-04-15');
  expect(message.name).toBe('tasks/task-1');
  expect(message.etag).toBe('7');
  expect(message.descriptionPreview).toHaveLength(240);
  expect(message.completed).toBe(true);
  expect(message.archived).toBe(true);
  expect(message.completeTime).toBeDefined();
  expect(message.dependencies).toHaveLength(1);
  expect(message.dependencies[0]?.prerequisiteId).toBe('pre-1');
  expect(message.dependencies[0]?.done).toBe(true);
  expect(message.dependents).toHaveLength(1);
  expect(message.dependents[0]?.taskId).toBe('dep-1');
});

test('catalogMessage maps projects, sections, labels, and saved filters', () => {
  const baseRow: CatalogRow = {
    id: 'item-1',
    title: 'Catalog item',
    revision: 3,
    created_at: 1000,
    updated_at: 2000,
    deleted_at: null,
    sort_order: 4,
    color: '#4073ff',
    favorite: 1,
    archived: 1,
    inbox: 1,
    parent_id: 'parent-proj',
    project_id: 'proj-1',
    query: 'today | overdue',
  };

  const project = catalogMessage('projects', baseRow);
  expect(project.name).toBe('projects/item-1');
  expect(project.parentId).toBe('parent-proj');
  expect(project.favorite).toBe(true);
  expect(project.archived).toBe(true);
  expect(project.inbox).toBe(true);

  const section = catalogMessage('sections', baseRow);
  expect(section.name).toBe('sections/item-1');
  expect(section.projectId).toBe('proj-1');
  expect(section.archived).toBe(true);

  const label = catalogMessage('labels', baseRow);
  expect(label.name).toBe('labels/item-1');
  expect(label.color).toBe('#4073ff');
  expect(label.favorite).toBe(true);

  const filter = catalogMessage('filters', baseRow);
  expect(filter.name).toBe('filters/item-1');
  expect(filter.query).toBe('today | overdue');
  expect(filter.favorite).toBe(true);
});
