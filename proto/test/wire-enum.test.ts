/**
 * wireEnum and WireName (ts/wire-json.ts): the wire names of a generated enum outside a message, typed by the
 * generated object and read from the descriptor, so they are the codec's own table. The Python twin is
 * test/python/test_wire_enum.py (wire_name, wire_member).
 */
import { describe, expect, expectTypeOf, test } from 'vitest';
import { ErrorCode, ErrorCodeSchema, Mode, ModeSchema, State, StateSchema } from '../ts/todofy/taskintent/v1/task_intent_pb.ts';
import { wireEnum, WireJsonError, type WireName } from '../ts/wire-json.ts';
import { SCHEMA } from './fixtures.ts';

describe('wireEnum', () => {
  const modes = wireEnum(ModeSchema, Mode);
  const states = wireEnum(StateSchema, State);

  test('names are the JSON Schema enum, in value order', () => {
    expect(modes.names).toEqual(SCHEMA.$defs['Mode']?.enum);
    expect(states.names).toEqual(SCHEMA.$defs['State']?.enum);
    expect(wireEnum(ErrorCodeSchema, ErrorCode).names).toEqual(SCHEMA.$defs['ErrorCode']?.enum);
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
