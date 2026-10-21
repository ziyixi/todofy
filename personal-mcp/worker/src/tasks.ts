import { ProtocolError, type CallToolResult, type McpServer } from '@modelcontextprotocol/server';
import { createHttpClient, RpcStatusError } from '@ziyixi/proto/http-client';
import { FocusTimerSchema } from '@ziyixi/proto/tasks/ui/v1/focus_pb';
import { PlanSchema } from '@ziyixi/proto/tasks/ui/v1/plan_pb';
import { TaskSchema, type Task } from '@ziyixi/proto/tasks/ui/v1/task_pb';
import {
  CatalogSchema,
  ListFocusDaysResponseSchema,
  ListTasksResponseSchema,
  MoveFocusStepResponseSchema,
  TasksUiService,
} from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { z } from 'zod';

export interface TaskToolEnv { TASKS: Fetcher }

/** The DO freezes Step identities before writing and remembers confirmed task revisions. */
export interface TaskWriteState {
  planSteps(requestId: string, input: string, count: number): Promise<readonly { taskId: string; requestId: string }[]>;
  rememberTask(id: string, etag: string): Promise<void>;
}

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const optionalId = z.union([id, z.literal('')]).optional();
const requestId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const etag = z.string().min(1).max(64);
const day = z.iso.date();
const optionalDay = z.union([day, z.literal('')]).optional();
const pageSize = z.number().int().min(1).max(100).default(50);
const pageToken = z.string().max(4096).default('');
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { ...readOnly, readOnlyHint: false };
const flags = z.array(z.enum(['quick', 'waiting', 'parked', 'active', 'onhold', 'routine', 'task'])).max(7);

/** Generated routes and wire JSON remain the only Tasks transport contract. */
export function createTasksClient(env: TaskToolEnv) {
  return createHttpClient(TasksUiService, call => env.TASKS.fetch(new Request(`https://tasks.internal${call.url}`, {
    method: call.httpMethod,
    ...(call.body === undefined ? {} : { body: call.body, headers: { 'content-type': 'application/json' } }),
  })));
}

async function answer(action: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    const result = await action();
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    const result = { error: error instanceof RpcStatusError
      ? { code: error.status.reason ?? error.status.status ?? 'TASKS_REQUEST_FAILED', message: error.status.message }
      : { code: 'TASKS_REQUEST_UNCONFIRMED', message: 'Could not confirm the Tasks request. Retry a write with the same request_id and input.' } };
    return { isError: true, structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
}

const changesSchema = z.strictObject({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(16000).optional(),
  project_id: optionalId,
  section_id: optionalId,
  parent_id: optionalId,
  label_ids: z.array(id).max(30).optional(),
  priority: z.number().int().min(1).max(4).optional(),
  due_date: optionalDay,
  due_datetime: z.string().max(100).optional(),
  due_timezone: z.string().max(100).optional(),
  deadline: optionalDay,
  duration_minutes: z.number().int().min(0).max(10080).optional(),
  recurrence: z.string().max(1000).optional(),
  effort: z.enum(['', 'deep', 'shallow']).optional(),
  stage: z.enum(['none', 'quarterly', 'monthly', 'weekly', 'committed']).optional(),
  area: z.enum(['unassigned', 'work', 'personal']).optional(),
  lead_days: z.number().int().min(0).max(365).optional(),
  planning_flags: flags.optional(),
  dependencies: z.array(z.strictObject({ prerequisite_id: id })).max(5).optional(),
}).refine(changes => Object.keys(changes).length > 0, 'Supply at least one field to change.');

/** Each tool names an owner action; none accepts an arbitrary RPC or changes planning implicitly. */
export function registerTaskTools(server: McpServer, env: TaskToolEnv, writes: TaskWriteState): void {
  const tasks = createTasksClient(env);
  async function saved(task: Task) {
    await writes.rememberTask(task.id, task.etag);
    return { task: toWire(TaskSchema, task) };
  }

  server.registerTool('tasks_list', {
    title: 'List tasks',
    description: 'Read one bounded task page. Native fields include labels, planning facts and dependencies. Follow next_page_token with identical selectors. Ordinary views omit Steps; all and parent_id include them. Catalog resolves project, section and label names.',
    inputSchema: z.strictObject({
      view: z.enum(['inbox', 'today', 'upcoming', 'project', 'label', 'filter', 'search', 'all', 'completed']).default('inbox'),
      project_id: optionalId,
      parent_id: optionalId,
      label_id: optionalId,
      filter_id: optionalId,
      query: z.string().max(1000).default(''),
      date: optionalDay,
      page_size: pageSize,
      page_token: pageToken,
      include_completed: z.boolean().default(false),
      include_catalog: z.boolean().default(false),
    }).refine(input => input.view === 'filter' || input.query.length <= 200, 'Search is at most 200 characters.'),
    annotations: readOnly,
  }, input => answer(async () => {
    const [page, catalog] = await Promise.all([
      tasks.listTasks({ view: input.view, projectId: input.project_id ?? '', parentId: input.parent_id ?? '',
        labelId: input.label_id ?? '', filterId: input.filter_id ?? '', query: input.query, date: input.date ?? '',
        pageSize: input.page_size, pageToken: input.page_token, includeCompleted: input.include_completed }),
      input.include_catalog ? tasks.getCatalog({ name: 'catalog', includeTaskCounts: false }) : undefined,
    ]);
    return { ...toWire(ListTasksResponseSchema, page), ...(catalog ? { catalog: toWire(CatalogSchema, catalog) } : {}) };
  }));

  server.registerTool('tasks_get', {
    title: 'Read task details',
    description: 'Read a full task, including its etag, dependencies and native planning facts. Optionally read one page of its direct Subtasks and Steps, including completed children. Follow children.next_page_token for the rest. Catalog contains label and project names.',
    inputSchema: z.strictObject({ task_id: id, include_children: z.boolean().default(true),
      child_page_size: pageSize, child_page_token: pageToken, include_catalog: z.boolean().default(true) }),
    annotations: readOnly,
  }, input => answer(async () => {
    const [task, catalog] = await Promise.all([
      tasks.getTask({ name: `tasks/${input.task_id}` }),
      input.include_catalog ? tasks.getCatalog({ name: 'catalog', includeTaskCounts: false }) : undefined,
    ]);
    const children = input.include_children && task.childCount > 0
      ? await tasks.listTasks({ parentId: task.id, pageSize: input.child_page_size, pageToken: input.child_page_token }) : undefined;
    return { task: toWire(TaskSchema, task), ...(children ? { children: toWire(ListTasksResponseSchema, children) } : {}),
      ...(catalog ? { catalog: toWire(CatalogSchema, catalog) } : {}) };
  }));

  server.registerTool('tasks_create_inbox', {
    title: 'Create Inbox task',
    description: 'Create an Inbox task only when the owner explicitly requests it. Dates and labels are optional explicit choices. Reuse the same request_id and input after an uncertain response.',
    inputSchema: z.strictObject({ request_id: requestId, title: z.string().min(1).max(500),
      description: z.string().max(16000).default(''), label_ids: z.array(id).max(30).default([]),
      priority: z.number().int().min(1).max(4).default(4), due_date: optionalDay, deadline: optionalDay }),
    annotations: write,
  }, input => answer(async () => saved(await tasks.createTask({
    taskId: input.request_id, requestId: input.request_id,
    task: { title: input.title, description: input.description, labelIds: input.label_ids, priority: input.priority,
      dueDate: input.due_date ?? '', deadline: input.deadline ?? '' },
  }))));

  server.registerTool('tasks_add_steps', {
    title: 'Add task Steps',
    description: 'Add 1–8 executable Steps beneath an existing Task/Subtask on explicit owner request. Estimates default to 30 minutes. This does not schedule, commit or complete them. Reuse request_id and identical input after a partial or uncertain response.',
    inputSchema: z.strictObject({ request_id: requestId, task_id: id,
      steps: z.array(z.strictObject({ title: z.string().min(1).max(500),
        estimated_minutes: z.number().int().min(0).max(10080).default(30) })).min(1).max(8) }),
    annotations: write,
  }, input => answer(async () => {
    const identities = await writes.planSteps(input.request_id,
      JSON.stringify({ task_id: input.task_id, steps: input.steps }), input.steps.length);
    const created = [];
    for (const [index, step] of input.steps.entries()) {
      const identity = identities[index];
      if (!identity) throw new Error('Missing persisted Step identity');
      const task = await tasks.createTask({ ...identity,
        task: { title: step.title, parentId: input.task_id, kind: 'step', durationMinutes: step.estimated_minutes } });
      await writes.rememberTask(task.id, task.etag);
      created.push(toWire(TaskSchema, task));
    }
    return { tasks: created };
  }));

  server.registerTool('tasks_update', {
    title: 'Update task',
    description: 'Change only explicitly supplied task fields after an owner request. Use the task’s current etag. Empty text or arrays clear supported fields; omitted fields stay unchanged. A stale etag requires reading again and reviewing the requested change. Reuse request_id and input only for an exact retry.',
    inputSchema: z.strictObject({ request_id: requestId, task_id: id, etag, changes: changesSchema }),
    annotations: write,
  }, input => answer(async () => saved(await tasks.updateTask({ requestId: input.request_id, etag: input.etag,
    task: fromWire(TaskSchema, { name: `tasks/${input.task_id}`, ...input.changes }, { strict: true }).message,
    updateMask: { paths: Object.keys(input.changes) },
  }))));

  server.registerTool('tasks_complete', {
    title: 'Complete task',
    description: 'Complete a task only on explicit owner instruction, using its current etag. Tasks completes its open children, advances recurrence when present and settles related Focus time. focus_day optionally names the queue day; omission uses Tasks’ today. Reuse request_id and identical input for retries.',
    inputSchema: z.strictObject({ request_id: requestId, task_id: id, etag, focus_day: optionalDay }),
    annotations: { ...write, destructiveHint: true },
  }, input => answer(async () => saved(await tasks.completeTask({ name: `tasks/${input.task_id}`, etag: input.etag,
    requestId: input.request_id, focusDay: input.focus_day ?? '' }))));

  server.registerTool('tasks_delete', {
    title: 'Soft-delete task',
    description: 'Soft-delete a task and its descendants only on explicit owner instruction. Use the current etag. Reuse request_id and identical input for an exact retry.',
    inputSchema: z.strictObject({ request_id: requestId, task_id: id, etag }),
    annotations: { ...write, destructiveHint: true },
  }, input => answer(async () => {
    await tasks.deleteTask({ name: `tasks/${input.task_id}`, etag: input.etag, requestId: input.request_id });
    return { deleted_task_id: input.task_id };
  }));

  server.registerTool('plan_get', {
    title: 'Read Plan',
    description: 'Read weekly goals, saved lane orders, next-week commitment IDs, one page of active task planning facts and daily queues. Native stage/board_stage/must_start are Tasks’ facts. Follow task_page.next_page_token for more tasks. This answer does not derive the complete UI candidate lanes. Omitting both day fields reads the current week.',
    inputSchema: z.strictObject({ page_size: pageSize, page_token: pageToken, start_day: optionalDay, end_day: optionalDay }),
    annotations: readOnly,
  }, input => answer(async () => {
    const [plan, taskPage, days] = await Promise.all([
      tasks.getPlan({ name: 'plan' }),
      tasks.listTasks({ view: 'all', pageSize: input.page_size, pageToken: input.page_token }),
      tasks.listFocusDays({ startDay: input.start_day ?? '', endDay: input.end_day ?? '' }),
    ]);
    return { plan: toWire(PlanSchema, plan), task_page: toWire(ListTasksResponseSchema, taskPage),
      focus_days: toWire(ListFocusDaysResponseSchema, days) };
  }));

  server.registerTool('plan_arrange', {
    title: 'Arrange daily queue',
    description: 'Explicitly add, move, remove or reorder one executable Step, Standalone action or Quick task in daily queues. No source adds; no destination removes; equal days reorder. before_task_id inserts before an item, otherwise appends. Preserves task dates and deadlines. Each day holds at most 20 items. Reuse request_id and input for retries.',
    inputSchema: z.strictObject({ request_id: requestId, task_id: id, source_day: optionalDay,
      destination_day: optionalDay, before_task_id: optionalId })
      .refine(input => Boolean(input.source_day || input.destination_day), 'Name a source or destination day.'),
    annotations: write,
  }, input => answer(async () => {
    const result = await tasks.moveFocusStep({ requestId: input.request_id, taskId: input.task_id,
      sourceDay: input.source_day ?? '', destinationDay: input.destination_day ?? '', beforeTaskId: input.before_task_id ?? '' });
    return toWire(MoveFocusStepResponseSchema, result);
  }));

  server.registerTool('focus_get', {
    title: 'Read Focus',
    description: 'Read 1–7 days of queues and time records plus the current Focus timer. Omitting both day fields reads the current week. Timer access is read-only.',
    inputSchema: z.strictObject({ start_day: optionalDay, end_day: optionalDay }),
    annotations: readOnly,
  }, input => answer(async () => {
    const [days, timer] = await Promise.all([
      tasks.listFocusDays({ startDay: input.start_day ?? '', endDay: input.end_day ?? '' }),
      tasks.getFocusTimer({ name: 'focusTimer' }),
    ]);
    return { focus_days: toWire(ListFocusDaysResponseSchema, days), timer: toWire(FocusTimerSchema, timer) };
  }));
}
