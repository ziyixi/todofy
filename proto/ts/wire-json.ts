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
 *
 * Reading has two modes, matching the contracts' rule "inputs closed, outputs open":
 *
 * - `strict` (a producer's input, e.g. Todofy reading a TaskIntent): an unknown field, an unknown
 *   enum name, a wrong type, null or a missing REQUIRED field throws WireJsonError.
 * - lenient (a consumer reading an output, e.g. Lab reading a TaskIntentResult): an unknown field is
 *   skipped and an unknown enum name reads as the zero value, so a switch takes its default branch.
 *   Both are reported in `unrecognized` (field paths only, never values) for logs and metrics. A wrong
 *   type or a missing REQUIRED field still throws: REQUIRED means "always written", so its absence is
 *   a broken producer, not a newer one (proto/tools/profile_breaking.py keeps it that way in CI).
 *
 * Enum names are matched exactly against a table of the wire names (no case folding: "ſubtasks" is not
 * "subtasks"). Value rules (lengths, ranges, patterns) are not part of the profile: each consumer keeps
 * the value rules of its contract (proto/README.md, Wire JSON profile).
 *
 * Only the field kinds the contracts use are supported: scalars except 64-bit and bytes, enums,
 * messages, repeated fields and Timestamp. Anything else throws, so a new kind cannot slip through.
 */
import {
  create,
  getOption,
  ScalarType,
  type DescEnum,
  type DescField,
  type DescMessage,
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

type JsonObject = { [key: string]: JsonValue };

const RFC3339_UTC = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?Z$/;
const requiredCache = new WeakMap<DescField, boolean>();
const wireTables = new WeakMap<DescEnum, ReadonlyMap<string, number>>();
/** FeatureSet.FieldPresence.IMPLICIT: a proto3 field without `optional` (unset means default). */
const IMPLICIT = 2;

function required(field: DescField): boolean {
  let value = requiredCache.get(field);
  if (value === undefined) {
    value = getOption(field, field_behavior).includes(FieldBehavior.REQUIRED);
    requiredCache.set(field, value);
  }
  return value;
}

function prefixOf(field: DescField & { enum: { sharedPrefix?: string | undefined } }): string {
  return (field.enum.sharedPrefix ?? '').toUpperCase();
}

function enumToWire(field: DescField, number: number): string | null {
  if (field.enum === undefined) throw new WireJsonError('not an enum');
  if (number === 0) return null;
  const value = field.enum.value[number];
  // An open enum may hold a number this build does not know (binary input from a newer producer):
  // there is no wire name for it, so writing it is a bug in the caller.
  if (value === undefined) throw new WireJsonError(`${field.name}: no wire name for enum number ${String(number)}`);
  return value.name.slice(prefixOf(field as never).length).toLowerCase();
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

function enumFromWire(field: DescField, text: string): number | undefined {
  if (field.enum === undefined) throw new WireJsonError('not an enum');
  // An exact lookup: "PENDING", "STATE_PENDING" or a Unicode look-alike such as "pendıng" is not a v1 value.
  return wireTable(field.enum).get(text);
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

function scalarToWire(field: DescField, value: unknown): JsonValue {
  switch (field.scalar) {
    case ScalarType.STRING:
    case ScalarType.BOOL:
    case ScalarType.INT32:
    case ScalarType.UINT32:
    case ScalarType.SINT32:
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
      return value as JsonValue;
    default:
      throw new WireJsonError(`${field.name}: scalar type ${String(field.scalar)} is not in the profile`);
  }
}

function scalarFromWire(field: DescField, value: JsonValue, path: string): string | boolean | number {
  switch (field.scalar) {
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
    default:
      throw new WireJsonError(`${path}: scalar type ${String(field.scalar)} is not in the profile`);
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
        if (set) out[field.name] = scalarToWire(field, r.get(field));
        else if (always) out[field.name] = field.presence === IMPLICIT ? scalarToWire(field, r.get(field)) : null;
        break;
      }
      case 'enum': {
        const wire = set ? enumToWire(field, r.get(field) as number) : null;
        if (wire !== null) out[field.name] = wire;
        else if (always) out[field.name] = null;
        break;
      }
      case 'message': {
        if (set) {
          const value = r.get(field) as ReflectMessage;
          out[field.name] =
            field.message.typeName === TimestampSchema.typeName
              ? timestampDate(value.message as MessageShape<typeof TimestampSchema>).toISOString().replace(/\.000Z$/, 'Z')
              : writeMessage(value);
        } else if (always) {
          out[field.name] = null;
        }
        break;
      }
      case 'list': {
        const list = r.get(field);
        const items: JsonValue[] = [];
        for (const item of list) {
          if (field.listKind === 'message') items.push(writeMessage(item as ReflectMessage));
          else if (field.listKind === 'enum') items.push(enumToWire(field, item as number));
          else items.push(scalarToWire(field, item));
        }
        if (items.length > 0 || always) out[field.name] = items;
        break;
      }
      default:
        throw new WireJsonError(`${field.name}: ${field.fieldKind} fields are not in the profile`);
    }
  }
  return out;
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
      // strict (input) reader refuses null.
      if (strict) throw new WireJsonError(`${at}: null`);
      continue;
    }
    switch (field.fieldKind) {
      case 'scalar':
        r.set(field, scalarFromWire(field, value, at));
        break;
      case 'enum': {
        if (typeof value !== 'string') throw new WireJsonError(`${at}: wrong type`);
        const number = enumFromWire(field, value);
        if (number === undefined) {
          if (strict) throw new WireJsonError(`${at}: unknown enum value`);
          unrecognized.push(at);
        } else {
          r.set(field, number);
        }
        break;
      }
      case 'message':
        if (field.message.typeName === TimestampSchema.typeName) {
          const date = typeof value === 'string' ? timestampFromWire(value) : undefined;
          if (date === undefined) throw new WireJsonError(`${at}: not an RFC 3339 UTC timestamp`);
          r.set(field, reflect(TimestampSchema, timestampFromDate(date)));
        } else {
          r.set(field, reflect(field.message, readMessage(field.message, value, at, strict, unrecognized)));
        }
        break;
      case 'list': {
        if (!Array.isArray(value)) throw new WireJsonError(`${at}: not an array`);
        const list = r.get(field);
        value.forEach((item, i) => {
          const itemAt = `${at}[${String(i)}]`;
          if (field.listKind === 'message') list.add(reflect(field.message, readMessage(field.message, item, itemAt, strict, unrecognized)));
          else if (field.listKind === 'enum') {
            const number = typeof item === 'string' ? enumFromWire(field, item) : undefined;
            if (number === undefined) {
              if (strict) throw new WireJsonError(`${itemAt}: unknown enum value`);
              unrecognized.push(itemAt);
            } else list.add(number);
          } else list.add(scalarFromWire(field, item, itemAt));
        });
        break;
      }
      default:
        throw new WireJsonError(`${at}: ${field.fieldKind} fields are not in the profile`);
    }
  }
  for (const field of schema.fields) {
    if (required(field) && !Object.hasOwn(json, field.name)) {
      throw new WireJsonError(`${path === '' ? field.name : `${path}.${field.name}`}: missing`);
    }
  }
  return message;
}
