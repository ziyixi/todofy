/**
 * wireEnum and WireName (ts/wire-json.ts): the wire names of a generated enum outside a message, typed by the
 * generated object and read from the descriptor, so they are the codec's own table. The Python twin is
 * test/python/test_wire_enum.py (wire_name, wire_member).
 */
import { describe, expect, expectTypeOf, test } from 'vitest';
import { ErrorCode, ErrorCodeSchema, Mode, ModeSchema, State, StateSchema } from '../ts/prototest/v1/intent_pb.ts';
import { wireEnum, WireJsonError, type WireName } from '../ts/wire-json.ts';

/** The wire names of prototest/v1/intent.proto's enums, in value order (the retired task-intent-v1's JSON Schema). */
const NAMES = {
  Mode: ['subtasks', 'separate'],
  State: ['pending', 'created', 'duplicate', 'paused', 'failed', 'rejected', 'not_found'],
  ErrorCode: [
    'maintenance', 'processing_paused', 'todoist_paused', 'todoist_blocked', 'backup_active', 'rate_limited', 'retry_wait',
    'todoist_rejected', 'todoist_result_unknown', 'intent_conflict', 'daily_limit', 'url_not_allowed', 'source_not_allowed',
  ],
};

describe('wireEnum', () => {
  const modes = wireEnum(ModeSchema, Mode);
  const states = wireEnum(StateSchema, State);

  test('names are the lower-case values without the prefix, in value order', () => {
    expect(modes.names).toEqual(NAMES.Mode);
    expect(states.names).toEqual(NAMES.State);
    expect(wireEnum(ErrorCodeSchema, ErrorCode).names).toEqual(NAMES.ErrorCode);
  });

  test('name and value are inverse; the zero value and unknown numbers have no name', () => {
    expect(modes.name(Mode.SUBTASKS)).toBe('subtasks');
    expect(modes.value('separate')).toBe(Mode.SEPARATE);
    expect(states.name(State.NOT_FOUND)).toBe('not_found');
    expect(states.name(State.UNSPECIFIED)).toBeNull();
    expect(states.name(99)).toBeNull();
  });

  test('a lookup is exact, like the codec', () => {
    for (const name of ['unspecified', 'SUBTASKS', 'MODE_SUBTASKS', 'ſubtasks', ' subtasks', '']) expect(modes.value(name), name).toBeUndefined();
  });

  test('refuses a generated object that is not the descriptor', () => {
    expect(() => wireEnum(ModeSchema, State)).toThrow(WireJsonError);
  });

  test('WireName is the union of the wire names', () => {
    expectTypeOf<WireName<typeof Mode>>().toEqualTypeOf<'subtasks' | 'separate'>();
    expectTypeOf(modes.name).returns.toEqualTypeOf<'subtasks' | 'separate' | null>();
  });
});
