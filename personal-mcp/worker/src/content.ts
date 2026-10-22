/**
 * Explicit Mail, Recall and cached Home tools. Scheduling and subscription cursors belong to the MCP store. Mail is read
 * on Todofy's Mail entry (todofy.mail.v1, a read-only binding); Tasks converts it and keeps its category shortcuts.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { ReadHomeRequestSchema, ReadHomeResponseSchema } from '@ziyixi/proto/dashboard/mcp/v1/home_service_pb';
import type { HomeService, ReadHomeResponse } from '@ziyixi/proto/dashboard/mcp/v1/home_service_wire';
import { createHttpClient, RpcStatusError } from '@ziyixi/proto/http-client';
import { MailCategoriesSchema } from '@ziyixi/proto/tasks/ui/v1/mail_pb';
import { TaskSchema } from '@ziyixi/proto/tasks/ui/v1/task_pb';
import { ListMailItemsResponseSchema, MailItemSchema, MailService } from '@ziyixi/proto/todofy/mail/v1/mail_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { z } from 'zod';
import { createTasksClient } from './tasks.ts';
import { answer, bindingTransport } from './source-tools.ts';
import { registerRecallTools } from './recall.ts';
export { createRecallClient } from './recall.ts';

export interface ContentToolEnv {
  /** Todofy's Mail entry, `props.access = "read"`. */
  TODOFY_MAIL: Fetcher;
  /** Tasks' generic API: Mail conversion and the category shortcuts. */
  TASKS: Fetcher;
  RECALL: Fetcher;
  HOME: HomeService;
}

const mailId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).refine(value => !value.startsWith('tmp-'), 'Use the saved Mail ID.');
const etag = z.string().min(1).max(64);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Todofy's Mail entry: the list, one mail with its summary, and the readiness feed. */
export function createMailClient(env: Pick<ContentToolEnv, 'TODOFY_MAIL'>) {
  return createHttpClient(MailService, bindingTransport(env.TODOFY_MAIL, 'https://mail.internal'));
}

/** Validates both sides of Home's generated private binding, without refreshing or controlling a source. */
export async function readHomeSnapshot(env: Pick<ContentToolEnv, 'HOME'>, afterOccurrenceSeq = 0): Promise<ReadHomeResponse> {
  const request = toWire(ReadHomeRequestSchema, fromWire(ReadHomeRequestSchema, {
    after_occurrence_seq: afterOccurrenceSeq,
  }, { strict: true }).message);
  const response = await env.HOME.readHome(request);
  return toWire(ReadHomeResponseSchema, fromWire(ReadHomeResponseSchema, response).message);
}

export function registerContentTools(server: McpServer, env: ContentToolEnv): void {
  const mail = createMailClient(env);
  const tasks = createTasksClient(env);
  registerRecallTools(server, env);

  server.registerTool('mail_list', {
    title: 'List pending Mail',
    description: 'Read one page of summarized mail awaiting an owner decision, with briefs, current etags and optional category shortcuts. Reading never creates tasks. Follow next_page_token for more.',
    inputSchema: z.strictObject({ page_size: z.number().int().min(1).max(50).default(25),
      page_token: z.string().max(256).default('') }),
    annotations: readOnly,
  }, input => answer('MAIL', async () => {
    const [page, categories] = await Promise.all([
      mail.listMailItems({ pageSize: input.page_size, pageToken: input.page_token }),
      tasks.getMailCategories({ name: 'mailCategories' }),
    ]);
    const shortcuts = toWire(MailCategoriesSchema, categories);
    return { ...toWire(ListMailItemsResponseSchema, page), mail_items: page.mailItems.map(item => toWire(MailItemSchema, item)),
      categories: shortcuts['categories'] ?? [], categories_etag: categories.etag };
  }));

  server.registerTool('mail_read', {
    title: 'Read Mail summary',
    description: 'Read one saved plain-text Mail summary. available=false means the summary is absent; it may have been deleted. Reading never creates a task.',
    inputSchema: z.strictObject({ event_id: mailId }),
    annotations: readOnly,
  }, input => answer('MAIL', async () => {
    try {
      const item = await mail.getMailItem({ name: `mailItems/${input.event_id}` });
      return { event_id: input.event_id, summary: item.summary, available: item.summary.length > 0 };
    } catch (error) {
      // Its summary was deleted, or it never was: absent, as before.
      if (error instanceof RpcStatusError && error.status.reason === 'NOT_FOUND') return { event_id: input.event_id, summary: '', available: false };
      throw error;
    }
  }));

  server.registerTool('mail_collect', {
    title: 'Collect Mail into Tasks Inbox',
    description: 'Create an Inbox task from a pending Mail summary only on explicit owner instruction. Use the current mail etag. A chosen category adds its label and priority. The pending entry is consumed; its summary stays readable. For an exact retry, reuse request_id, etag and all input fields.',
    inputSchema: z.strictObject({ event_id: mailId, etag, request_id: z.uuidv4(),
      category_id: z.string().regex(/^[1-9][0-9]{0,18}$/).optional(), categories_etag: etag.optional(),
    }).refine(input => Boolean(input.category_id) === Boolean(input.categories_etag), 'Supply category_id and categories_etag together.'),
    annotations: { ...readOnly, readOnlyHint: false },
  }, input => answer('MAIL', async () => {
    const task = await tasks.convertMailItem({ eventId: input.event_id, etag: input.etag, requestId: input.request_id,
      categoryId: input.category_id ?? '', categoriesEtag: input.categories_etag ?? '' });
    return { event_id: input.event_id, task: toWire(TaskSchema, task) };
  }, true));

  server.registerTool('cloud_status', {
    title: 'Read current cloud status',
    description: 'Read Home’s cached service states, freshness and current undismissed attention. This does not refresh providers, run a canary, dismiss attention or change a guard. Check source timestamps before treating the state as current.',
    inputSchema: z.strictObject({}),
    annotations: readOnly,
  }, () => answer('HOME', async () => ({ ...await readHomeSnapshot(env) })));
}
