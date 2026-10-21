import { createMcpHandler, McpServer, ProtocolError, type CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, expect, it } from 'vitest';
import { registerTaskTools, type TaskToolEnv, type TaskWriteState } from '../src/tasks.ts';

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const handlers: ReturnType<typeof createMcpHandler>[] = [];
afterEach(async () => { await Promise.all(handlers.splice(0).map(handler => handler.close())); });

interface NativeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
}

function writeState(): TaskWriteState & { remembered: Map<string, string> } {
  const planned = new Map<string, { input: string; ids: { taskId: string; requestId: string }[] }>();
  const remembered = new Map<string, string>();
  return {
    remembered,
    planSteps(requestId, input, count) {
      const previous = planned.get(requestId);
      if (previous && previous.input !== input) throw new ProtocolError(-32602, 'Request ID already used for different Steps.');
      if (previous) return Promise.resolve(previous.ids);
      const ids = Array.from({ length: count }, (_, index) => ({
        taskId: `step-${String(index)}`,
        requestId: `00000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`,
      }));
      planned.set(requestId, { input, ids });
      return Promise.resolve(ids);
    },
    rememberTask(id, etag) { remembered.set(id, etag); return Promise.resolve(); },
  };
}

function tools(backend: (request: NativeRequest) => Response | Promise<Response>, writes = writeState()) {
  const seen: NativeRequest[] = [];
  const env = { TASKS: { async fetch(request: Request) {
    const url = new URL(request.url);
    const body = request.method === 'GET' ? {} : await request.json<Record<string, unknown>>();
    const call = { method: request.method, path: url.pathname, query: url.searchParams, body };
    seen.push(call);
    return backend(call);
  } } as unknown as Fetcher } satisfies TaskToolEnv;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'synthetic-tasks', version: '1.0.0' }, { capabilities: { tools: {} } });
    registerTaskTools(server, env, writes);
    return server;
  }, { legacy: 'reject' });
  handlers.push(handler);
  return {
    seen,
    writes,
    async call(name: string, args: Record<string, unknown>) {
      const response = await handler.fetch(new Request('https://mcp.example.org/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': name },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args,
          _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'synthetic', version: '1' } } } }),
      }));
      return response.json<{ result?: CallToolResult; error?: { code: number; message: string } }>();
    },
  };
}

function task(id = 'task-1', extra: Record<string, unknown> = {}) {
  return { name: `tasks/${id}`, id, title: 'Synthetic outcome', etag: '3', kind: 'task',
    update_time: '2026-10-20T12:00:00Z', ...extra };
}

it('keeps pagination and selectors and resolves catalog names without sidebar counts', async () => {
  const client = tools(request => Response.json(request.path.endsWith('/catalog')
    ? { name: 'catalog', labels: [{ name: 'labels/label-1', id: 'label-1', title: 'Synthetic label' }] }
    : { tasks: [task('task-1', { label_ids: ['label-1'], must_start: true })], next_page_token: 'cursor-next' }));
  const result = await client.call('tasks_list', { view: 'label', label_id: 'label-1', page_size: 7,
    page_token: 'cursor-before', include_catalog: true });
  expect(result.result?.structuredContent).toMatchObject({ tasks: [{ id: 'task-1', label_ids: ['label-1'], must_start: true }],
    next_page_token: 'cursor-next', catalog: { labels: [{ title: 'Synthetic label' }] } });
  const page = client.seen.find(request => request.path.endsWith('/tasks'));
  expect(Object.fromEntries(page?.query ?? [])).toMatchObject({ view: 'label', label_id: 'label-1', page_size: '7',
    page_token: 'cursor-before' });
  expect(page?.query.has('include_completed')).toBe(false);
  expect(page?.query.has('include_description')).toBe(false);
  const catalog = client.seen.find(request => request.path.endsWith('/catalog'));
  expect(catalog?.query.get('include_task_counts')).toBe('false');
});

it('returns full details and a bounded child page with Steps, Subtasks and dependencies', async () => {
  const client = tools(request => Response.json(request.path.endsWith('/tasks/task-1')
    ? task('task-1', { child_count: 2, description: 'Full synthetic description',
      dependencies: [{ prerequisite_id: 'prerequisite', title: 'Synthetic prerequisite', done: false }] })
    : { tasks: [task('child-1', { kind: 'step', parent_id: 'task-1' }), task('child-2', { completed: true })],
      next_page_token: 'children-next' }));
  const result = await client.call('tasks_get', { task_id: 'task-1', include_catalog: false, child_page_size: 2 });
  expect(result.result?.structuredContent).toMatchObject({ task: { description: 'Full synthetic description',
    dependencies: [{ prerequisite_id: 'prerequisite' }] }, children: { tasks: [{ kind: 'step' }, { completed: true }],
    next_page_token: 'children-next' } });
  expect(client.seen.find(request => request.path.endsWith('/tasks'))?.query.get('parent_id')).toBe('task-1');
});

it('uses native create identities and defaults while retaining explicit dates', async () => {
  const client = tools(request => Response.json(task(String(request.query.get('task_id')), request.body)));
  const result = await client.call('tasks_create_inbox', { request_id: REQUEST_ID, title: 'Synthetic Inbox task',
    deadline: '2026-10-28' });
  expect(result.result?.isError).not.toBe(true);
  expect(result.result?.structuredContent).toMatchObject({ task: { id: REQUEST_ID, title: 'Synthetic Inbox task',
    deadline: '2026-10-28', priority: 4 } });
  expect(client.seen[0]?.body).not.toHaveProperty('project_id');
  expect(client.seen[0]?.body).not.toHaveProperty('parent_id');
  expect(client.seen[0]?.body).not.toHaveProperty('due_date');
  expect(client.seen[0]?.query.get('request_id')).toBe(REQUEST_ID);
  expect(client.writes.remembered.get(REQUEST_ID)).toBe('3');
});

it('keeps persisted Step identities across an uncertain response and a new MCP server', async () => {
  const writes = writeState();
  const created = new Map<string, Record<string, unknown>>();
  const receipts = new Map<string, Record<string, unknown>>();
  let loseReply = true;
  const backend = (request: NativeRequest) => {
    const taskId = request.query.get('task_id') ?? '';
    const requestId = request.query.get('request_id') ?? '';
    const previous = receipts.get(requestId);
    if (previous) return Response.json(previous);
    const saved = task(taskId, { ...request.body, parent_id: 'parent' });
    created.set(taskId, saved);
    receipts.set(requestId, saved);
    if (taskId === 'step-1' && loseReply) { loseReply = false; throw new Error('Synthetic lost response'); }
    return Response.json(saved);
  };
  const input = { request_id: REQUEST_ID, task_id: 'parent', steps: [{ title: 'Read synthetic draft' },
    { title: 'Review synthetic draft', estimated_minutes: 20 }] };
  const first = tools(backend, writes);
  expect((await first.call('tasks_add_steps', input)).result?.isError).toBe(true);
  const restarted = tools(backend, writes);
  const retried = await restarted.call('tasks_add_steps', input);
  expect(retried.result?.structuredContent).toMatchObject({ tasks: [
    { id: 'step-0', kind: 'step', duration_minutes: 30 }, { id: 'step-1', duration_minutes: 20 },
  ] });
  expect([...created.keys()]).toEqual(['step-0', 'step-1']);
  expect([...writes.remembered.keys()]).toEqual(['step-0', 'step-1']);
  const conflict = await restarted.call('tasks_add_steps', { ...input, steps: [{ title: 'Different input' }] });
  expect(conflict.result?.isError).toBe(true);
  expect(JSON.stringify(conflict.result?.content)).toContain('different Steps');
});

it('forwards narrow clear operations and exposes stale etags without retrying a changed write', async () => {
  const client = tools(() => Response.json({ error: { code: 409, status: 'ABORTED', message: 'Refresh before editing.',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ETAG_MISMATCH', domain: 'tasks.ziyixi.science' }] } }, { status: 409 }));
  const result = await client.call('tasks_update', { request_id: REQUEST_ID, task_id: 'task-1', etag: '2',
    changes: { description: '', deadline: '', label_ids: [] } });
  expect(result.result).toMatchObject({ isError: true, structuredContent: { error: { code: 'ETAG_MISMATCH' } } });
  const sent = client.seen[0];
  expect(sent?.method).toBe('PATCH');
  // The wire profile omits default values; the explicit mask makes these three fields clear.
  expect(sent?.body).toEqual({});
  expect(sent?.query.get('etag')).toBe('2');
  expect(sent?.query.get('update_mask')?.split(',').sort()).toEqual(['deadline', 'description', 'label_ids']);
  expect(client.writes.remembered.size).toBe(0);
});

it('uses native completion with the owner-selected Focus day and remembers its result', async () => {
  const client = tools(request => {
    expect(request.path).toBe('/api/tasks/v1/tasks/task-1:complete');
    expect(request.body).toMatchObject({ etag: '3', request_id: REQUEST_ID, focus_day: '2026-10-20' });
    return Response.json(task('task-1', { etag: '4', completed: true }));
  });
  const result = await client.call('tasks_complete', { request_id: REQUEST_ID, task_id: 'task-1', etag: '3',
    focus_day: '2026-10-20' });
  expect(result.result?.structuredContent).toMatchObject({ task: { completed: true, etag: '4' } });
  expect(client.writes.remembered.get('task-1')).toBe('4');
});

it('returns native Plan facts and page cursors without deriving candidate lanes', async () => {
  const client = tools(request => Response.json(request.path.endsWith('/plan')
    ? { name: 'plan', week_start: '2026-10-19', today: '2026-10-20', weekly_bets: [
      { name: 'weeklyBets/2026-10-19-work', week_start: '2026-10-19', area: 'work', text: 'Synthetic goal' }],
    lane_orders: [{ lane: 'committed', task_ids: ['task-1'] }] }
    : request.path.endsWith('/focusDays') ? { today: '2026-10-20', days: [{ day: '2026-10-20', task_ids: ['step'] }] }
      : { tasks: [task('task-1', { stage: 'committed', board_stage: 'committed' })], next_page_token: 'tasks-next' }));
  const result = await client.call('plan_get', {});
  expect(result.result?.structuredContent).toMatchObject({ plan: { weekly_bets: [{ text: 'Synthetic goal' }] },
    task_page: { tasks: [{ stage: 'committed' }], next_page_token: 'tasks-next' }, focus_days: { days: [{ task_ids: ['step'] }] } });
});

it('arranges queues through MoveFocusStep and sends no task date or deadline writes', async () => {
  const client = tools(() => Response.json({ days: [{ day: '2026-10-20', task_ids: ['step', 'before'] }] }));
  const result = await client.call('plan_arrange', { request_id: REQUEST_ID, task_id: 'step',
    source_day: '2026-10-19', destination_day: '2026-10-20', before_task_id: 'before' });
  expect(result.result?.structuredContent).toMatchObject({ days: [{ day: '2026-10-20', task_ids: ['step', 'before'] }] });
  expect(client.seen.filter(request => request.method !== 'GET')).toEqual([expect.objectContaining({
    path: '/api/tasks/v1/focusDays:moveStep', method: 'POST', body: { request_id: REQUEST_ID, task_id: 'step',
      source_day: '2026-10-19', destination_day: '2026-10-20', before_task_id: 'before' },
  })]);
  expect(client.seen.every(request => request.method === 'POST')).toBe(true);
  const outcome = tools(() => Response.json({ error: { code: 400, status: 'FAILED_PRECONDITION',
    message: 'Daily queues accept a Step, Standalone action or Quick task.',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'PRECONDITION_FAILED', domain: 'tasks.ziyixi.science' }] } }, { status: 400 }));
  const refusal = await outcome.call('plan_arrange', { request_id: REQUEST_ID, task_id: 'task-1',
    destination_day: '2026-10-20' });
  expect(refusal.result?.isError).toBe(true);
  expect(JSON.stringify(refusal.result?.content)).toContain('Standalone action');
  expect(outcome.seen.every(request => request.method === 'POST')).toBe(true);
});

it('reads the Focus timer without offering a timer mutation', async () => {
  const client = tools(request => Response.json(request.path.endsWith('/focusTimer')
    ? { name: 'focusTimer', state: 'running', task_id: 'step', day: '2026-10-20', etag: '2' }
    : { today: '2026-10-20', days: [{ day: '2026-10-20', task_ids: ['step'] }] }));
  const result = await client.call('focus_get', { start_day: '2026-10-20', end_day: '2026-10-20' });
  expect(result.result?.structuredContent).toMatchObject({ timer: { name: 'focusTimer', state: 'running', task_id: 'step' } });
  expect(client.seen.every(request => request.method === 'GET')).toBe(true);
});

it('rejects oversized lists and excessive Steps before reaching Tasks', async () => {
  const client = tools(() => { throw new Error('Unexpected native request'); });
  expect((await client.call('tasks_list', { page_size: 101 })).result?.isError).toBe(true);
  expect((await client.call('tasks_add_steps', { request_id: REQUEST_ID, task_id: 'parent',
    steps: Array.from({ length: 9 }, () => ({ title: 'Synthetic Step' })) })).result?.isError).toBe(true);
  expect(client.seen).toEqual([]);
});
