/**
 * The cross-app contract from the dashboard's side: it calls only the methods ops-v1.ts declares for
 * each app, handles every declared error code (plus timeouts, foreign rejections and bad outputs) for
 * every method, and accepts every valid fixture while refusing the invalid ones its guards cover.
 */
import { describe, expect, it } from 'vitest';
import opsSource from '../../../contracts/ops-v1/ops-v1.ts?raw';
import schema from '../../../contracts/ops-v1/ops-v1.schema.json';
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import { OPS_ERROR_CODES, type OpsApp } from '../../../contracts/ops-v1/ops-v1.ts';
import mailHeroOk from '../../../contracts/ops-v1/fixtures/OpsStatus/mail-hero-ok.json';
import mailHeroDegraded from '../../../contracts/ops-v1/fixtures/OpsStatus/mail-hero-degraded.json';
import mailHeroMaintenance from '../../../contracts/ops-v1/fixtures/OpsStatus/mail-hero-maintenance.json';
import todofyOk from '../../../contracts/ops-v1/fixtures/OpsStatus/todofy-ok.json';
import todofyDegraded from '../../../contracts/ops-v1/fixtures/OpsStatus/todofy-degraded.json';
import statusUnavailable from '../../../contracts/ops-v1/fixtures/OpsStatus/status-unavailable.json';
import guardNormal from '../../../contracts/ops-v1/fixtures/GuardState/normal.json';
import guardShedMail from '../../../contracts/ops-v1/fixtures/GuardState/shed-mail-hero.json';
import guardShedTodofy from '../../../contracts/ops-v1/fixtures/GuardState/shed-todofy.json';
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
import receiptKept from '../../../contracts/ops-v1/fixtures/OpsReportReceipt/kept-newer.json';
import receiptStored from '../../../contracts/ops-v1/fixtures/OpsReportReceipt/stored.json';
import reportDaily from '../../../contracts/ops-v1/fixtures/OpsReport/daily.json';
import invalidDeliveredNoTime from '../../../contracts/ops-v1/fixtures/invalid/CanaryDelivery/delivered-without-time.json';
import invalidFailedNoCode from '../../../contracts/ops-v1/fixtures/invalid/CanaryDelivery/failed-without-code.json';
import invalidResultFailed from '../../../contracts/ops-v1/fixtures/invalid/CanaryResult/failed-without-code.json';
import invalidGuardLevel from '../../../contracts/ops-v1/fixtures/invalid/GuardState/unknown-level.json';
import invalidStatusMissingGuard from '../../../contracts/ops-v1/fixtures/invalid/OpsStatus/missing-guard.json';
import invalidStatusStringMode from '../../../contracts/ops-v1/fixtures/invalid/OpsStatus/string-mode.json';
import invalidStatusUnknownApp from '../../../contracts/ops-v1/fixtures/invalid/OpsStatus/unknown-app.json';
import invalidStartQueued from '../../../contracts/ops-v1/fixtures/invalid/StartCanaryResult/queued-without-event.json';
import invalidStartPaused from '../../../contracts/ops-v1/fixtures/invalid/StartCanaryResult/paused-with-event.json';
import invalidReceipt from '../../../contracts/ops-v1/fixtures/invalid/OpsReportReceipt/too-many.json';
import type { Env } from '../src/env.ts';
import {
  CALLED_METHODS,
  callOps,
  isCanaryDelivery,
  isCanaryResult,
  isGuardState,
  isReceipt,
  isStartCanaryResult,
  isStatus,
  opsCanaryDelivery,
  opsCanaryResult,
  opsReportOps,
  opsSetGuard,
  opsStartCanary,
  opsStatus,
  type OpsCall,
} from '../src/ops-client.ts';

const SCHEMA = schema as { $defs: Record<string, unknown> };
const EVENT_ID = '6d3b2f0e-4c1a-4b7e-8a52-0c9e7f1d2a31';

/** The method names ops-v1.ts declares in `interface <name> ... { ... }` (and its OpsCommon base). */
function declaredMethods(name: string): string[] {
  const block = (interfaceName: string): string => {
    const match = new RegExp(`export interface ${interfaceName}[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(opsSource);
    if (!match?.[1]) throw new Error(`interface ${interfaceName} not found`);
    return match[1];
  };
  const methods = (body: string): string[] => [...body.matchAll(/^\s+([a-zA-Z]+)\(/gm)].map((m) => m[1] ?? '');
  return [...methods(block('OpsCommon<S>')), ...methods(block(name))].sort();
}

type Calls = { app: OpsApp; method: string; args: unknown[] }[];

/** A binding that records every property called on it and answers from `answers`. */
function recordingEnv(answers: Record<string, () => unknown>): { env: Pick<Env, 'MAIL_HERO' | 'TODOFY'>; calls: Calls } {
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
  return { env: { MAIL_HERO: binding('mail-hero'), TODOFY: binding('todofy') } as Pick<Env, 'MAIL_HERO' | 'TODOFY'>, calls };
}

const guardInput = { level: 'shed', reason: 'quota_d1_rows_read', until: '2026-09-30T00:10:00.000Z' } as const;

type Wrapper = (env: Pick<Env, 'MAIL_HERO' | 'TODOFY'>) => Promise<OpsCall<unknown>>;
const WRAPPERS: readonly { app: OpsApp; method: string; call: Wrapper; valid: unknown }[] = [
  { app: 'mail-hero', method: 'status', call: (env) => opsStatus(env, 'mail-hero'), valid: mailHeroOk },
  { app: 'mail-hero', method: 'setGuard', call: (env) => opsSetGuard(env, 'mail-hero', guardInput), valid: guardShedMail },
  { app: 'mail-hero', method: 'startCanary', call: (env) => opsStartCanary(env, { run_id: 'canary-2026-09-29' }), valid: startQueued },
  { app: 'mail-hero', method: 'canaryDelivery', call: (env) => opsCanaryDelivery(env, EVENT_ID), valid: deliveryDelivered },
  { app: 'todofy', method: 'status', call: (env) => opsStatus(env, 'todofy'), valid: todofyOk },
  { app: 'todofy', method: 'setGuard', call: (env) => opsSetGuard(env, 'todofy', guardInput), valid: guardShedTodofy },
  { app: 'todofy', method: 'canaryResult', call: (env) => opsCanaryResult(env, EVENT_ID), valid: resultOk },
  { app: 'todofy', method: 'reportOps', call: (env) => opsReportOps(env, reportDaily as never), valid: receiptStored },
];

describe('only methods ops-v1.ts declares', () => {
  it('lists exactly the declared methods per app', () => {
    expect([...CALLED_METHODS['mail-hero']].sort()).toEqual(declaredMethods('MailHeroOps'));
    expect([...CALLED_METHODS.todofy].sort()).toEqual(declaredMethods('TodofyOps'));
  });

  it('calls each wrapper\'s declared method on the right app, with contract-valid input', async () => {
    for (const wrapper of WRAPPERS) {
      const { env, calls } = recordingEnv({ [wrapper.method]: () => wrapper.valid });
      const result = await wrapper.call(env);
      expect(result).toEqual({ ok: true, value: wrapper.valid });
      expect(calls.map((c) => [c.app, c.method])).toEqual([[wrapper.app, wrapper.method]]);
      expect((CALLED_METHODS[wrapper.app] as readonly string[]).includes(wrapper.method)).toBe(true);
      const [arg] = calls[0]?.args ?? [];
      if (wrapper.method === 'setGuard') expect(validate(SCHEMA, 'SetGuardInput', arg)).toEqual([]);
      if (wrapper.method === 'startCanary') expect(validate(SCHEMA, 'StartCanaryInput', arg)).toEqual([]);
      if (wrapper.method === 'canaryDelivery' || wrapper.method === 'canaryResult') expect(validate(SCHEMA, 'EventId', arg)).toEqual([]);
      if (wrapper.method === 'reportOps') expect(validate(SCHEMA, 'OpsReport', arg)).toEqual([]);
    }
    // Every declared method is covered.
    expect(WRAPPERS.filter((w) => w.app === 'mail-hero').map((w) => w.method).sort()).toEqual(declaredMethods('MailHeroOps'));
    expect(WRAPPERS.filter((w) => w.app === 'todofy').map((w) => w.method).sort()).toEqual(declaredMethods('TodofyOps'));
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
      expect(await wrapper.call({} as Pick<Env, 'MAIL_HERO' | 'TODOFY'>)).toEqual({ ok: false, code: 'not_configured' });
      const bad = recordingEnv({ [wrapper.method]: () => ({ unexpected: true }) });
      expect(await wrapper.call(bad.env)).toEqual({ ok: false, code: 'invalid_output' });
      const huge = recordingEnv({ [wrapper.method]: () => ({ ...(wrapper.valid as object), padding: 'x'.repeat(40_000) }) });
      expect(await wrapper.call(huge.env)).toEqual({ ok: false, code: 'invalid_output' });
    }
    expect(await callOps(() => new Promise(() => undefined), isGuardState, 20)).toEqual({ ok: false, code: 'timeout' });
  });
});

describe('shape guards over the contract fixtures', () => {
  it('accept every valid fixture', () => {
    for (const status of [mailHeroOk, mailHeroDegraded, mailHeroMaintenance]) expect(isStatus('mail-hero')(status)).toBe(true);
    for (const status of [todofyOk, todofyDegraded, statusUnavailable]) expect(isStatus('todofy')(status)).toBe(true);
    expect(isStatus('todofy')(mailHeroOk)).toBe(false);
    for (const guard of [guardNormal, guardShedMail, guardShedTodofy]) expect(isGuardState(guard)).toBe(true);
    for (const result of [startQueued, startPausedBlocked, startPausedSend, startMaintenance, startNoEndpoint]) expect(isStartCanaryResult(result)).toBe(true);
    for (const d of [deliveryDelivered, deliveryFailedWindow, deliveryFailed, deliveryPausedBlocked, deliveryPaused, deliveryPendingFirst, deliveryPendingRetry, deliveryUnknown]) {
      expect(isCanaryDelivery(d)).toBe(true);
    }
    for (const r of [resultFailed, resultNotSeen, resultOk, resultProcessingPaused, resultProcessing]) expect(isCanaryResult(r)).toBe(true);
    for (const r of [receiptKept, receiptStored]) expect(isReceipt(r)).toBe(true);
  });

  it('refuse the invalid fixtures whose fields the dashboard reads', () => {
    expect(isCanaryDelivery(invalidDeliveredNoTime)).toBe(false);
    expect(isCanaryDelivery(invalidFailedNoCode)).toBe(false);
    expect(isCanaryResult(invalidResultFailed)).toBe(false);
    expect(isGuardState(invalidGuardLevel)).toBe(false);
    expect(isStatus('mail-hero')(invalidStatusMissingGuard)).toBe(false);
    expect(isStatus('mail-hero')(invalidStatusStringMode)).toBe(false);
    expect(isStatus('mail-hero')(invalidStatusUnknownApp)).toBe(false);
    expect(isStartCanaryResult(invalidStartQueued)).toBe(false);
    expect(isStartCanaryResult(invalidStartPaused)).toBe(false);
    // The receipt guard reads only stored/generated_at/item_count; the schema refuses this one.
    expect(validate(SCHEMA, 'OpsReportReceipt', invalidReceipt)).not.toEqual([]);
  });
});

describe('where the bindings are used', () => {
  it('only ops-client.ts touches MAIL_HERO and TODOFY', () => {
    const sources = import.meta.glob('../src/*.ts', { query: '?raw', import: 'default', eager: true });
    const users = Object.entries(sources)
      .filter(([, text]) => /\.(MAIL_HERO|TODOFY)\b/.test(text))
      .map(([path]) => path.replace('../src/', ''));
    expect(users).toEqual(['ops-client.ts']);
  });

  it('never imports mail-hero/ or todofy/ code', () => {
    const sources = import.meta.glob('../src/*.ts', { query: '?raw', import: 'default', eager: true });
    for (const text of Object.values(sources)) {
      expect(text).not.toMatch(/from '(\.\.\/)+(mail-hero|todofy)\//);
    }
  });
});
