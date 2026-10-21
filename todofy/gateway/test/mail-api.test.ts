import { describe, expect, it } from 'vitest';
import { createHttpClient, RpcStatusError } from '@ziyixi/proto/http-client';
import { MailReadinessService } from '@ziyixi/proto/todofy/ui/v1/mail_ready_pb';
import { PlusService } from '@ziyixi/proto/todofy/ui/v1/plus_service_pb';
import { mailRequest, MailApi } from '../src/mail-api.ts';
import { Planning } from '../src/planning.ts';
import { fakes, hooks, owner, uiOk, uiRefusal } from './helpers.ts';

function request(path: string, method = 'GET', body?: unknown) {
  return new Request(`https://mail.internal${path}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('the private MailApi binding', () => {
  it('serves exactly the existing list, summary and conversion operations', async () => {
    const { env, core } = fakes({}, () => uiOk({}));
    const entry = new MailApi({ props: {} } as ExecutionContext, env);
    const client = createHttpClient(PlusService, call => entry.fetch(new Request(`https://mail.internal${call.url}`, {
      method: call.httpMethod, headers: { 'content-type': 'application/json' }, ...(call.body === undefined ? {} : { body: call.body }),
    })));
    await client.listMailItems({ pageSize: 2 });
    await client.readMailSummary({ id: 'synthetic-mail' });
    const requestId = '00000000-0000-4000-8000-000000000001';
    await client.convertMailItem({ eventId: 'synthetic-mail', etag: 'current', requestId });
    expect(core.map(call => [call.method, call.args[0]])).toEqual([
      ['plus_native_ui', 'ListMailItems'], ['plus_native_ui', 'ReadMailSummary'], ['plus_native_ui', 'ConvertMailItem'],
    ]);
    expect(JSON.parse(String(core[2]?.args[1]))).toEqual({ event_id: 'synthetic-mail', etag: 'current', request_id: requestId });
    for (const path of ['/api/plus/v1/mailSettings:read', '/api/plus/v1/weeklyReview:read?week_start=2026-10-12']) {
      expect((await entry.fetch(request(path))).status).toBe(400);
    }
    expect((await entry.fetch(request('/api/plus/v1/mailItems:deleteSummaries', 'POST', { event_ids: ['synthetic-mail'] }))).status).toBe(400);
    expect(core).toHaveLength(3);
    // Granting MailApi does not grant Tasks' Planning channel.
    const planning = new Planning({ props: { source: 'personal-mcp' } } as ExecutionContext<{ source: string }>, env);
    expect((await planning.fetch(request('/api/plus/v1/mailItems'))).status).toBe(403);
  });

  it('uses the generated readiness contract and the dedicated bounded core read', async () => {
    const { env, core } = fakes({}, () => uiOk({ cursor: '52' }));
    const client = createHttpClient(MailReadinessService, call => mailRequest(request(call.url), env));
    expect(await client.pollMailReady({ baseline: true })).toMatchObject({ cursor: '52' });
    await client.pollMailReady({ cursor: '52' });
    expect(core.map(call => [call.method, JSON.parse(String(call.args[0])) as unknown])).toEqual([
      ['mail_ready_poll', { baseline: true }], ['mail_ready_poll', { cursor: '52' }],
    ]);
    expect((await mailRequest(request('/api/plus/v1/mailItems:pollReady', 'POST', {}), env)).status).toBe(405);
    expect((await mailRequest(request('/api/plus/v1/mailItems:pollReady?unknown=true'), env)).status).toBe(400);
    expect(core).toHaveLength(2);
  });

  it('preserves source refusals and maintenance behavior, with no public Mail routes', async () => {
    const { env, core } = fakes({ MAINTENANCE_MODE: 'true' }, () => uiRefusal('ETAG_MISMATCH'));
    const changed = await mailRequest(request('/api/plus/v1/mailItems'), env);
    expect(await changed.text()).toContain('ETAG_MISMATCH');
    const conversion = await mailRequest(request('/api/plus/v1/mailItems:convertMailItem', 'POST', {
      event_id: 'synthetic-mail', etag: 'old', request_id: '00000000-0000-4000-8000-000000000001',
    }), env);
    expect(conversion.status).toBe(503);
    const readiness = createHttpClient(MailReadinessService, call => mailRequest(request(call.url), env));
    const failure = await readiness.pollMailReady({ cursor: '0' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RpcStatusError);
    expect((failure as RpcStatusError).status.reason).toBe('ETAG_MISMATCH');
    for (const path of ['/api/plus/v1/mailItems', '/api/plus/v1/mailItems:pollReady?baseline=true']) {
      expect((await owner(env, path)).status).toBe(404);
      expect((await hooks(env, path)).status).toBe(404);
    }
    expect(core).toHaveLength(2);
  });

  it('reports a restored Mail cursor as FAILED_PRECONDITION with explicit reset instructions', async () => {
    const { env } = fakes({}, () => uiRefusal('CURSOR_RESET_REQUIRED'));
    const client = createHttpClient(MailReadinessService, call => mailRequest(request(call.url), env));
    const failure = await client.pollMailReady({ cursor: '52' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RpcStatusError);
    expect((failure as RpcStatusError).status).toMatchObject({ status: 'FAILED_PRECONDITION', reason: 'CURSOR_RESET_REQUIRED' });
    expect((failure as RpcStatusError).status.message).toContain('baseline=true');
  });
});
