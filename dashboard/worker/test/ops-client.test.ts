/**
 * The cross-app contract from the dashboard's side: it calls only the methods of the generated services each app
 * implements (proto/ops/v1/ops.proto), sends only inputs the contract's rules accept, handles every declared error code
 * (plus timeouts, foreign rejections and bad outputs) for every method, and reads answers exactly as the contract's
 * rules allow a consumer: every valid fixture passes, every invalid output fixture is refused, except where the
 * contract's consumer rules tolerate it.
 */
import { describe, expect, it } from 'vitest';
import { OpsStatusSchema } from '@ziyixi/proto/ops/v1/ops_pb';
import type { OpsApp } from '../src/api-types.ts';
import { REGISTRY } from '../src/registry.ts';
import mailHeroOk from '../../../contracts/ops-v1/fixtures/OpsStatus/mail-hero-ok.json';
import mailHeroDegraded from '../../../contracts/ops-v1/fixtures/OpsStatus/mail-hero-degraded.json';
import mailHeroMaintenance from '../../../contracts/ops-v1/fixtures/OpsStatus/mail-hero-maintenance.json';
import todofyOk from '../../../contracts/ops-v1/fixtures/OpsStatus/todofy-ok.json';
import todofyDegraded from '../../../contracts/ops-v1/fixtures/OpsStatus/todofy-degraded.json';
import watchOk from '../../../contracts/ops-v1/fixtures/OpsStatus/watch-ok.json';
import fleetOk from '../../../contracts/ops-v1/fixtures/OpsStatus/fleet-ok.json';
import notionPublishOk from '../../../contracts/ops-v1/fixtures/OpsStatus/notion-publish-ok.json';
import newsletterOk from '../../../contracts/ops-v1/fixtures/OpsStatus/newsletter-ok.json';
import codexGatewayOk from '../../../contracts/ops-v1/fixtures/OpsStatus/codex-gateway-ok.json';
import recallOk from '../../../contracts/ops-v1/fixtures/OpsStatus/recall-ok.json';
import briefOk from '../../../contracts/ops-v1/fixtures/OpsStatus/brief-ok.json';
import tasksOk from '../../../contracts/ops-v1/fixtures/OpsStatus/tasks-ok.json';
import personalMcpOk from './fixtures/personal-mcp-ok.json';
import watchDegraded from '../../../contracts/ops-v1/fixtures/OpsStatus/watch-degraded.json';
import statusUnavailable from '../../../contracts/ops-v1/fixtures/OpsStatus/status-unavailable.json';
import guardNormal from '../../../contracts/ops-v1/fixtures/GuardState/normal.json';
import guardShedMail from '../../../contracts/ops-v1/fixtures/GuardState/shed-mail-hero.json';
import guardShedTodofy from '../../../contracts/ops-v1/fixtures/GuardState/shed-todofy.json';
import guardShedWatch from '../../../contracts/ops-v1/fixtures/GuardState/shed-watch.json';
import startQueued from '../../../contracts/ops-v1/fixtures/StartCanaryResult/queued.json';
import startPausedBlocked from '../../../contracts/ops-v1/fixtures/StartCanaryResult/paused-endpoint-blocked.json';
import startPausedSend from '../../../contracts/ops-v1/fixtures/StartCanaryResult/paused-send-paused.json';
import startMaintenance from '../../../contracts/ops-v1/fixtures/StartCanaryResult/unavailable-maintenance.json';
import startNoEndpoint from '../../../contracts/ops-v1/fixtures/StartCanaryResult/unavailable-no-endpoint.json';
import deliveryDelivered from '../../../contracts/ops-v1/fixtures/CanaryDelivery/delivered.json';
import deliveryFailedWindow from '../../../contracts/ops-v1/fixtures/CanaryDelivery/failed-window.json';
import deliveryFailed from '../../../contracts/ops-v1/fixtures/CanaryDelivery/failed.json';
import deliveryPausedBlocked from '../../../contracts/ops-v1/fixtures/CanaryDelivery/paused-endpoint-blocked.json';
import deliveryPaused from '../../../contracts/ops-v1/fixtures/CanaryDelivery/paused.json';
import deliveryPendingFirst from '../../../contracts/ops-v1/fixtures/CanaryDelivery/pending-first-attempt.json';
import deliveryPendingRetry from '../../../contracts/ops-v1/fixtures/CanaryDelivery/pending-retrying.json';
import deliveryUnknown from '../../../contracts/ops-v1/fixtures/CanaryDelivery/unknown.json';
import resultFailed from '../../../contracts/ops-v1/fixtures/CanaryResult/failed.json';
import resultNotSeen from '../../../contracts/ops-v1/fixtures/CanaryResult/not-seen.json';
import resultOk from '../../../contracts/ops-v1/fixtures/CanaryResult/ok.json';
import resultProcessingPaused from '../../../contracts/ops-v1/fixtures/CanaryResult/processing-paused.json';
import resultProcessing from '../../../contracts/ops-v1/fixtures/CanaryResult/processing.json';
import type { Env } from '../src/env.ts';
import { contractErrors, declaredMethods } from './contract.ts';
import {
  CALLED_METHODS,
  OPS_APPS,
  OPS_ERROR_CODES,
  asCanaryDelivery,
  asCanaryResult,
  asGuardState,
  asInboxTask,
  asStartCanaryResult,
  asStatus,
  callOps,
  conform,
  createInboxTask,
  opsCanaryDelivery,
  opsCanaryResult,
  opsSetGuard,
  opsStartCanary,
  opsStatus,
  type OpsCall,
} from '../src/ops-client.ts';

const EVENT_ID = '6d3b2f0e-4c1a-4b7e-8a52-0c9e7f1d2a31';

type Calls = { app: OpsApp; method: string; args: unknown[] }[];

/** A binding that records every property called on it and answers from `answers`. */
function recordingEnv(answers: Record<string, () => unknown>): { env: Pick<Env, 'MAIL_HERO' | 'TODOFY' | 'WATCH' | 'FLEET' | 'NEWSLETTER' | 'CODEX_GATEWAY' | 'NOTION_PUBLISH' | 'MAILSORT' | 'RECALL' | 'BRIEF' | 'TASKS' | 'PERSONAL_MCP' | 'MODEL_ROUTER'>; calls: Calls } {
  const calls: Calls = [];
  const binding = (app: OpsApp): unknown =>
    new Proxy(
      {},
      {
        get(_target, method) {
          if (typeof method !== 'string' || method === 'then') return undefined;
          return (...args: unknown[]) => {
            calls.push({ app, method, args });
            const answer = answers[method];
            return answer ? Promise.resolve().then(answer) : Promise.reject(new Error('The RPC receiver does not implement the method'));
          };
        },
      },
    );
  return { env: { MAIL_HERO: binding('mail-hero'), TODOFY: binding('todofy'), WATCH: binding('watch'), FLEET: binding('fleet'), NEWSLETTER: binding('newsletter'), CODEX_GATEWAY: binding('codex-gateway'), NOTION_PUBLISH: binding('notion-publish'), MAILSORT: binding('mailsort'), RECALL: binding('recall'), BRIEF: binding('brief'), TASKS: binding('tasks'), PERSONAL_MCP: binding('personal-mcp'), MODEL_ROUTER: binding('model-router') } as Pick<Env, 'MAIL_HERO' | 'TODOFY' | 'WATCH' | 'FLEET' | 'NEWSLETTER' | 'CODEX_GATEWAY' | 'NOTION_PUBLISH' | 'MAILSORT' | 'RECALL' | 'BRIEF' | 'TASKS' | 'PERSONAL_MCP' | 'MODEL_ROUTER'>, calls };
}

const guardInput = { level: 'shed', reason: 'quota_d1_rows_read', until: '2026-09-30T00:10:00.000Z' } as const;

type Wrapper = (env: Pick<Env, 'MAIL_HERO' | 'TODOFY' | 'WATCH' | 'FLEET' | 'NEWSLETTER' | 'CODEX_GATEWAY' | 'NOTION_PUBLISH' | 'MAILSORT' | 'RECALL' | 'BRIEF' | 'TASKS' | 'PERSONAL_MCP' | 'MODEL_ROUTER'>) => Promise<OpsCall<unknown>>;
const WRAPPERS: readonly { app: OpsApp; method: string; call: Wrapper; valid: unknown }[] = [
  { app: 'fleet', method: 'status', call: (env) => opsStatus(env, 'fleet'), valid: fleetOk },
  { app: 'notion-publish', method: 'status', call: (env) => opsStatus(env, 'notion-publish'), valid: notionPublishOk },
  { app: 'codex-gateway', method: 'status', call: (env) => opsStatus(env, 'codex-gateway'), valid: codexGatewayOk },
  { app: 'newsletter', method: 'status', call: (env) => opsStatus(env, 'newsletter'), valid: newsletterOk },
  { app: 'recall', method: 'status', call: (env) => opsStatus(env, 'recall'), valid: recallOk },
  { app: 'tasks', method: 'status', call: (env) => opsStatus(env, 'tasks'), valid: tasksOk },
  { app: 'model-router', method: 'status', call: (env) => opsStatus(env, 'model-router'), valid: { ...tasksOk, app: 'model-router', ui_url: 'https://models.example.com/' } },
  { app: 'personal-mcp', method: 'status', call: (env) => opsStatus(env, 'personal-mcp'), valid: personalMcpOk },
  { app: 'brief', method: 'status', call: (env) => opsStatus(env, 'brief'), valid: briefOk },
  { app: 'brief', method: 'setGuard', call: (env) => opsSetGuard(env, 'brief', { level: 'normal', reason: 'quota_normal', until: null }), valid: guardNormal },
  { app: 'mail-hero', method: 'status', call: (env) => opsStatus(env, 'mail-hero'), valid: mailHeroOk },
  { app: 'mail-hero', method: 'setGuard', call: (env) => opsSetGuard(env, 'mail-hero', guardInput), valid: guardShedMail },
  { app: 'mail-hero', method: 'startCanary', call: (env) => opsStartCanary(env, { run_id: 'canary-2026-09-29' }), valid: startQueued },
  { app: 'mail-hero', method: 'canaryDelivery', call: (env) => opsCanaryDelivery(env, EVENT_ID), valid: deliveryDelivered },
  { app: 'todofy', method: 'status', call: (env) => opsStatus(env, 'todofy'), valid: todofyOk },
  { app: 'todofy', method: 'setGuard', call: (env) => opsSetGuard(env, 'todofy', guardInput), valid: guardShedTodofy },
  { app: 'todofy', method: 'canaryResult', call: (env) => opsCanaryResult(env, EVENT_ID), valid: resultOk },
  { app: 'watch', method: 'status', call: (env) => opsStatus(env, 'watch'), valid: watchOk },
  { app: 'watch', method: 'setGuard', call: (env) => opsSetGuard(env, 'watch', guardInput), valid: guardShedWatch },
];

describe('only the methods of the services each app implements', () => {
  it('calls exactly the registry\'s ops_v1 entries (OpsStatus.app is open on the wire, OpsApp is this list)', () => {
    const entries = REGISTRY.entries.filter((entry) => entry.status.type === 'ops_v1').map((entry) => entry.id);
    expect(OPS_APPS).toEqual(entries);
    expect([...OPS_APPS].sort()).toEqual(['brief', 'codex-gateway', 'fleet', 'mail-hero', 'mailsort', 'model-router', 'newsletter', 'notion-publish', 'personal-mcp', 'recall', 'tasks', 'todofy', 'watch'] satisfies readonly OpsApp[]);
    expect(Object.keys(CALLED_METHODS).sort()).toEqual([...OPS_APPS].sort());
  });

  it('calls each app through the binding its registry entry names', async () => {
    for (const app of OPS_APPS) {
      const { env, calls } = recordingEnv({});
      await opsStatus(env, app);
      expect(calls.map((call) => [call.app, call.method])).toEqual([[app, 'status']]);
    }
  });

  it('never forwards a guard mutation to an entry the registry does not guard', async () => {
    const { env, calls } = recordingEnv({});
    const unguarded = REGISTRY.entries.flatMap((entry) => (entry.status.type === 'ops_v1' && !entry.status.guard ? [entry.id as OpsApp] : []));
    expect(unguarded).toEqual(expect.arrayContaining(['fleet', 'newsletter', 'codex-gateway', 'notion-publish', 'mailsort', 'recall', 'tasks', 'personal-mcp', 'model-router']));
    for (const app of unguarded) {
      expect(await opsSetGuard(env, app, guardInput)).toEqual({ ok: false, code: 'invalid_input' });
    }
    expect(calls).toEqual([]);
  });

  it('reads the status of an app that joined later, but keeps only the answer of the app it called', () => {
    const newer = { ...(watchOk as Record<string, unknown>), app: 'newer-app' };
    expect(conform(OpsStatusSchema, newer)).toEqual(newer);
    for (const app of OPS_APPS) expect(asStatus(app)(newer)).toBeNull();
  });

  it('lists exactly the declared methods per app', () => {
    expect([...CALLED_METHODS['mail-hero']].sort()).toEqual(declaredMethods('mail-hero'));
    expect([...CALLED_METHODS.todofy].sort()).toEqual(declaredMethods('todofy'));
    expect([...CALLED_METHODS.watch].sort()).toEqual(declaredMethods('watch'));
    expect([...CALLED_METHODS.brief].sort()).toEqual(declaredMethods('brief'));
    expect([...CALLED_METHODS.tasks].sort()).toEqual(declaredMethods('tasks'));
  });

  it('calls each wrapper\'s declared method on the right app, with contract-valid input', async () => {
    for (const wrapper of WRAPPERS) {
      const { env, calls } = recordingEnv({ [wrapper.method]: () => wrapper.valid });
      const result = await wrapper.call(env);
      expect(result).toEqual({ ok: true, value: wrapper.valid });
      expect(calls.map((c) => [c.app, c.method])).toEqual([[wrapper.app, wrapper.method]]);
      expect((CALLED_METHODS[wrapper.app] as readonly string[]).includes(wrapper.method)).toBe(true);
      const [arg] = calls[0]?.args ?? [];
      if (wrapper.method === 'setGuard') expect(contractErrors('SetGuardInput', arg)).toEqual([]);
      if (wrapper.method === 'startCanary') expect(contractErrors('StartCanaryInput', arg)).toEqual([]);
      if (wrapper.method === 'canaryDelivery' || wrapper.method === 'canaryResult') expect(contractErrors('EventId', arg)).toEqual([]);
    }
    // Every declared method is covered.
    expect(WRAPPERS.filter((w) => w.app === 'mail-hero').map((w) => w.method).sort()).toEqual(declaredMethods('mail-hero'));
    expect(WRAPPERS.filter((w) => w.app === 'todofy').map((w) => w.method).sort()).toEqual(declaredMethods('todofy'));
    expect(WRAPPERS.filter((w) => w.app === 'watch').map((w) => w.method).sort()).toEqual(declaredMethods('watch'));
    expect(WRAPPERS.filter((w) => w.app === 'brief').map((w) => w.method).sort()).toEqual(declaredMethods('brief'));
  });

  it('never sends an input the contract refuses: the call answers invalid_input, as the app would', async () => {
    const { env, calls } = recordingEnv({});
    expect(await opsSetGuard(env, 'mail-hero', { level: 'shed', reason: 'Free text', until: '2026-09-30T00:00:00Z' })).toEqual({ ok: false, code: 'invalid_input' });
    expect(await opsSetGuard(env, 'todofy', { level: 'normal', reason: 'ok', until: '2026-09-30T00:00:00Z' } as never)).toEqual({ ok: false, code: 'invalid_input' });
    expect(await opsStartCanary(env, { run_id: 'canary 1' })).toEqual({ ok: false, code: 'invalid_input' });
    expect(await opsCanaryDelivery(env, 'not-an-event')).toEqual({ ok: false, code: 'invalid_input' });
    expect(await opsCanaryResult(env, EVENT_ID.toUpperCase())).toEqual({ ok: false, code: 'invalid_input' });
    expect(calls).toEqual([]);
  });
});

describe('error handling for every method', () => {
  it('keeps every OpsErrorCode the contract declares', async () => {
    for (const wrapper of WRAPPERS) {
      for (const code of OPS_ERROR_CODES) {
        const { env } = recordingEnv({ [wrapper.method]: () => { throw new Error(code); } });
        expect(await wrapper.call(env)).toEqual({ ok: false, code });
      }
    }
  });

  it('maps foreign rejections, unknown methods, missing bindings, bad outputs and timeouts', async () => {
    for (const wrapper of WRAPPERS) {
      const foreign = recordingEnv({ [wrapper.method]: () => { throw new TypeError('binding exploded'); } });
      expect(await wrapper.call(foreign.env)).toEqual({ ok: false, code: 'unavailable' });
      const notAnError = recordingEnv({ [wrapper.method]: () => { throw 'busy' as unknown as Error; } });
      expect(await wrapper.call(notAnError.env)).toEqual({ ok: false, code: 'unavailable' });
      // An older release without the method: the RPC receiver rejects.
      expect(await wrapper.call(recordingEnv({}).env)).toEqual({ ok: false, code: 'unavailable' });
      expect(await wrapper.call({} as Pick<Env, 'MAIL_HERO' | 'TODOFY' | 'WATCH' | 'FLEET' | 'NEWSLETTER' | 'CODEX_GATEWAY' | 'NOTION_PUBLISH' | 'MAILSORT' | 'RECALL' | 'BRIEF' | 'TASKS' | 'PERSONAL_MCP' | 'MODEL_ROUTER'>)).toEqual({ ok: false, code: 'not_configured' });
      const bad = recordingEnv({ [wrapper.method]: () => ({ unexpected: true }) });
      expect(await wrapper.call(bad.env)).toEqual({ ok: false, code: 'invalid_output' });
      const huge = recordingEnv({ [wrapper.method]: () => ({ ...(wrapper.valid as object), padding: 'x'.repeat(40_000) }) });
      expect(await wrapper.call(huge.env)).toEqual({ ok: false, code: 'invalid_output' });
    }
    expect(await callOps(() => new Promise(() => undefined), asGuardState, 20)).toEqual({ ok: false, code: 'timeout' });
  });
});

describe('answers are read with the contract\'s rules', () => {
  it('accepts every valid fixture unchanged', () => {
    for (const status of [mailHeroOk, mailHeroDegraded, mailHeroMaintenance]) expect(asStatus('mail-hero')(status)).toEqual(status);
    for (const status of [todofyOk, todofyDegraded, statusUnavailable]) expect(asStatus('todofy')(status)).toEqual(status);
    expect(asStatus('todofy')(mailHeroOk)).toBeNull();
    for (const status of [watchOk, watchDegraded]) expect(asStatus('watch')(status)).toEqual(status);
    expect(asStatus('watch')(todofyOk)).toBeNull();
    for (const guard of [guardNormal, guardShedMail, guardShedTodofy, guardShedWatch]) expect(asGuardState(guard)).toEqual(guard);
    for (const result of [startQueued, startPausedBlocked, startPausedSend, startMaintenance, startNoEndpoint]) {
      expect(asStartCanaryResult(result)).toEqual(result);
    }
    for (const d of [deliveryDelivered, deliveryFailedWindow, deliveryFailed, deliveryPausedBlocked, deliveryPaused, deliveryPendingFirst, deliveryPendingRetry, deliveryUnknown]) {
      expect(asCanaryDelivery(d)).toEqual(d);
    }
    for (const r of [resultFailed, resultNotSeen, resultOk, resultProcessingPaused, resultProcessing]) expect(asCanaryResult(r)).toEqual(r);
  });

  // Every invalid fixture of an output type. The contract's consumer rules (README "Versioning")
  // tolerate exactly these: unknown fields are dropped, and new codes of an additive enum are read.
  const invalid = import.meta.glob('../../../contracts/ops-v1/fixtures/invalid/*/*.json', { import: 'default', eager: true });
  const OUTPUTS: Readonly<Record<string, (value: unknown) => unknown>> = {
    OpsStatus: asStatus('mail-hero'),
    GuardState: asGuardState,
    StartCanaryResult: asStartCanaryResult,
    CanaryDelivery: asCanaryDelivery,
    CanaryResult: asCanaryResult,
  };
  const without = (field: string) => (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
  const TOLERATED: Readonly<Record<string, (value: Record<string, unknown>) => unknown>> = {
    'OpsStatus/extra-field-subject.json': without('subject'),
    'CanaryResult/ok-with-summary.json': without('summary'),
    'StartCanaryResult/unknown-reason.json': (value) => value,
  };

  it('refuses every invalid output fixture the consumer rules do not tolerate', () => {
    const seen: string[] = [];
    for (const [path, value] of Object.entries(invalid)) {
      const name = /invalid\/([^/]+)\/([^/]+)$/.exec(path);
      const type = name?.[1] ?? '';
      const read = OUTPUTS[type];
      // Inputs (SetGuardInput, StartCanaryInput) are ours; the digest's OpsReport and its receipt are no longer sent.
      if (read === undefined) continue;
      const key = `${type}/${name?.[2] ?? ''}`;
      seen.push(key);
      const tolerated = TOLERATED[key];
      if (tolerated === undefined) {
        expect(read(value), key).toBeNull();
      } else {
        const expected = tolerated(value as Record<string, unknown>);
        expect(read(value), key).toEqual(expected);
      }
    }
    // Every OpsStatus leak fixture is covered (address as a counter, free text, extra field, http URL, ...).
    expect(seen.filter((key) => key.startsWith('OpsStatus/')).length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(TOLERATED).every((key) => seen.includes(key))).toBe(true);
  });

  it('never stores a field the schema does not declare, at any depth', () => {
    const leaky = {
      ...mailHeroOk,
      subject: 'Quarterly report',
      guard: { ...guardNormal, note: 'owner@example.com' },
      signals: [{ code: 'send_paused', severity: 'warning', metrics: {}, text: 'Mail from owner@example.com' }],
    };
    const read = asStatus('mail-hero')(leaky);
    expect(read).not.toBeNull();
    expect(JSON.stringify(read)).not.toContain('owner@');
    expect(read).toEqual({ ...mailHeroOk, signals: [{ code: 'send_paused', severity: 'warning', metrics: {} }] });
  });

  it('reads a new waiting_code or start reason (additive within ops-v1) but never free text', () => {
    expect(asCanaryResult({ state: 'processing', waiting_code: 'gemini_cooldown' })).toEqual({ state: 'processing', waiting_code: 'gemini_cooldown' });
    expect(asCanaryResult({ state: 'processing', waiting_code: 'Waiting for Gemini' })).toBeNull();
    expect(asStartCanaryResult({ event_id: null, state: 'paused', reason: 'new_pause' })).toEqual({ event_id: null, state: 'paused', reason: 'new_pause' });
    expect(asStartCanaryResult({ event_id: null, state: 'paused', reason: 'owner@example.com' })).toBeNull();
    // Open only for a consumer: a producer (a strict read, the generated JSON Schema) keeps to the list.
    expect(contractErrors('CanaryResult', { state: 'processing', waiting_code: 'gemini_cooldown' })).not.toEqual([]);
    // A new value of a closed enum (a state, a severity, a health) is refused: the flows branch on it.
    expect(asStatus('mail-hero')({ ...mailHeroOk, health: 'fine' })).toBeNull();
    expect(asCanaryDelivery({ state: 'retrying', attempts: 1 })).toBeNull();
    expect(asStatus('mail-hero')({ ...mailHeroOk, signals: [{ code: 'x', severity: 'urgent', metrics: {} }] })).toBeNull();
  });

  it('refuses null for every REQUIRED enum and message (non_null), so no flow meets a state it cannot branch on', async () => {
    // Every null the codec used to let through on a lenient read (the pre-move dashboard refused each one).
    expect(asCanaryDelivery({ state: null, attempts: 0 })).toBeNull();
    expect(asCanaryDelivery({ state: null, attempts: 3, error_code: 'x', delivered_at: '2026-09-29T22:30:04Z' })).toBeNull();
    expect(asCanaryResult({ state: null })).toBeNull();
    expect(asStartCanaryResult({ event_id: null, state: null })).toBeNull();
    expect(asGuardState({ ...guardNormal, level: null })).toBeNull();
    expect(asStatus('mail-hero')({ ...mailHeroOk, health: null })).toBeNull();
    expect(asStatus('mail-hero')({ ...mailHeroOk, guard: null })).toBeNull();
    expect(asStatus('mail-hero')({ ...mailHeroOk, signals: [{ code: 'x', severity: null, metrics: {} }] })).toBeNull();
    // So the canary's tick never reads a delivery or a result without a state (applyDelivery's switch has no default).
    expect(await callOps(() => Promise.resolve({ state: null, attempts: 0 }), asCanaryDelivery)).toEqual({ ok: false, code: 'invalid_output' });
    expect(await callOps(() => Promise.resolve({ state: null }), asCanaryResult)).toEqual({ ok: false, code: 'invalid_output' });
  });
});

describe("the digest's daily task (Tasks' TaskInbox)", () => {
  const REQUEST = { request_id: '00000000-0000-4000-8000-000000000001', title: '运维摘要 2026-09-29：1 项需要关注', description: '- warning · dashboard · tick_stale' };
  const ANSWER = { task_id: 'task-1', subtask_ids: [], replayed: false };

  function inbox(answer: () => unknown): { env: Pick<Env, 'TASK_INBOX'>; sent: unknown[] } {
    const sent: unknown[] = [];
    return { env: { TASK_INBOX: { createInboxTask: (input: unknown) => { sent.push(input); return Promise.resolve().then(answer); } } } as unknown as Pick<Env, 'TASK_INBOX'>, sent };
  }

  it('sends the request in its wire form and reads the answer', async () => {
    const { env, sent } = inbox(() => ANSWER);
    expect(await createInboxTask(env, REQUEST)).toEqual({ ok: true, value: ANSWER });
    expect(sent).toEqual([REQUEST]);
    expect(asInboxTask({ ...ANSWER, extra: 'skipped' })).toEqual(ANSWER);
  });

  it("never sends what TaskInbox refuses, and maps its codes: daily_limit reads as busy", async () => {
    const { env, sent } = inbox(() => ANSWER);
    expect(await createInboxTask(env, { ...REQUEST, request_id: 'not-a-uuid' })).toEqual({ ok: false, code: 'invalid_input' });
    expect(sent).toEqual([]);
    for (const [thrown, code] of [['invalid_input', 'invalid_input'], ['daily_limit', 'busy'], ['unavailable', 'unavailable'], ['Storage exploded', 'unavailable']] as const) {
      expect(await createInboxTask(inbox(() => { throw new Error(thrown); }).env, REQUEST)).toEqual({ ok: false, code });
    }
    expect(await createInboxTask({}, REQUEST)).toEqual({ ok: false, code: 'not_configured' });
    expect(await createInboxTask(inbox(() => ({ task_id: 1 })).env, REQUEST)).toEqual({ ok: false, code: 'invalid_output' });
  });
});

describe('where the bindings are used', () => {
  it('only ops-client.ts touches MAIL_HERO, TODOFY and WATCH', () => {
    const sources = import.meta.glob('../src/*.ts', { query: '?raw', import: 'default', eager: true });
    const users = Object.entries(sources)
      .filter(([, text]) => /\.(MAIL_HERO|TODOFY|WATCH)\b/.test(text))
      .map(([path]) => path.replace('../src/', ''));
    expect(users).toEqual(['ops-client.ts']);
  });

  it('never imports mail-hero/, todofy/ or watch/ code', () => {
    const sources = import.meta.glob('../src/*.ts', { query: '?raw', import: 'default', eager: true });
    for (const text of Object.values(sources)) {
      expect(text).not.toMatch(/from '(\.\.\/)+(mail-hero|todofy|watch)\//);
    }
  });
});
