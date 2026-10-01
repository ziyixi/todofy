/**
 * The value rules beyond the shared read cases (testdata/wire-profile-cases.json): a write checks them too, so a
 * producer bug never reaches the wire; a consumer passes on what it read (WriteOptions.lenient); errors name a path
 * and a rule, never the value; producers read bounds from the descriptors (fieldRules); and a service binding's
 * arguments follow (common.wire.v1.method).positional. test/python/test_wire_rules.py is the Python twin.
 */
import { create } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { file_prototest_v1_rules, Parcel_Status, ParcelSchema, ParcelService, TrackRequestSchema } from '../ts/prototest/v1/rules_pb.ts';
import { fieldRules, formatMatches, fromWire, fromWireArguments, toWire, toWireArguments, WireJsonError } from '../ts/wire-json.ts';

const sent = {
  status: Parcel_Status.SENT,
  code: 'box_1',
  trackingId: 'AB1234',
  attempts: 1,
  weights: { base: 1 },
};

describe('a write checks the rules', () => {
  test('a valid message is written', () => {
    expect(toWire(ParcelSchema, create(ParcelSchema, sent))).toEqual({
      status: 'sent',
      code: 'box_1',
      tracking_id: 'AB1234',
      attempts: 1,
      weights: { base: 1 },
    });
  });

  test.each([
    ['a format', { code: 'Box 1' }, 'code: does not match Code'],
    ['a case presence', { trackingId: undefined }, 'tracking_id: required when the discriminator is sent'],
    ['a case bound', { attempts: 0 }, 'attempts: below the minimum'],
    ['an open list (a producer keeps to it)', { status: Parcel_Status.LOST, trackingId: undefined, reason: 'burnt' }, 'reason: not an allowed value'],
    ['a map key', { weights: { base: 1, 'owner@example.com': 2 } }, 'weights{}: a key does not match Code'],
    ['a nested message', { lines: [{ sku: 'pen', quantity: 100 }] }, 'lines[0].quantity: above the maximum'],
  ])('%s', (_name, change, error) => {
    const message = create(ParcelSchema, { ...sent, ...change });
    expect(() => toWire(ParcelSchema, message)).toThrow(new WireJsonError(error));
  });

  test('an error names the path and the rule, never the value', () => {
    const message = create(ParcelSchema, { ...sent, weights: { base: 1, 'Mail from boss@example.com': 2 } });
    expect(() => toWire(ParcelSchema, message)).toThrow(WireJsonError);
    try {
      toWire(ParcelSchema, message);
    } catch (error) {
      expect(String(error)).not.toContain('boss');
    }
  });

  test('a consumer passes on a value of an open list it read (lenient write), never a broken format', () => {
    const read = fromWire(ParcelSchema, { status: 'lost', code: 'box_1', tracking_id: null, attempts: 2, reason: 'burnt', weights: { base: 1 } });
    expect(toWire(ParcelSchema, read.message, { lenient: true }).reason).toBe('burnt');
    expect(() => toWire(ParcelSchema, read.message)).toThrow(WireJsonError);
    expect(() => toWire(ParcelSchema, create(ParcelSchema, { ...read.message, reason: 'Burnt' }), { lenient: true })).toThrow(WireJsonError);
  });
});

describe('producers read bounds from the descriptors', () => {
  test('fieldRules answers what the .proto file states', () => {
    expect(fieldRules(ParcelSchema.field.tags).maxItems).toBe(3);
    expect(fieldRules(ParcelSchema.field.weights).requiredKeys).toEqual(['base']);
    expect(fieldRules(ParcelSchema.field.score).maximum).toBe(1);
    // A field without rules answers the defaults.
    expect(fieldRules(ParcelSchema.field.counts).maxItems).toBe(0);
  });

  test('formatMatches checks a value against a file\'s format, anchored, with its length', () => {
    expect(formatMatches(file_prototest_v1_rules, 'Code', 'box_1')).toBe(true);
    for (const value of ['Box', 'box\n', '', 'a'.repeat(17)]) expect(formatMatches(file_prototest_v1_rules, 'Code', value), value).toBe(false);
    expect(formatMatches(file_prototest_v1_rules, 'Tracking', 'AB123456')).toBe(true);
    expect(formatMatches(file_prototest_v1_rules, 'Tracking', 'AB1234567')).toBe(false);
    expect(() => formatMatches(file_prototest_v1_rules, 'Nope', 'x')).toThrow(/no format Nope/);
  });
});

describe('service binding arguments', () => {
  test('a positional method passes its fields, an empty one nothing', () => {
    expect(toWireArguments(ParcelService.method.ping, create(ParcelService.method.ping.input))).toEqual([]);
    expect(toWireArguments(ParcelService.method.track, create(TrackRequestSchema, { trackingId: 'AB1234', attempts: 2 }))).toEqual(['AB1234', 2]);
    // An implicit field at its default is omitted on the wire: an absent (undefined) argument.
    expect(toWireArguments(ParcelService.method.track, create(TrackRequestSchema, { trackingId: 'AB1234' }))).toEqual(['AB1234', undefined]);
  });

  test('any other method passes its request as one wire object', () => {
    expect(toWireArguments(ParcelService.method.send, create(ParcelSchema, sent))).toEqual([toWire(ParcelSchema, create(ParcelSchema, sent))]);
  });

  test('a receiver reads the arguments strictly, with the rules', () => {
    expect(fromWireArguments(ParcelService.method.track, ['AB1234']).trackingId).toBe('AB1234');
    expect(fromWireArguments(ParcelService.method.track, ['AB1234', 3]).attempts).toBe(3);
    expect(fromWireArguments(ParcelService.method.ping, []).$typeName).toBe('prototest.v1.PingRequest');
    for (const args of [[], ['ab1234'], [7], ['AB1234', 1, 'extra'], ['AB1234', -1]]) {
      expect(() => fromWireArguments(ParcelService.method.track, args), JSON.stringify(args)).toThrow(WireJsonError);
    }
    expect(() => fromWireArguments(ParcelService.method.ping, ['x'])).toThrow(WireJsonError);
    expect(fromWireArguments(ParcelService.method.send, [toWire(ParcelSchema, create(ParcelSchema, sent))]).code).toBe('box_1');
    expect(() => fromWireArguments(ParcelService.method.send, [])).toThrow(WireJsonError);
    expect(() => fromWireArguments(ParcelService.method.send, [{ ...toWire(ParcelSchema, create(ParcelSchema, sent)), extra: 1 }])).toThrow(WireJsonError);
  });
});
