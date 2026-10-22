import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { registerTaskTools, type TaskToolEnv, type TaskWriteState } from './tasks.ts';
import { registerContentTools, type ContentToolEnv } from './content.ts';
import { SOURCE_NAMES } from './events.ts';
import { registerWorkTools } from './work-tools.ts';
import type { WorkStore } from './work-store.ts';
import { registerWatchTools, type WatchToolEnv } from './watch.ts';

export const TEST_EVENT_NAME = 'personal_cloud.test';
export const TEST_EVENT_MESSAGE = 'Personal MCP connection test';
export const WORK_EVENT_NAME = 'work.attention';
export const EVENT_NAMES = [TEST_EVENT_NAME, ...SOURCE_NAMES, WORK_EVENT_NAME] as const;
export type EventName = typeof EVENT_NAMES[number];

const noArguments = z.strictObject({});
const eventArguments = z.strictObject({ work_id: z.uuid().optional() });
const callbackUrl = z.url({ protocol: /^https$/ });
const signingSecret = z.string().max(94).regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/).refine((value) => {
  try {
    const length = atob(value.slice('whsec_'.length)).length;
    return length >= 24 && length <= 64;
  } catch {
    return false;
  }
}, 'Signing secret must contain a base64-encoded key of 24 to 64 bytes.');

const subscribeParamsSchema = z.object({
  name: z.enum(EVENT_NAMES),
  arguments: eventArguments.default({}),
  delivery: z.object({
    mode: z.literal('webhook'),
    url: callbackUrl,
    secret: signingSecret,
  }),
  cursor: z.string().nullable().optional(),
  ttlMs: z.number().int().positive().nullable().optional(),
}).refine(params => params.name === WORK_EVENT_NAME || !params.arguments.work_id, 'Only work.attention accepts work_id.');

const subscribeResultSchema = z.object({
  id: z.string().min(1),
  refreshBefore: z.iso.datetime({ offset: true }).nullable(),
  cursor: z.null(),
  truncated: z.boolean(),
});

const unsubscribeParamsSchema = z.object({
  name: z.enum(EVENT_NAMES),
  arguments: eventArguments.default({}),
  delivery: z.object({
    mode: z.literal('webhook'),
    url: callbackUrl,
  }),
}).refine(params => params.name === WORK_EVENT_NAME || !params.arguments.work_id, 'Only work.attention accepts work_id.');

export type SubscribeParams = z.infer<typeof subscribeParamsSchema>;
export type SubscribeResult = z.infer<typeof subscribeResultSchema>;
export type UnsubscribeParams = z.infer<typeof unsubscribeParamsSchema>;

export interface GateApi extends TaskWriteState {
  readonly work: WorkStore;
  refreshWorkSources(): Promise<Record<string, unknown>>;
  initializeWorkSources(): Promise<void>;
  subscribe(params: SubscribeParams): Promise<SubscribeResult>;
  unsubscribe(params: UnsubscribeParams): Promise<Record<string, never>>;
  status(): Promise<unknown>;
  emitTest(requestId: string): Promise<unknown>;
}

export function createServer(api: GateApi, buildSha: string, env: TaskToolEnv & ContentToolEnv & WatchToolEnv): McpServer {
  const capabilities = { tools: {}, events: {} };
  const server = new McpServer({ name: 'personal-cloud', version: '0.1.0' }, { capabilities });

  server.server.setRequestHandler('events/list', { params: z.object({ cursor: z.string().optional() }) }, () => ({
    events: [{
      name: TEST_EVENT_NAME,
      description: 'A synthetic event sent by send_test_event to verify this MCP connection.',
      delivery: ['webhook'],
      inputSchema: z.toJSONSchema(noArguments),
      payloadSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', const: TEST_EVENT_MESSAGE },
          build_sha: { type: 'string' },
        },
        required: ['message', 'build_sha'],
        additionalProperties: false,
      },
    }, ...SOURCE_NAMES.map(name => ({ name, delivery: ['webhook'], inputSchema: z.toJSONSchema(noArguments),
      description: {
        'task.changed': 'A bounded batch of new task revisions; confirmed MCP writes of the same revision are omitted.',
        'task.must_start': 'Tasks entering the native Must start window, including date-driven transitions.',
        'mail.ready': 'A new Mail summary is ready. This event does not create an Inbox task.',
        'service.attention': 'A new undismissed Home issue; MCP’s own issues are omitted to prevent notification loops.',
      }[name],
      payloadSchema: z.toJSONSchema({
        'task.changed': z.strictObject({ changes: z.array(z.strictObject({ id: z.string(), etag: z.string(), deleted: z.boolean() })).max(100) }),
        'task.must_start': z.strictObject({ task_ids: z.array(z.string()).max(2000) }),
        'mail.ready': z.strictObject({ event_id: z.string(), ready_time: z.string() }),
        'service.attention': z.strictObject({ occurrence_seq: z.number().int(), source: z.string(), code: z.string() }),
      }[name]),
    })), {
      name: WORK_EVENT_NAME, delivery: ['webhook'], inputSchema: z.toJSONSchema(eventArguments),
      description: 'An unhandled report from a linked work source. Optional work_id selects one work; omitted follows all open work. Read work_get, handle the report, then checkpoint the handled sequence. Checkpoints never trigger this event.',
      payloadSchema: z.toJSONSchema(z.strictObject({ work_id: z.uuid(), report_seq: z.number().int(),
        kind: z.enum(['progress', 'question', 'blocked', 'result']),
        source: z.strictObject({ type: z.string(), ref: z.string() }) })),
    }],
  }));
  server.server.setRequestHandler('events/subscribe', {
    params: subscribeParamsSchema,
    result: subscribeResultSchema,
  }, (params) => api.subscribe(params));
  server.server.setRequestHandler('events/unsubscribe', {
    params: unsubscribeParamsSchema,
    result: noArguments,
  }, (params) => api.unsubscribe(params));

  server.registerTool('connection_status', {
    title: 'Connection status',
    description: 'Read the build, subscription source checks and event delivery status for this personal MCP connection.',
    inputSchema: noArguments,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const result = { build_sha: buildSha, status: await api.status() };
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.registerTool('send_test_event', {
    title: 'Send test event',
    description: 'Send one synthetic personal_cloud.test event to active subscriptions. Reuse request_id when retrying the same request.',
    inputSchema: z.strictObject({ request_id: z.uuid() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ request_id }) => {
    const result = { result: await api.emitTest(request_id) };
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  registerTaskTools(server, env, api);
  registerContentTools(server, env);
  registerWorkTools(server, api.work, () => api.refreshWorkSources(), () => api.initializeWorkSources());
  registerWatchTools(server, env, api.work, () => api.initializeWorkSources());
  return server;
}
