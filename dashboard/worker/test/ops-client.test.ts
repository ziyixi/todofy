/**
 * The cross-app contract from the dashboard's side: it calls only the methods ops-v1.ts declares for
 * each app, handles every declared error code (plus timeouts, foreign rejections and bad outputs) for
 * every method, and reads answers exactly as the contract schema allows: every valid fixture passes,
 * every invalid output fixture is refused, except where the contract's consumer rules tolerate it.
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
import labOk from '../../../contracts/ops-v1/fixtures/OpsStatus/lab-ok.json';
import labDegraded from '../../../contracts/ops-v1/fixtures/OpsStatus/lab-degraded.json';
import statusUnavailable from '../../../contracts/ops-v1/fixtures/OpsStatus/status-unavailable.json';
import guardNormal from '../../../contracts/ops-v1/fixtures/GuardState/normal.json';
import guardShedMail from '../../../contracts/ops-v1/fixtures/GuardState/shed-mail-hero.json';
import guardShedTodofy from '../../../contracts/ops-v1/fixtures/GuardState/shed-todofy.json';
import guardShedLab from '../../../contracts/ops-v1/fixtures/GuardState/shed-lab.json';
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
import type { Env } from '../src/env.ts';
import { declaredMethods as parseDeclared } from './declared-methods.ts';
import {
  CALLED_METHODS,
  CONSUMER_SCHEMA,
  asCanaryDelivery,
  asCanaryResult,
  asGuardState,
  asReceipt,
  asStartCanaryResult,
  asStatus,
  callOps,
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

function declaredMethods(name: 'MailHeroOps' | 'TodofyOps' | 'LabOps'): string[] {
  return parseDeclared(opsSource, name);
}

type Calls = { app: OpsApp; method: string; args: unknown[] }[];

/** A binding that records every property called on it and answers from `answers`. */
function recordingEnv(answers: Record<string, () => unknown>): { env: Pick<Env, 'MAIL_HERO' | 'TODOFY' | 'LAB'>; calls: Calls } {
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
  return { env: { MAIL_HERO: binding('mail-hero'), TODOFY: binding('todofy'), LAB: binding('lab') } as Pick<Env, 'MAIL_HERO' | 'TODOFY' | 'LAB'>, calls };
}

const guardInput = { level: 'shed', reason: 'quota_d1_rows_read', until: '2026-09-30T00:10:00.000Z' } as const;

type Wrapper = (env: Pick<Env, 'MAIL_HERO' | 'TODOFY' | 'LAB'>) => Promise<OpsCall<unknown>>;
const WRAPPERS: readonly { app: OpsApp; method: string; call: Wrapper; valid: unknown }[] = [
  { app: 'mail-hero', method: 'status', call: (env) => opsStatus(env, 'mail-hero'), valid: mailHeroOk },
  { app: 'mail-hero', method: 'setGuard', call: (env) => opsSetGuard(env, 'mail-hero', guardInput), valid: guardShedMail },
  { app: 'mail-hero', method: 'startCanary', call: (env) => opsStartCanary(env, { run_id: 'canary-2026-09-29' }), valid: startQueued },
  { app: 'mail-hero', method: 'canaryDelivery', call: (env) => opsCanaryDelivery(env, EVENT_ID), valid: deliveryDelivered },
  { app: 'todofy', method: 'status', call: (env) => opsStatus(env, 'todofy'), valid: todofyOk },
  { app: 'todofy', method: 'setGuard', call: (env) => opsSetGuard(env, 'todofy', guardInput), valid: guardShedTodofy },
  { app: 'todofy', method: 'canaryResult', call: (env) => opsCanaryResult(env, EVENT_ID), valid: resultOk },
  { app: 'todofy', method: 'reportOps', call: (env) => opsReportOps(env, reportDaily as never), valid: receiptStored },
  { app: 'lab', method: 'status', call: (env) => opsStatus(env, 'lab'), valid: labOk },
  { app: 'lab', method: 'setGuard', call: (env) => opsSetGuard(env, 'lab', guardInput), valid: guardShedLab },
];

describe('only methods ops-v1.ts declares', () => {
  it('lists exactly the declared methods per app', () => {
    expect([...CALLED_METHODS['mail-hero']].sort()).toEqual(declaredMethods('MailHeroOps'));
    expect([...CALLED_METHODS.todofy].sort()).toEqual(declaredMethods('TodofyOps'));
    expect([...CALLED_METHODS.lab].sort()).toEqual(declaredMethods('LabOps'));
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
    expect(WRAPPERS.filter((w) => w.app === 'lab').map((w) => w.method).sort()).toEqual(declaredMethods('LabOps'));
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
      expect(await wrapper.call({} as Pick<Env, 'MAIL_HERO' | 'TODOFY' | 'LAB'>)).toEqual({ ok: false, code: 'not_configured' });
      const bad = recordingEnv({ [wrapper.method]: () => ({ unexpected: true }) });
      expect(await wrapper.call(bad.env)).toEqual({ ok: false, code: 'invalid_output' });
      const huge = recordingEnv({ [wrapper.method]: () => ({ ...(wrapper.valid as object), padding: 'x'.repeat(40_000) }) });
      expect(await wrapper.call(huge.env)).toEqual({ ok: false, code: 'invalid_output' });
    }
    expect(await callOps(() => new Promise(() => undefined), asGuardState, 20)).toEqual({ ok: false, code: 'timeout' });
  });
});

describe('answers are validated against the contract schema', () => {
  it('accepts every valid fixture unchanged', () => {
    for (const status of [mailHeroOk, mailHeroDegraded, mailHeroMaintenance]) expect(asStatus('mail-hero')(status)).toEqual(status);
    for (const status of [todofyOk, todofyDegraded, statusUnavailable]) expect(asStatus('todofy')(status)).toEqual(status);
    expect(asStatus('todofy')(mailHeroOk)).toBeNull();
    for (const status of [labOk, labDegraded]) expect(asStatus('lab')(status)).toEqual(status);
    expect(asStatus('lab')(todofyOk)).toBeNull();
    for (const guard of [guardNormal, guardShedMail, guardShedTodofy, guardShedLab]) expect(asGuardState(guard)).toEqual(guard);
    for (const result of [startQueued, startPausedBlocked, startPausedSend, startMaintenance, startNoEndpoint]) {
      expect(asStartCanaryResult(result)).toEqual(result);
    }
    for (const d of [deliveryDelivered, deliveryFailedWindow, deliveryFailed, deliveryPausedBlocked, deliveryPaused, deliveryPendingFirst, deliveryPendingRetry, deliveryUnknown]) {
      expect(asCanaryDelivery(d)).toEqual(d);
    }
    for (const r of [resultFailed, resultNotSeen, resultOk, resultProcessingPaused, resultProcessing]) expect(asCanaryResult(r)).toEqual(r);
    for (const r of [receiptKept, receiptStored]) expect(asReceipt(r)).toEqual(r);
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
    OpsReportReceipt: asReceipt,
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
      if (read === undefined) continue; // inputs (SetGuardInput, StartCanaryInput, OpsReport) are ours
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
    // The widening is limited to those enums: the reference schema itself is unchanged.
    expect(validate(SCHEMA, 'CanaryResult', { state: 'processing', waiting_code: 'gemini_cooldown' })).not.toEqual([]);
    expect(validate(CONSUMER_SCHEMA, 'OpsStatus', { ...mailHeroOk, health: 'fine' })).not.toEqual([]);
  });
});

describe('where the bindings are used', () => {
  it('only ops-client.ts touches MAIL_HERO, TODOFY and LAB', () => {
    const sources = import.meta.glob('../src/*.ts', { query: '?raw', import: 'default', eager: true });
    const users = Object.entries(sources)
      .filter(([, text]) => /\.(MAIL_HERO|TODOFY|LAB)\b/.test(text))
      .map(([path]) => path.replace('../src/', ''));
    expect(users).toEqual(['ops-client.ts']);
  });

  it('never imports mail-hero/, todofy/ or lab/ code', () => {
    const sources = import.meta.glob('../src/*.ts', { query: '?raw', import: 'default', eager: true });
    for (const text of Object.values(sources)) {
      expect(text).not.toMatch(/from '(\.\.\/)+(mail-hero|todofy|lab)\//);
    }
  });
});
