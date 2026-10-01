/**
 * The value rules of the wire JSON profile (common/wire/v1/wire.proto, proto/README.md): what a contract states
 * next to its fields, checked on a message the codec has just read or is about to write (wire-json.ts calls
 * `ruleViolation`; nothing else needs to). Its Python twin is the rule part of
 * proto/python/src/ziyixi_proto/wire_json.py, and testdata/wire-profile-cases.json runs in both.
 *
 * - A rule never converts: the first rule a message breaks is reported as `<path>: <rule>`, never with the
 *   value (a path and a rule name carry no data), and the codec refuses the message.
 * - A union (Message.discriminator) checks a field's cases only when the reader knows the discriminator's
 *   value: a lenient read of a newer producer's value (read as the zero value, listed in `unrecognized`) checks
 *   the fields' own rules and no case.
 * - An enum field whose wire name the reader did not know (lenient only) has a value, but none to check. A list item
 *   the read dropped for that reason keeps its index: the next item is checked as `<path>[<its own index>]`.
 * - Field.non_null: a REQUIRED enum or message field always has a value, whatever the discriminator (null is refused
 *   on every read and write).
 * - Field.open lets a lenient read (a consumer) accept a value outside `allowed`: the list is what producers of
 *   this build write; writes and strict reads keep to it.
 * - CaseRules.empty refuses a list or map with an item or entry in its case.
 *
 * The rules are read from the descriptors (getOption) once per field and cached; a regular expression is
 * compiled once per format. Rule mistakes (an unknown format, a case on a field that has no presence) stop
 * generation (proto/tools/wire_rules.py), so they cannot reach this code from a generated descriptor.
 */
import { getOption, hasOption, ScalarType, type DescEnum, type DescField, type DescFile, type DescMessage } from '@bufbuild/protobuf';
import type { ReflectMessage } from '@bufbuild/protobuf/reflect';
import { field as fieldOption, formats as formatsOption, message as messageOption, Presence, type CaseRules, type Field } from './common/wire/v1/wire_pb.ts';
import { field_behavior, FieldBehavior } from './google/api/field_behavior_pb.ts';

/** FeatureSet.FieldPresence.IMPLICIT: a proto3 scalar without `optional` (its default value is "unset"). */
const IMPLICIT = 2;

interface Format {
  readonly name: string;
  readonly regex: RegExp;
  readonly maxLength: number;
}

interface Bounds {
  readonly allowed: ReadonlySet<string> | null;
  readonly minimum: number | undefined;
  readonly maximum: number | undefined;
}

interface CompiledCase extends Bounds {
  readonly when: ReadonlySet<string>;
  readonly presence: Presence;
  /** A list or map has no items or entries in this case (CaseRules.empty). */
  readonly empty: boolean;
}

interface Compiled extends Bounds {
  readonly format: Format | null;
  readonly open: boolean;
  readonly maxItems: number;
  readonly unique: boolean;
  readonly keyFormat: Format | null;
  readonly requiredKeys: readonly string[];
  readonly keepOrder: boolean;
  readonly cases: readonly CompiledCase[];
  readonly otherwise: Presence;
  readonly nonNull: boolean;
}

const NONE: Compiled = {
  format: null,
  allowed: null,
  open: false,
  minimum: undefined,
  maximum: undefined,
  maxItems: 0,
  unique: false,
  keyFormat: null,
  requiredKeys: [],
  keepOrder: false,
  cases: [],
  otherwise: Presence.UNSPECIFIED,
  nonNull: false,
};

const compiledFields = new WeakMap<DescField, Compiled>();
const requiredFields = new WeakMap<DescField, boolean>();
const fileFormats = new WeakMap<DescFile, ReadonlyMap<string, Format>>();
const discriminators = new WeakMap<DescMessage, DescField | null>();

/** The rules of `field` as written in its .proto file (every rule unset when it has none). */
export function fieldRules(field: DescField): Field {
  return getOption(field, fieldOption);
}

/**
 * Whether `value` matches the format `name` of `file` ((common.wire.v1.formats)). A producer checks a name it did not
 * choose before writing it (a metric key, a stored error code) with this, so the contract's pattern stays the one
 * definition. Throws for a format the file does not define.
 */
export function formatMatches(file: DescFile, name: string, value: string): boolean {
  const format = formatsOf(file).get(name);
  if (format === undefined) throw new Error(`no format ${name} in ${file.name}`);
  return matches(format, value);
}

/** Whether a map field writes its entries in the order they were set (Field.keep_order). */
export function keepsOrder(field: DescField): boolean {
  return compiled(field).keepOrder;
}

function formatsOf(file: DescFile): ReadonlyMap<string, Format> {
  let formats = fileFormats.get(file);
  if (formats === undefined) {
    formats = new Map(
      getOption(file, formatsOption).map((f) => [f.name, { name: f.name, regex: new RegExp(`^(?:${f.pattern})$`, 'u'), maxLength: f.maxLength }]),
    );
    fileFormats.set(file, formats);
  }
  return formats;
}

function formatNamed(field: DescField, name: string): Format | null {
  if (name === '') return null;
  const format = formatsOf(field.parent.file).get(name);
  if (format === undefined) throw new Error(`${field.toString()}: no format ${name} in ${field.parent.file.name}`);
  return format;
}

function bounds(rules: Field | CaseRules | undefined): Bounds {
  return {
    allowed: rules !== undefined && rules.allowed.length > 0 ? new Set(rules.allowed) : null,
    minimum: rules?.minimum,
    maximum: rules?.maximum,
  };
}

function compiled(field: DescField): Compiled {
  let rules = compiledFields.get(field);
  if (rules === undefined) {
    const option = fieldRules(field);
    rules = !hasOption(field, fieldOption)
      ? NONE
      : {
            ...bounds(option),
            format: formatNamed(field, option.format),
            open: option.open,
            maxItems: option.maxItems,
            unique: option.unique,
            keyFormat: formatNamed(field, option.keyFormat),
            requiredKeys: option.requiredKeys,
            keepOrder: option.keepOrder,
            cases: option.cases.map((c) => ({ ...bounds(c.rules), when: new Set(c.when), presence: c.presence, empty: c.rules?.empty ?? false })),
            otherwise: option.otherwise,
            nonNull: option.nonNull,
          };
    compiledFields.set(field, rules);
  }
  return rules;
}

function discriminatorOf(desc: DescMessage): DescField | null {
  let field = discriminators.get(desc);
  if (field === undefined) {
    const name = getOption(desc, messageOption).discriminator;
    field = name === '' ? null : (desc.fields.find((f) => f.name === name) ?? null);
    discriminators.set(desc, field);
  }
  return field;
}

/** The wire name of an enum value (the profile's rule: the name without the enum's prefix, in lower case). */
function wireName(desc: DescEnum, number: number): string | undefined {
  const value = desc.value[number];
  return value === undefined || number === 0 ? undefined : value.name.slice((desc.sharedPrefix ?? '').length).toLowerCase();
}

interface Context {
  /** A lenient read (a consumer): Field.open lists are not checked. */
  readonly lenient: boolean;
  /** Paths of enum values the read did not know (lenient only). */
  readonly unrecognized: ReadonlySet<string>;
}

/**
 * The first rule `r` breaks, as `<path>: <rule>`, or null. `lenient`: a lenient read, or the write of a message read
 * so (open allowed lists are not checked). `unrecognized` lists the paths a lenient read skipped
 * (wire-json.ts ReadResult.unrecognized); a write passes none.
 */
export function ruleViolation(r: ReflectMessage, lenient: boolean, unrecognized: readonly string[] = []): string | null {
  return checkMessage(r, '', { lenient, unrecognized: new Set(unrecognized) });
}

const ordered = new WeakMap<DescMessage, readonly DescField[]>();

/** The fields of `desc` in field-number order, the order both codecs check them in. */
function byNumber(desc: DescMessage): readonly DescField[] {
  let fields = ordered.get(desc);
  if (fields === undefined) {
    fields = [...desc.fields].sort((a, b) => a.number - b.number);
    ordered.set(desc, fields);
  }
  return fields;
}

function join(path: string, name: string): string {
  return path === '' ? name : `${path}.${name}`;
}

function checkMessage(r: ReflectMessage, path: string, context: Context): string | null {
  const discriminator = discriminatorOf(r.desc);
  let variant: string | undefined;
  if (discriminator !== null && discriminator.fieldKind === 'enum') {
    const at = join(path, discriminator.name);
    if (!context.unrecognized.has(at)) variant = wireName(discriminator.enum, r.get(discriminator) as number);
  }
  for (const field of byNumber(r.desc)) {
    const violation = checkField(r, field, join(path, field.name), variant, context);
    if (violation !== null) return violation;
  }
  return null;
}

/**
 * Whether `field` has a value: an enum other than its zero value (or one the read did not know), a set message or
 * `optional` scalar, an implicit scalar other than its default unless it is REQUIRED (the profile writes a REQUIRED
 * one always, so `"version": ""` is a value to check), and always a list or a map.
 */
function hasValue(r: ReflectMessage, field: DescField, at: string, context: Context): boolean {
  switch (field.fieldKind) {
    case 'enum':
      return (r.get(field) as number) !== 0 || context.unrecognized.has(at);
    case 'scalar':
      return r.isSet(field) || (field.presence === IMPLICIT && isRequired(field));
    case 'message':
      return r.isSet(field);
    default:
      return true;
  }
}

/** Whether `field` is REQUIRED (google.api.field_behavior), read from its options once. */
function isRequired(field: DescField): boolean {
  let required = requiredFields.get(field);
  if (required === undefined) {
    required = getOption(field, field_behavior).includes(FieldBehavior.REQUIRED);
    requiredFields.set(field, required);
  }
  return required;
}

function checkField(r: ReflectMessage, field: DescField, at: string, variant: string | undefined, context: Context): string | null {
  const rules = compiled(field);
  const active = variant === undefined ? undefined : rules.cases.find((c) => c.when.has(variant));
  const presence = variant === undefined ? Presence.UNSPECIFIED : (active?.presence ?? rules.otherwise);
  const has = hasValue(r, field, at, context);
  if (rules.nonNull && !has) return `${at}: required`;
  if (presence === Presence.REQUIRED && !has) return `${at}: required when the discriminator is ${variant ?? ''}`;
  if (presence === Presence.ABSENT && has) return `${at}: not allowed when the discriminator is ${variant ?? ''}`;
  if (!has) return null;
  const extra = active === undefined ? [] : [active];
  const caseEmpty = active?.empty ?? false;
  switch (field.fieldKind) {
    case 'scalar':
      return checkScalar(field.scalar, r.get(field), at, rules, extra, context);
    case 'enum': {
      if (context.unrecognized.has(at)) return null; // a value this build does not know: nothing to compare
      const name = wireName(field.enum, r.get(field) as number);
      return name === undefined ? null : checkAllowed(name, at, rules, extra, context);
    }
    case 'message':
      return checkMessage(r.get(field) as ReflectMessage, at, context);
    case 'list': {
      const list = r.get(field);
      if (rules.maxItems > 0 && list.size > rules.maxItems) return `${at}: more than ${String(rules.maxItems)} items`;
      if (caseEmpty && list.size > 0) return `${at}: not empty when the discriminator is ${variant ?? ''}`;
      const seen = new Set<unknown>();
      let i = 0;
      for (const item of list) {
        // A lenient read drops an enum item whose name it did not know (listed as `<path>[<index>]`): the kept items
        // keep their own indexes, so each is checked, and reported, where it was on the wire.
        while (context.unrecognized.has(`${at}[${String(i)}]`)) i++;
        const itemAt = `${at}[${String(i++)}]`;
        if (rules.unique) {
          if (seen.has(item)) return `${at}: items are not unique`;
          seen.add(item);
        }
        let violation: string | null = null;
        if (field.listKind === 'message') violation = checkMessage(item as ReflectMessage, itemAt, context);
        else if (field.listKind === 'enum') {
          const name = wireName(field.enum, item as number);
          if (name !== undefined) violation = checkAllowed(name, itemAt, rules, extra, context);
        } else violation = checkScalar(field.scalar, item, itemAt, rules, extra, context);
        if (violation !== null) return violation;
      }
      return null;
    }
    case 'map': {
      const map = r.get(field);
      if (rules.maxItems > 0 && map.size > rules.maxItems) return `${at}: more than ${String(rules.maxItems)} entries`;
      if (caseEmpty && map.size > 0) return `${at}: not empty when the discriminator is ${variant ?? ''}`;
      for (const key of rules.requiredKeys) if (!map.has(key)) return `${at}: lacks a required key`;
      const entryAt = `${at}{}`;
      for (const [key, value] of map) {
        if (rules.keyFormat !== null && !matches(rules.keyFormat, key as string)) return `${entryAt}: a key does not match ${rules.keyFormat.name}`;
        let violation: string | null = null;
        if (field.mapKind === 'message') violation = checkMessage(value as ReflectMessage, entryAt, context);
        else if (field.mapKind === 'scalar') violation = checkScalar(field.scalar, value, entryAt, { ...rules, format: null, allowed: null }, extra, context);
        if (violation !== null) return violation;
      }
      return null;
    }
  }
}

function matches(format: Format, value: string): boolean {
  return format.regex.test(value) && (format.maxLength === 0 || [...value].length <= format.maxLength);
}

function checkAllowed(value: string, at: string, rules: Compiled, extra: readonly Bounds[], context: Context): string | null {
  if (context.lenient && rules.open) return null;
  for (const b of [rules, ...extra]) if (b.allowed !== null && !b.allowed.has(value)) return `${at}: not an allowed value`;
  return null;
}

function checkScalar(scalar: ScalarType, value: unknown, at: string, rules: Compiled, extra: readonly Bounds[], context: Context): string | null {
  if (scalar === ScalarType.STRING) {
    if (rules.format !== null && !matches(rules.format, value as string)) return `${at}: does not match ${rules.format.name}`;
    return checkAllowed(value as string, at, rules, extra, context);
  }
  if (typeof value === 'number') {
    for (const b of [rules, ...extra]) {
      if (b.minimum !== undefined && value < b.minimum) return `${at}: below the minimum`;
      if (b.maximum !== undefined && value > b.maximum) return `${at}: above the maximum`;
    }
  }
  return null;
}
