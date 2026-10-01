/**
 * The wire JSON profile (proto/README.md): maps a protobuf-es message to the JSON the v1 contracts send
 * and back, driven only by the message descriptor. Hand-written runtime of the generated code; its Python
 * twin is proto/python/ziyixi_proto/wire_json.py, and both must give the same results on the same input
 * (proto/testdata/wire-profile-cases.json runs in both test suites).
 *
 * Differences from ProtoJSON (https://protobuf.dev/programming-guides/json/):
 *
 * - Field names are the proto field names (snake_case), never the lowerCamelCase json_name.
 * - An enum value is written as its name without the enum's prefix, in lower case
 *   (STATE_NOT_FOUND is "not_found"); the zero value (*_UNSPECIFIED) is never written.
 * - A field with (google.api.field_behavior) = REQUIRED is always written: as null when it has no
 *   value (an unset `optional` field, or an enum at *_UNSPECIFIED). Any other unset field is omitted.
 * - google.protobuf.Timestamp is RFC 3339 UTC with 0-3 fraction digits (the v1 schema's pattern), and
 *   must be a real calendar time (no 02-30, 24:00 or leap second). It is written in one canonical form:
 *   no fraction for a whole second, else exactly 3 digits ("07.5Z" reads and writes as "07.500Z").
 * - An integer is a JSON number with a zero fractional part (JSON Schema's rule), so 1.0 and 1e0 read
 *   as 1: JSON.parse cannot tell them apart, and the Python twin follows the same rule.
 * - Fields are written in field-number order, which the IDL keeps equal to the JSON Schema order, so
 *   `JSON.stringify` gives the same bytes as today's producers.
 * - A double is a finite JSON number (NaN and the infinities are refused: JSON has no spelling for them).
 *   JSON.stringify writes it in its shortest form. The Python twin writes the same value, and the same
 *   bytes for an integral value below 2^53 (as an integer) and for 1e-4 <= |x| < 1e16; outside that
 *   range the spelling of the exponent may differ (1e-05 against 0.00001).
 * - A map (string keys only) is a JSON object in one canonical order, whatever order its entries were set
 *   in: its keys are set in code point order, and JavaScript then puts array-index keys ("10") first in
 *   numeric order (OrdinaryOwnPropertyKeys), which the Python twin reproduces, so both write the same
 *   bytes. A REQUIRED map is written as {} when empty. A map value is never null.
 *
 * Reading has two modes, matching the contracts' rule "inputs closed, outputs open":
 *
 * - `strict` (a producer's input, e.g. Todofy reading a TaskIntent): an unknown field, an unknown
 *   enum name, a wrong type, null or a missing REQUIRED field throws WireJsonError.
 * - lenient (a consumer reading an output, e.g. Lab reading a TaskIntentResult): an unknown field is
 *   skipped and an unknown enum name reads as the zero value, so a switch takes its default branch.
 *   Both are reported in `unrecognized` (field paths only, never values) for logs and metrics. A wrong
 *   type or a missing REQUIRED field still throws: REQUIRED means "always written", so its absence is
 *   a broken producer, not a newer one (proto/tools/profile_breaking.py keeps it that way in CI). null
 *   reads as "no value" only where toWire writes it (a REQUIRED enum, message or scalar with explicit
 *   presence); anywhere else (`"recorded": null`, a list, a map, a field that is omitted when unset) it
 *   is a wrong type. An unrecognized map value is reported as the map's path with `{}` (`decisions{}`):
 *   a map key is data, and paths never carry data.
 *
 * Enum names are matched exactly against a table of the wire names (no case folding: "ſubtasks" is not
 * "subtasks"). Value rules (lengths, ranges, patterns) are not part of the profile: each consumer keeps
 * the value rules of its contract (proto/README.md, Wire JSON profile).
 *
 * Only the field kinds the contracts use are supported: string, bool, 32-bit integers, double, enums,
 * messages, repeated fields, maps with string keys and Timestamp. Anything else (64-bit integers, float,
 * bytes, oneofs, other well-known types) throws, so a new kind cannot slip through.
 */
import {
  create,
  getOption,
  ScalarType,
  type DescEnum,
  type DescField,
  type DescMessage,
  type DescService,
  type JsonObject,
  type JsonValue,
  type Message,
  type MessageShape,
} from '@bufbuild/protobuf';
import { reflect, type ReflectMessage } from '@bufbuild/protobuf/reflect';
import { timestampDate, timestampFromDate, TimestampSchema } from '@bufbuild/protobuf/wkt';
import { field_behavior, FieldBehavior } from './google/api/field_behavior_pb.ts';

export class WireJsonError extends Error {}

export interface ReadOptions {
  /** Refuse unknown fields and enum names (inputs). Default false (outputs). */
  readonly strict?: boolean;
}

export interface ReadResult<T> {
  readonly message: T;
  /** Paths of skipped fields and of enum names read as the zero value (lenient mode only). */
  readonly unrecognized: readonly string[];
}

/**
 * A message in wire JSON as it crosses a Workers RPC boundary (a structured clone of the contract's JSON
 * object): the receiver reads it with `fromWire`, and `toWire`'s `JsonObject` is one. Its values are
 * `unknown`, not `JsonValue`: that recursive type is too deep for the RPC types of @cloudflare/workers-types.
 */
export type WireObject = { readonly [key: string]: unknown };

/**
 * A proto service as the methods of a Workers RPC entrypoint (a service binding, not gRPC): one method per
 * rpc, named as protobuf-es names it (`rpc ProposeTasks` is `proposeTasks`), taking and answering wire JSON
 * objects. The caller writes its input with `toWire` and reads the answer with `fromWire` (lenient: it is
 * an output); the implementation reads its input with `fromWire` (strict). Both stay plain JSON values, so
 * a structured clone carries exactly the contract's JSON.
 *
 *   interface TodofyIntents extends Rpc.WorkerEntrypointBranded, WireService<typeof TaskIntentService> {}
 */
export type WireService<S extends DescService> = {
  [M in keyof S['method']]: (input: WireObject) => Promise<WireObject>;
};

/**
 * The wire names of a generated enum object (`typeof State`): its member names (protobuf-es strips the
 * prefix) without the zero value, in lower case. `WireName<typeof Mode>` is `'subtasks' | 'separate'`.
 */
export type WireName<E extends Readonly<Record<string, number>>> = Lowercase<Exclude<keyof E & string, 'UNSPECIFIED'>>;

/** One enum's wire names and values (`wireEnum`), the same table the codec reads and writes with. */
export interface WireEnum<E extends Readonly<Record<string, number>>> {
  /** Every wire name, in value order. */
  readonly names: readonly WireName<E>[];
  /** The wire name of `value`: null for the zero value and for a number this build does not know. */
  name(value: number): WireName<E> | null;
  /** The value of a wire name (exact match), or undefined for a name this build does not know. */
  value(name: string): E[keyof E] | undefined;
}

const RFC3339_UTC = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?Z$/;
const requiredCache = new WeakMap<DescField, boolean>();
const wireTables = new WeakMap<DescEnum, ReadonlyMap<string, number>>();
/** FeatureSet.FieldPresence.IMPLICIT: a proto3 field without `optional` (unset means default). */
const IMPLICIT = 2;

/** Whether toWire writes null for `field` when it has no value: a REQUIRED enum, message or explicit-presence scalar. */
function nullable(field: DescField): boolean {
  const kind = field.fieldKind === 'enum' || field.fieldKind === 'message' || (field.fieldKind === 'scalar' && field.presence !== IMPLICIT);
  return kind && required(field);
}

function required(field: DescField): boolean {
  let value = requiredCache.get(field);
  if (value === undefined) {
    value = getOption(field, field_behavior).includes(FieldBehavior.REQUIRED);
    requiredCache.set(field, value);
  }
  return value;
}

function enumToWire(field: DescField, desc: DescEnum | undefined, number: number): string | null {
  if (desc === undefined) throw new WireJsonError('not an enum');
  if (number === 0) return null;
  const value = desc.value[number];
  // An open enum may hold a number this build does not know (binary input from a newer producer):
  // there is no wire name for it, so writing it is a bug in the caller.
  if (value === undefined) throw new WireJsonError(`${field.name}: no wire name for enum number ${String(number)}`);
  return value.name.slice((desc.sharedPrefix ?? '').length).toLowerCase();
}

/** Wire name -> number for every value but the zero value (names are ASCII: buf lint enforces it). */
function wireTable(desc: DescEnum): ReadonlyMap<string, number> {
  let table = wireTables.get(desc);
  if (table === undefined) {
    const prefix = (desc.sharedPrefix ?? '').length;
    table = new Map(desc.values.filter((v) => v.number !== 0).map((v) => [v.name.slice(prefix).toLowerCase(), v.number]));
    wireTables.set(desc, table);
  }
  return table;
}

function enumFromWire(desc: DescEnum | undefined, text: string): number | undefined {
  if (desc === undefined) throw new WireJsonError('not an enum');
  // An exact lookup: "PENDING", "STATE_PENDING" or a Unicode look-alike such as "pendıng" is not a v1 value.
  return wireTable(desc).get(text);
}

/**
 * The wire names of the enum `desc` (its `GenEnum` schema) typed by its generated object `values`, e.g.
 * `wireEnum(ModeSchema, Mode)`. For code that stores or shows wire names outside a message (a database
 * column, an owner API); messages go through toWire/fromWire. Throws when the object and the descriptor
 * disagree, which only a mismatched pair of arguments can cause.
 */
export function wireEnum<const E extends Readonly<Record<string, number>>>(desc: DescEnum, values: E): WireEnum<E> {
  const table = wireTable(desc);
  const members = Object.entries(values).filter(([key]) => key !== 'UNSPECIFIED');
  if (members.length !== table.size || members.some(([key, number]) => table.get(key.toLowerCase()) !== number)) {
    throw new WireJsonError(`${desc.typeName}: the generated object does not match the descriptor`);
  }
  const names = new Map([...table].map(([name, number]) => [number, name as WireName<E>]));
  return {
    names: [...names.values()],
    name: (value) => names.get(value) ?? null,
    value: (name) => table.get(name) as E[keyof E] | undefined,
  };
}

/** The canonical RFC 3339 form of a wire timestamp, or undefined when it is not a real UTC time. */
function timestampFromWire(text: string): Date | undefined {
  const match = RFC3339_UTC.exec(text);
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const millis = Number((match[7] ?? '').padEnd(3, '0'));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  // Date rolls 02-30 over to 03-02 and 24:00 to the next day: refuse anything that did not stay put.
  const exact =
    year >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  return exact ? date : undefined;
}

function scalarToWire(field: DescField, scalar: ScalarType | undefined, value: unknown): JsonValue {
  switch (scalar) {
    // A message built in code is not checked by protobuf-es (create() takes any number for an int32): the
    // writer refuses what a reader would refuse, so a producer bug never reaches the wire.
    case ScalarType.STRING:
      if (typeof value !== 'string') throw new WireJsonError(`${field.name}: not a string`);
      return value;
    case ScalarType.BOOL:
      if (typeof value !== 'boolean') throw new WireJsonError(`${field.name}: not a boolean`);
      return value;
    case ScalarType.INT32:
    case ScalarType.SINT32:
    case ScalarType.SFIXED32:
      if (!(typeof value === 'number' && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff)) throw new WireJsonError(`${field.name}: not an int32`);
      return value;
    case ScalarType.UINT32:
    case ScalarType.FIXED32:
      if (!(typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff)) throw new WireJsonError(`${field.name}: not a uint32`);
      return value;
    case ScalarType.DOUBLE:
      // JSON.stringify would write null for these; refusing keeps a typo from turning into "no value".
      if (!Number.isFinite(value)) throw new WireJsonError(`${field.name}: not a finite number`);
      // -0 is written as 0 by JSON.stringify; Python writes the same bytes.
      return value as number;
    default:
      throw new WireJsonError(`${field.name}: scalar type ${String(scalar)} is not in the profile`);
  }
}

function scalarFromWire(scalar: ScalarType | undefined, value: JsonValue, path: string): string | boolean | number {
  switch (scalar) {
    case ScalarType.STRING:
      if (typeof value === 'string') return value;
      break;
    case ScalarType.BOOL:
      if (typeof value === 'boolean') return value;
      break;
    case ScalarType.INT32:
    case ScalarType.SINT32:
    case ScalarType.SFIXED32:
      if (typeof value === 'number' && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff) return value;
      break;
    case ScalarType.UINT32:
    case ScalarType.FIXED32:
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff) return value;
      break;
    case ScalarType.DOUBLE:
      // JSON.parse never yields NaN or an infinity; the check keeps a hand-built input to the same rule.
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      break;
    default:
      throw new WireJsonError(`${path}: scalar type ${String(scalar)} is not in the profile`);
  }
  throw new WireJsonError(`${path}: wrong type`);
}

/** The wire JSON object of `message` (a plain object; JSON.stringify gives the wire bytes). */
export function toWire<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>): JsonObject {
  return writeMessage(reflect(schema, message));
}

function writeMessage(r: ReflectMessage): JsonObject {
  const out: JsonObject = {};
  for (const field of [...r.fields].sort((a, b) => a.number - b.number)) {
    const set = r.isSet(field);
    const always = required(field);
    switch (field.fieldKind) {
      case 'scalar': {
        if (set) out[field.name] = scalarToWire(field, field.scalar, r.get(field));
        else if (always) out[field.name] = field.presence === IMPLICIT ? scalarToWire(field, field.scalar, r.get(field)) : null;
        break;
      }
      case 'enum': {
        const wire = set ? enumToWire(field, field.enum, r.get(field) as number) : null;
        if (wire !== null) out[field.name] = wire;
        else if (always) out[field.name] = null;
        break;
      }
      case 'message': {
        if (set) out[field.name] = messageToWire(r.get(field) as ReflectMessage);
        else if (always) out[field.name] = null;
        break;
      }
      case 'list': {
        const list = r.get(field);
        const items: JsonValue[] = [];
        for (const item of list) {
          if (field.listKind === 'message') items.push(messageToWire(item as ReflectMessage));
          else if (field.listKind === 'enum') items.push(enumToWire(field, field.enum, item as number));
          else items.push(scalarToWire(field, field.scalar, item));
        }
        if (items.length > 0 || always) out[field.name] = items;
        break;
      }
      case 'map': {
        if (field.mapKey !== ScalarType.STRING) throw new WireJsonError(`${field.name}: only string map keys are in the profile`);
        const map = r.get(field);
        const entries: [string, JsonValue][] = [];
        for (const [key, value] of map) {
          const wire =
            field.mapKind === 'message'
              ? messageToWire(value as ReflectMessage)
              : field.mapKind === 'enum'
                ? enumToWire(field, field.enum, value as number)
                : scalarToWire(field, field.scalar, value);
          // A map entry always has a value: the zero enum value has no wire name, so it cannot be written.
          if (wire === null) throw new WireJsonError(`${field.name}: a map value cannot be the zero enum value`);
          entries.push([key as string, wire]);
        }
        if (entries.length > 0 || always) out[field.name] = Object.fromEntries(entries.sort(([a], [b]) => compareCodePoints(a, b)));
        break;
      }
      default:
        throw new WireJsonError(`${(field as DescField).name}: this field kind is not in the profile`);
    }
  }
  return out;
}

function messageToWire(value: ReflectMessage): JsonValue {
  if (value.desc.typeName === TimestampSchema.typeName) {
    return timestampDate(value.message as MessageShape<typeof TimestampSchema>).toISOString().replace(/\.000Z$/, 'Z');
  }
  return writeMessage(value);
}

/**
 * Orders strings by Unicode code point, as Python's sorted() does (UTF-16 order differs above U+FFFF). The object
 * built from the sorted entries still lists array-index keys first (see the module comment).
 */
function compareCodePoints(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const diff = (left[i]?.codePointAt(0) ?? 0) - (right[i]?.codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/** Reads wire JSON (a parsed value) into a message of `schema`. */
export function fromWire<Desc extends DescMessage>(schema: Desc, json: unknown, options: ReadOptions = {}): ReadResult<MessageShape<Desc>> {
  const unrecognized: string[] = [];
  const message = readMessage(schema, json, '', options.strict === true, unrecognized) as MessageShape<Desc>;
  return { message, unrecognized };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMessage(schema: DescMessage, json: unknown, path: string, strict: boolean, unrecognized: string[]): Message {
  if (!isObject(json)) throw new WireJsonError(`${path || '$'}: not an object`);
  const message = create(schema);
  const r = reflect(schema, message);
  const byName = new Map(schema.fields.map((f) => [f.name, f]));
  for (const [key, value] of Object.entries(json)) {
    const at = path === '' ? key : `${path}.${key}`;
    const field = byName.get(key);
    if (field === undefined) {
      if (strict) throw new WireJsonError(`${at}: unknown field`);
      unrecognized.push(at);
      continue;
    }
    if (value === null) {
      // null is how outputs write "no value"; inputs omit the field instead (contracts' rule), so a
      // strict (input) reader refuses null. A lenient reader takes it only where toWire can write it.
      if (strict) throw new WireJsonError(`${at}: null`);
      if (!nullable(field)) throw new WireJsonError(`${at}: wrong type`);
      continue;
    }
    switch (field.fieldKind) {
      case 'scalar':
        r.set(field, scalarFromWire(field.scalar, value, at));
        break;
      case 'enum': {
        const number = readEnum(field.enum, value, at, strict, unrecognized);
        if (number !== undefined) r.set(field, number);
        break;
      }
      case 'message':
        r.set(field, readValueMessage(field.message, value, at, strict, unrecognized));
        break;
      case 'list': {
        if (!Array.isArray(value)) throw new WireJsonError(`${at}: not an array`);
        const list = r.get(field);
        value.forEach((item: JsonValue, i) => {
          const itemAt = `${at}[${String(i)}]`;
          if (field.listKind === 'message') list.add(readValueMessage(field.message, item, itemAt, strict, unrecognized));
          else if (field.listKind === 'enum') {
            const number = readEnum(field.enum, item, itemAt, strict, unrecognized);
            if (number !== undefined) list.add(number);
          } else list.add(scalarFromWire(field.scalar, item, itemAt));
        });
        break;
      }
      case 'map': {
        if (field.mapKey !== ScalarType.STRING) throw new WireJsonError(`${at}: only string map keys are in the profile`);
        if (!isObject(value)) throw new WireJsonError(`${at}: not an object`);
        const map = r.get(field);
        // Paths never carry data, and a map key is data: an entry's path is the map's, with `{}`.
        const entryAt = `${at}{}`;
        for (const [entryKey, item] of Object.entries(value)) {
          if (item === null) throw new WireJsonError(`${entryAt}: wrong type`);
          if (field.mapKind === 'message') map.set(entryKey, readValueMessage(field.message, item, entryAt, strict, unrecognized));
          else if (field.mapKind === 'enum') {
            const number = readEnum(field.enum, item, entryAt, strict, unrecognized);
            if (number !== undefined) map.set(entryKey, number);
          } else map.set(entryKey, scalarFromWire(field.scalar, item, entryAt));
        }
        break;
      }
      default:
        throw new WireJsonError(`${at}: this field kind is not in the profile`);
    }
  }
  for (const field of schema.fields) {
    if (required(field) && !Object.hasOwn(json, field.name)) {
      throw new WireJsonError(`${path === '' ? field.name : `${path}.${field.name}`}: missing`);
    }
  }
  return message;
}

/** An enum value: its number, or undefined for a name this build does not know (lenient reads only). */
function readEnum(desc: DescEnum | undefined, value: JsonValue, at: string, strict: boolean, unrecognized: string[]): number | undefined {
  if (typeof value !== 'string') throw new WireJsonError(`${at}: wrong type`);
  const number = enumFromWire(desc, value);
  if (number === undefined) {
    if (strict) throw new WireJsonError(`${at}: unknown enum value`);
    unrecognized.push(at);
  }
  return number;
}

/** A message-typed value (a field, a list item or a map value), Timestamp included. */
function readValueMessage(desc: DescMessage, value: JsonValue, at: string, strict: boolean, unrecognized: string[]): ReflectMessage {
  if (desc.typeName === TimestampSchema.typeName) {
    const date = typeof value === 'string' ? timestampFromWire(value) : undefined;
    if (date === undefined) throw new WireJsonError(`${at}: not an RFC 3339 UTC timestamp`);
    return reflect(TimestampSchema, timestampFromDate(date));
  }
  return reflect(desc, readMessage(desc, value, at, strict, unrecognized));
}
