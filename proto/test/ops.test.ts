/**
 * ops/v1/ops.proto is the IDL of contracts/ops-v1 (test/python/test_ops.py is the Python twin): every fixture is
 * the bytes the codec writes (the file itself, pretty-printed, after a read and a write, strict and lenient); a
 * strict read refuses every invalid fixture, as the generated JSON Schema does; a lenient read (the dashboard's)
 * tolerates exactly what ops-v1's consumer rules allow; the services declare each app's entrypoint methods and
 * how they take their arguments; and the generated wire types are what toWire answers.
 */
import { create, getOption, type DescMessage } from '@bufbuild/protobuf';
import { closed } from '../ts/common/wire/v1/wire_pb.ts';
import { field_behavior, FieldBehavior } from '../ts/google/api/field_behavior_pb.ts';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, test } from 'vitest';
import * as ops from '../ts/ops/v1/ops_pb.ts';
import type * as wire from '../ts/ops/v1/ops_wire.ts';
import { fieldRules, fromWire, fromWireArguments, toWire, toWireArguments, wireEnum, WireJsonError } from '../ts/wire-json.ts';
import { fixtures, OPS_CONTRACT } from './fixtures.ts';

/** Every message a fixture directory names (its $defs name), by that name. */
const MESSAGES: Record<string, DescMessage> = {
  CanaryDelivery: ops.CanaryDeliverySchema,
  CanaryResult: ops.CanaryResultSchema,
  GuardState: ops.GuardStateSchema,
  OpsReport: ops.OpsReportSchema,
  OpsReportReceipt: ops.OpsReportReceiptSchema,
  OpsStatus: ops.OpsStatusSchema,
  SetGuardInput: ops.SetGuardInputSchema,
  StartCanaryInput: ops.StartCanaryInputSchema,
  StartCanaryResult: ops.StartCanaryResultSchema,
};

/**
 * The invalid fixtures a lenient read (a consumer) accepts, and why: ops-v1's consumers ignore fields they do not
 * know and keep a newer code of an open list as read (an app's name included: OpsStatus.app is open, so a dashboard
 * reads the status of an app that joined after it was built; it keeps only the answer of the app it called). Every other invalid fixture breaks a rule a consumer keeps too:
 * a newer value of one of ops-v1's enums (all closed, (common.wire.v1.closed)) and a null REQUIRED enum or message
 * (non_null) included.
 */
const LENIENT: Record<string, readonly string[]> = {
  'CanaryResult/ok-with-summary.json': ['summary'],
  'OpsReport/item-with-text.json': ['items[0].text'],
  'OpsStatus/extra-field-subject.json': ['subject'],
  'OpsStatus/unknown-app.json': [],
  'StartCanaryInput/extra-field.json': ['to'],
  'StartCanaryResult/unknown-reason.json': [],
};

const defs = (dir: string): string[] => readdirSync(dir).filter((name) => name !== 'invalid').sort();

describe('the fixtures are the codec’s bytes', () => {
  test('every fixture directory is a message of ops.v1', () => {
    expect(defs(join(OPS_CONTRACT, 'fixtures'))).toEqual(Object.keys(MESSAGES).sort());
    for (const def of defs(join(OPS_CONTRACT, 'fixtures', 'invalid'))) expect(MESSAGES).toHaveProperty(def);
  });

  test.each(Object.keys(MESSAGES))('%s: every valid fixture round-trips, file bytes included, both ways of reading', (def) => {
    const schema = MESSAGES[def] as DescMessage;
    const valid = fixtures(def, false, OPS_CONTRACT);
    expect(valid.length).toBeGreaterThan(0);
    for (const { name, text, value } of valid) {
      for (const strict of [true, false]) {
        const read = fromWire(schema, value, { strict });
        expect(read.unrecognized, name).toEqual([]);
        const written = toWire(schema, read.message);
        expect(`${JSON.stringify(written, null, 2)}\n`, `${def}/${name} strict=${String(strict)}`).toBe(text);
      }
    }
  });
});

describe('the rules give the contract’s verdicts', () => {
  const invalid = Object.keys(MESSAGES).flatMap((def) =>
    fixtures(def, true, OPS_CONTRACT).map((f) => ({ ...f, def, key: `${def}/${f.name}` })),
  );

  test('a strict read (a producer’s view, the generated JSON Schema’s) refuses every invalid fixture', () => {
    expect(invalid.length).toBeGreaterThanOrEqual(28);
    for (const { def, key, value } of invalid) {
      expect(() => fromWire(MESSAGES[def] as DescMessage, value, { strict: true }), key).toThrow(WireJsonError);
    }
  });

  test('a lenient read (a consumer’s) tolerates exactly what ops-v1’s consumer rules allow', () => {
    for (const { def, key, value } of invalid) {
      const schema = MESSAGES[def] as DescMessage;
      const tolerated = LENIENT[key];
      if (tolerated === undefined) {
        expect(() => fromWire(schema, value), key).toThrow(WireJsonError);
        continue;
      }
      expect(fromWire(schema, value).unrecognized, key).toEqual(tolerated);
    }
  });

  test('a privacy leak is refused by a consumer too: names are codes, metrics numbers, URLs plain https', () => {
    const status = fixtures('OpsStatus', false, OPS_CONTRACT)[0]?.value as Record<string, unknown>;
    for (const leak of [
      { counters: { 'owner@example.com': 1 } },
      { modes: { maintenance: false, 'Subject: hi': true } },
      { capabilities: ['Mail from bob'] },
      { signals: [{ code: 'parse_failed', severity: 'warning', metrics: { count: 'Subject: Your invoice' } }] },
      { ui_url: 'https://mail.example.com/?token=secret' },
    ]) {
      expect(() => fromWire(ops.OpsStatusSchema, { ...status, ...leak }), JSON.stringify(Object.keys(leak))).toThrow(WireJsonError);
    }
  });
});

describe('the services are each app’s entrypoint', () => {
  test('methods by service, and how a binding passes their arguments', () => {
    const methods = (service: { method: Record<string, { name: string }> }): string[] => Object.keys(service.method);
    // Every app: status, setGuard. Mail Hero: the canary producer; Todofy: the consumer and the digest.
    expect(methods(ops.OpsService)).toEqual(['status', 'setGuard']);
    expect(methods(ops.CanaryProducerService)).toEqual(['startCanary', 'canaryDelivery']);
    expect(methods(ops.CanaryConsumerService)).toEqual(['canaryResult']);
    expect(methods(ops.OpsDigestService)).toEqual(['reportOps']);
    const eventId = '6d3b2f0e-4c1a-4b7e-8a52-0c9e7f1d2a31';
    expect(toWireArguments(ops.OpsService.method.status, create(ops.StatusRequestSchema))).toEqual([]);
    expect(toWireArguments(ops.CanaryProducerService.method.canaryDelivery, create(ops.CanaryDeliveryRequestSchema, { eventId }))).toEqual([eventId]);
    expect(fromWireArguments(ops.CanaryConsumerService.method.canaryResult, [eventId]).eventId).toBe(eventId);
    expect(() => fromWireArguments(ops.CanaryConsumerService.method.canaryResult, ['NOT-A-UUID'])).toThrow(WireJsonError);
    const input = { level: 'normal', reason: 'quota_recovered', until: null };
    expect(toWireArguments(ops.OpsService.method.setGuard, fromWireArguments(ops.OpsService.method.setGuard, [input]))).toEqual([input]);
  });

  test('the bounds producers read are the contract’s', () => {
    expect(fieldRules(ops.OpsStatusSchema.field.signals).maxItems).toBe(16);
    expect(fieldRules(ops.OpsStatusSchema.field.counters).maxItems).toBe(32);
    expect(fieldRules(ops.SignalSchema.field.metrics).maxItems).toBe(12);
    expect(fieldRules(ops.OpsReportSchema.field.items).maxItems).toBe(20);
    expect(fieldRules(ops.OpsStatusSchema.field.app).allowed).toEqual(['mail-hero', 'todofy', 'lab', 'watch', 'fleet', 'newsletter']);
    expect(wireEnum(ops.ErrorCodeSchema, ops.ErrorCode).names).toEqual(['invalid_input', 'busy', 'unavailable']);
    expect(wireEnum(ops.GuardLevelSchema, ops.GuardLevel).names).toEqual(['normal', 'shed']);
  });

  test('a receipt counts at most the items a report holds (one bound, read from the report)', () => {
    // A stored report of N items answers item_count N: the receipt's bound must follow the report's.
    expect(fieldRules(ops.OpsReportReceiptSchema.field.itemCount).maximum).toBe(fieldRules(ops.OpsReportSchema.field.items).maxItems);
  });

  test('every REQUIRED enum and message is non_null and every enum on the wire is closed', () => {
    // ops-v1 never wrote null for one (the hand-written schema refused it), and the dashboard branches on every value.
    const checked: string[] = [];
    for (const message of ops.file_ops_v1_ops.messages) {
      for (const field of message.fields) {
        if (field.fieldKind === 'enum') expect(getOption(field.enum, closed), field.enum.typeName).toBe(true);
        const required = getOption(field, field_behavior).includes(FieldBehavior.REQUIRED);
        if ((field.fieldKind === 'enum' || field.fieldKind === 'message') && required && !field.proto.proto3Optional) {
          expect(fieldRules(field).nonNull, `${message.typeName}.${field.name}`).toBe(true);
          checked.push(`${message.name}.${field.name}`);
        }
      }
    }
    expect(checked).toHaveLength(9);
  });

  test('a producer cannot write null for a REQUIRED enum or message', () => {
    expect(() => toWire(ops.CanaryDeliverySchema, create(ops.CanaryDeliverySchema, { attempts: 0 }))).toThrow(new WireJsonError('state: required'));
    expect(() => toWire(ops.CanaryResultSchema, create(ops.CanaryResultSchema, {}))).toThrow(new WireJsonError('state: required'));
    expect(() => toWire(ops.StartCanaryResultSchema, create(ops.StartCanaryResultSchema, {}))).toThrow(new WireJsonError('state: required'));
    const status = fromWire(ops.OpsStatusSchema, fixtures('OpsStatus', false, OPS_CONTRACT)[0]?.value).message;
    expect(() => toWire(ops.OpsStatusSchema, create(ops.OpsStatusSchema, { ...status, health: ops.Health.UNSPECIFIED }))).toThrow(new WireJsonError('health: required'));
    expect(() => toWire(ops.OpsStatusSchema, create(ops.OpsStatusSchema, { ...status, guard: undefined }))).toThrow(new WireJsonError('guard: required'));
    const guard = create(ops.GuardStateSchema, { level: ops.GuardLevel.UNSPECIFIED });
    expect(() => toWire(ops.GuardStateSchema, guard)).toThrow(new WireJsonError('level: required'));
  });
});

describe('the generated wire types are what toWire answers', () => {
  test('a union narrows on its discriminator', () => {
    const delivery = toWire(ops.CanaryDeliverySchema, create(ops.CanaryDeliverySchema, { state: ops.CanaryDelivery_State.UNKNOWN }));
    expectTypeOf(delivery).toEqualTypeOf<wire.CanaryDelivery>();
    expect(delivery).toEqual({ state: 'unknown', attempts: 0 });
    if (delivery.state === 'delivered') expectTypeOf(delivery.delivered_at).toEqualTypeOf<string>();
    if (delivery.state === 'failed') expectTypeOf(delivery.error_code).toEqualTypeOf<string>();
    const start = toWire(ops.StartCanaryResultSchema, create(ops.StartCanaryResultSchema, { state: ops.StartCanaryResult_State.PAUSED, reason: 'send_paused' }));
    expect(start).toEqual({ event_id: null, state: 'paused', reason: 'send_paused' });
    if (start.state === 'queued') expectTypeOf(start.event_id).toEqualTypeOf<string>();
    else expectTypeOf(start.event_id).toEqualTypeOf<null>();
  });

  test('closed allowed lists are literal types, open ones strings, nullable fields null', () => {
    expectTypeOf<wire.OpsStatus['app']>().toEqualTypeOf<string>();
    expectTypeOf<wire.OpsStatus['version']>().toEqualTypeOf<'ops-v1'>();
    expectTypeOf<wire.OpsStatus['last_backup_at']>().toEqualTypeOf<string | null>();
    expectTypeOf<wire.OpsStatus['modes']['maintenance']>().toEqualTypeOf<boolean>();
    expectTypeOf<Extract<wire.CanaryResult, { state: 'processing' }>['waiting_code']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<wire.OpsService['status']>().toEqualTypeOf<() => Promise<wire.OpsStatus>>();
    expectTypeOf<wire.CanaryProducerService['canaryDelivery']>().toEqualTypeOf<(eventId: string) => Promise<wire.CanaryDelivery>>();
  });
});
