import { describe, expect, it } from 'vitest';
import { createHttpClient, RpcStatusError } from '@ziyixi/proto/http-client';
import { MailService } from '@ziyixi/proto/todofy/mail/v1/mail_service_pb';
import type { MailAnswer } from '../src/coordinator.ts';
import type { Env } from '../src/env.ts';
import { Mail as Exported } from '../src/index.ts';
import { Mail } from '../src/mail.ts';
import { fakes, hooks, owner, statusReason, type CoreReply } from './helpers.ts';

const EVENT = '00000000-0000-4000-8000-000000000001';
const ITEM = { name: `mailItems/${EVENT}`, id: EVENT, title: 'Synthetic subject', etag: 'e1', pending: true };

/** TodofyCore's answer of a message (its wire JSON text). */
function mailOk(message: unknown): MailAnswer {
  return { ok: JSON.stringify(message) };
}

function entry(env: Env, access?: unknown): Mail {
  return new Mail({ props: access === undefined ? {} : { access } } as ExecutionContext<{ access?: unknown }>, env);
}

function request(path: string, method = 'GET', body?: unknown): Request {
  return new Request(`https://mail.internal${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The generated MailService client over a binding of the entrypoint, as Tasks and the Personal MCP call it. */
function client(env: Env, access: unknown = 'read-write') {
  const mail = entry(env, access);
  return createHttpClient(MailService, (call) =>
    mail.fetch(request(call.url, call.httpMethod, call.body === undefined ? undefined : JSON.parse(call.body))),
  );
}

async function refusal(promise: Promise<unknown>): Promise<RpcStatusError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(RpcStatusError);
  return error as RpcStatusError;
}

describe('the Mail entrypoint (todofy.mail.v1)', () => {
  it('is exported by the Worker', () => {
    expect(Exported).toBe(Mail);
  });

  it('serves every MailService rpc as one core call with its request in wire JSON', async () => {
    const answers: Record<string, unknown> = {
      ListMailItems: { mail_items: [ITEM] },
      GetMailItem: { ...ITEM, summary: '合成摘要' },
      MarkMailConverted: { ...ITEM, task_id: 'task-1', pending: false },
      DeleteMailSummaries: { deleted_event_ids: [EVENT] },
      GetMailInbox: { name: 'mailInbox', pending_count: 3, carryover_count: 1 },
      PollMailReady: { cursor: '7' },
    };
    const { env, core } = fakes({}, (call) => mailOk(answers[String(call.args[0])]));
    const mail = client(env);
    expect((await mail.listMailItems({ pageSize: 10 })).mailItems.map((item) => item.id)).toEqual([EVENT]);
    expect((await mail.getMailItem({ name: `mailItems/${EVENT}` })).summary).toBe('合成摘要');
    const marked = await mail.markMailConverted({ name: `mailItems/${EVENT}`, etag: 'e1', taskId: 'task-1' });
    expect([marked.taskId, marked.pending]).toEqual(['task-1', false]);
    expect((await mail.deleteMailSummaries({ eventIds: [EVENT] })).deletedEventIds).toEqual([EVENT]);
    expect((await mail.getMailInbox({ name: 'mailInbox' })).pendingCount).toBe(3);
    expect((await mail.pollMailReady({ baseline: true })).cursor).toBe('7');
    expect(core.map((call) => [call.instance, call.method, call.args[0], JSON.parse(String(call.args[1])) as unknown])).toEqual([
      ['inbox-v1', 'mail', 'ListMailItems', { page_size: 10 }],
      ['inbox-v1', 'mail', 'GetMailItem', { name: `mailItems/${EVENT}` }],
      ['inbox-v1', 'mail', 'MarkMailConverted', { name: `mailItems/${EVENT}`, etag: 'e1', task_id: 'task-1' }],
      ['inbox-v1', 'mail', 'DeleteMailSummaries', { event_ids: [EVENT] }],
      ['inbox-v1', 'mail', 'GetMailInbox', { name: 'mailInbox' }],
      ['inbox-v1', 'mail', 'PollMailReady', { baseline: true }],
    ]);
  });

  it("sends the core's answer as it came", async () => {
    const text = JSON.stringify(ITEM);
    const { env } = fakes({}, () => ({ ok: text }));
    const response = await entry(env, 'read').fetch(request(`/api/mail/v1/mailItems/${EVENT}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(text);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('lets a read binding read and refuses its writes before the body is read', async () => {
    const { env, core } = fakes({}, () => mailOk({}));
    const mail = entry(env, 'read');
    expect((await mail.fetch(request('/api/mail/v1/mailItems'))).status).toBe(200);
    expect((await mail.fetch(request('/api/mail/v1/mailInbox'))).status).toBe(200);
    for (const path of [`/api/mail/v1/mailItems/${EVENT}:markConverted`, '/api/mail/v1/mailItems:deleteSummaries']) {
      const refused = await mail.fetch(new Request(`https://mail.internal${path}`, { method: 'POST', body: 'not json' }));
      expect(refused.status).toBe(403);
      expect(await statusReason(refused)).toBe('FORBIDDEN');
    }
    expect(core.map((call) => call.args[0])).toEqual(['ListMailItems', 'GetMailInbox']);
  });

  it.each([undefined, 'write', 'READ', true])('refuses everything to a binding granting %s', async (access) => {
    const { env, core } = fakes({}, () => mailOk({}));
    const response = await entry(env, access).fetch(request('/api/mail/v1/mailItems'));
    expect(response.status).toBe(403);
    expect(await statusReason(response)).toBe('FORBIDDEN');
    expect(core).toHaveLength(0);
  });

  it('holds the writes in maintenance and still answers the reads', async () => {
    const { env, core } = fakes({ MAINTENANCE_MODE: 'true' }, () => mailOk({ mail_items: [ITEM] }));
    const mail = client(env);
    expect((await mail.listMailItems({})).mailItems).toHaveLength(1);
    const held = await refusal(mail.deleteMailSummaries({ eventIds: [EVENT] }));
    expect([held.status.status, held.status.reason]).toEqual(['UNAVAILABLE', 'MAINTENANCE']);
    const response = await entry(env, 'read-write').fetch(request('/api/mail/v1/mailItems:deleteSummaries', 'POST', { event_ids: [EVENT] }));
    expect([response.status, response.headers.get('retry-after')]).toEqual([503, '300']);
    expect(core.map((call) => call.args[0])).toEqual(['ListMailItems']);
  });

  it.each([
    ['ETAG_MISMATCH', 'ABORTED'],
    ['NOT_PENDING', 'FAILED_PRECONDITION'],
    ['CURSOR_RESET_REQUIRED', 'FAILED_PRECONDITION'],
    ['NOT_FOUND', 'NOT_FOUND'],
    ['BAD_REQUEST', 'INVALID_ARGUMENT'],
    ['UNAVAILABLE', 'UNAVAILABLE'],
    ['INTERNAL', 'INTERNAL'],
    ['SOMETHING_ELSE', 'INTERNAL'],
  ])('answers the core reason %s as %s', async (reason, status) => {
    const reply: CoreReply = () => ({ error: reason, retry_after: null });
    const { env } = fakes({}, reply);
    const failed = await refusal(client(env).markMailConverted({ name: `mailItems/${EVENT}`, etag: 'e1', taskId: 't' }));
    expect(failed.status.status).toBe(status);
    expect(failed.status.reason).toBe(reason === 'SOMETHING_ELSE' ? 'INTERNAL' : reason);
  });

  it("passes the core's Retry-After on, and answers a failed core call as UNAVAILABLE", async () => {
    const { env } = fakes({}, () => ({ error: 'UNAVAILABLE', retry_after: 30 }));
    const held = await entry(env, 'read-write').fetch(request(`/api/mail/v1/mailItems/${EVENT}:markConverted`, 'POST', { etag: 'e1', task_id: 't' }));
    expect([held.status, held.headers.get('retry-after')]).toEqual([503, '30']);
    const down = fakes({}, () => {
      throw new Error('object down');
    });
    expect((await refusal(client(down.env).getMailInbox({ name: 'mailInbox' }))).status.reason).toBe('UNAVAILABLE');
  });

  it('reads every request strictly before the core and knows no other path', async () => {
    const { env, core } = fakes({}, () => mailOk({}));
    const mail = entry(env, 'read-write');
    expect((await mail.fetch(request('/api/mail/v1/mailItems?unknown=1'))).status).toBe(400);
    expect((await mail.fetch(request('/api/mail/v1/mailItems:pollReady', 'POST', {}))).status).toBe(405);
    for (const path of ['/api/plus/v1/mailItems', '/api/mail/v1/mailSettings', '/api/v1/mailEvents']) {
      const missing = await mail.fetch(request(path));
      expect(missing.status, path).toBe(404);
      expect(await statusReason(missing)).toBe('NOT_FOUND');
    }
    expect(core).toHaveLength(0);
  });

  it('is served on neither the owner host nor the hooks hosts', async () => {
    const { env, core } = fakes({}, () => mailOk({}));
    for (const path of ['/api/mail/v1/mailItems', '/api/mail/v1/mailItems:pollReady?baseline=true', '/api/mail/v1/mailInbox']) {
      expect((await hooks(env, path)).status, path).toBe(404);
      expect((await owner(env, path)).status, path).toBe(404);
    }
    expect(core).toHaveLength(0);
  });
});
