// A dependency-free validator for the subset of JSON Schema 2020-12 that ops-v1.schema.json uses.
//
// Mail Hero and the future dashboard are TypeScript Workers without a JSON Schema library, and the
// ops surface is small enough not to justify one. Todofy's tests validate the same fixtures with the
// reference implementation (Python jsonschema, Draft202012Validator); both sides assert the same
// verdict for every file under fixtures/, so this subset cannot silently drift from the standard.
//
// Supported: $ref (local "#/$defs/<name>" only), type, enum, const, required, properties,
// additionalProperties, propertyNames, minProperties, maxProperties, items, minItems, maxItems,
// uniqueItems, pattern, minLength, maxLength, minimum, maximum, oneOf, anyOf. Annotations are
// ignored ($schema, $id, $defs, title, description, format, examples, $comment). Any other keyword
// throws, so a schema edit that needs more support fails the tests instead of being skipped.
//
//   import { validate } from '<relative path>/contracts/ops-v1/validate.mjs'
//   const errors = validate(schema, 'OpsStatus', value)   // [] when valid

const ANNOTATIONS = new Set(['$schema', '$id', '$defs', 'title', 'description', 'format', 'examples', '$comment'])
const KEYWORDS = new Set(['$ref', 'type', 'enum', 'const', 'required', 'properties', 'additionalProperties',
  'propertyNames', 'minProperties', 'maxProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'pattern',
  'minLength', 'maxLength', 'minimum', 'maximum', 'oneOf', 'anyOf'])

/** JSON type name of a parsed JSON value ("integer" also counts as "number"). */
function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}
function hasType(value, type) {
  const actual = typeOf(value)
  return actual === type || (type === 'number' && actual === 'integer')
}
/** Structural equality of JSON values, as enum/const/uniqueItems require. */
function equal(a, b) {
  if (a === b) return true
  if (typeOf(a) !== typeOf(b) || typeof a !== 'object' || a === null) return false
  if (Array.isArray(a)) return a.length === b.length && a.every((item, i) => equal(item, b[i]))
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]))
}
const patterns = new Map()
function regex(source) {
  if (!patterns.has(source)) patterns.set(source, new RegExp(source, 'u'))
  return patterns.get(source)
}

function check(root, schema, value, path, errors) {
  if (schema === true) return
  if (schema === false) { errors.push(`${path}: not allowed`); return }
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) throw new Error(`validate.mjs does not implement the keyword "${key}"`)
  }
  if (schema.$ref !== undefined) {
    const match = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(schema.$ref)
    if (!match || !Object.hasOwn(root.$defs ?? {}, match[1])) throw new Error(`unsupported $ref ${schema.$ref}`)
    check(root, root.$defs[match[1]], value, path, errors)
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some(type => hasType(value, type))) { errors.push(`${path}: expected ${types.join(' or ')}`); return }
  }
  if (schema.enum !== undefined && !schema.enum.some(item => equal(item, value))) errors.push(`${path}: not one of ${JSON.stringify(schema.enum)}`)
  if (schema.const !== undefined && !equal(schema.const, value)) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`)
  for (const [keyword, combine] of [['oneOf', count => count === 1], ['anyOf', count => count >= 1]]) {
    if (schema[keyword] === undefined) continue
    const matches = schema[keyword].filter(branch => { const inner = []; check(root, branch, value, path, inner); return inner.length === 0 }).length
    if (!combine(matches)) errors.push(`${path}: ${matches} of ${schema[keyword].length} ${keyword} branches match`)
  }
  if (typeof value === 'string') {
    // JSON Schema counts code points, not UTF-16 units.
    const length = [...value].length
    if (schema.minLength !== undefined && length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`)
    if (schema.maxLength !== undefined && length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`)
    if (schema.pattern !== undefined && !regex(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`)
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`)
    if (schema.uniqueItems && value.some((item, i) => value.slice(0, i).some(other => equal(item, other)))) errors.push(`${path}: items are not unique`)
    if (schema.items !== undefined) value.forEach((item, i) => check(root, schema.items, item, `${path}/${i}`, errors))
  }
  if (typeOf(value) === 'object') {
    const keys = Object.keys(value)
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push(`${path}: fewer than ${schema.minProperties} properties`)
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errors.push(`${path}: more than ${schema.maxProperties} properties`)
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}: missing ${key}`)
    for (const key of keys) {
      if (schema.propertyNames !== undefined) check(root, schema.propertyNames, key, `${path}/${key}(name)`, errors)
      if (schema.properties && Object.hasOwn(schema.properties, key)) check(root, schema.properties[key], value[key], `${path}/${key}`, errors)
      else if (schema.additionalProperties !== undefined) check(root, schema.additionalProperties, value[key], `${path}/${key}`, errors)
    }
  }
}

/**
 * Errors of `value` against `root.$defs[name]` (an empty list when it is valid).
 * @param {{$defs: Record<string, unknown>}} root the parsed ops-v1.schema.json
 * @param {string} name a $defs entry, e.g. "OpsStatus"
 * @param {unknown} value a parsed JSON value (JSON.parse output, or a structured-clone of one)
 * @returns {string[]}
 */
export function validate(root, name, value) {
  if (!Object.hasOwn(root.$defs ?? {}, name)) throw new Error(`no $defs entry ${name}`)
  const errors = []
  check(root, root.$defs[name], value, '', errors)
  return errors
}
