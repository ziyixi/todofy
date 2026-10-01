// contracts/ops-v1: the fixtures, the dependency-free validator the TypeScript Workers use, and the
// constants of ops-v1.ts must agree with ops-v1.schema.json. Todofy's tests/unit/test_ops_contract.py
// checks the same fixtures with the reference validator (Python jsonschema), so both verdicts match.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { validate } from '../../../contracts/ops-v1/validate.mjs'
import * as ops from '../../../contracts/ops-v1/ops-v1.ts'

const ROOT = new URL('../../../contracts/ops-v1/', import.meta.url)
const schema = JSON.parse(readFileSync(new URL('ops-v1.schema.json', ROOT), 'utf8'))
const defs = schema.$defs
// Every method input and output (README.md) has fixtures; the other $defs are their parts.
const METHOD_DEFS = ['CanaryDelivery', 'CanaryResult', 'GuardState', 'OpsReport', 'OpsReportReceipt', 'OpsStatus',
  'SetGuardInput', 'StartCanaryInput', 'StartCanaryResult']

function fixtures(relative) {
  const dir = new URL(relative, ROOT)
  return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== 'invalid')
    .flatMap(entry => readdirSync(new URL(`${entry.name}/`, dir)).filter(file => file.endsWith('.json')).map(file => ({
      def: entry.name, name: `${relative}${entry.name}/${file}`,
      value: JSON.parse(readFileSync(new URL(`${entry.name}/${file}`, dir), 'utf8')),
    })))
}
const valid = fixtures('fixtures/'), invalid = fixtures('fixtures/invalid/')

test('fixture directories are exactly the method inputs and outputs', () => {
  assert.deepEqual([...new Set(valid.map(item => item.def))].sort(), METHOD_DEFS)
  for (const item of invalid) assert.ok(METHOD_DEFS.includes(item.def), item.name)
})

test('every valid fixture passes validate.mjs', () => {
  for (const item of valid) assert.deepEqual(validate(schema, item.def, item.value), [], item.name)
})

test('every invalid fixture fails validate.mjs', () => {
  assert.ok(invalid.length >= 20)
  for (const item of invalid) assert.notDeepEqual(validate(schema, item.def, item.value), [], item.name)
})

test('validate.mjs refuses keywords and references it does not implement', () => {
  assert.throws(() => validate({ $defs: { X: { if: { type: 'string' } } } }, 'X', 'a'), /does not implement the keyword "if"/)
  assert.throws(() => validate({ $defs: { X: { $ref: 'other.json#/$defs/Y' } } }, 'X', 'a'), /unsupported \$ref/)
})

test('the constants of ops-v1.ts are the schema values', () => {
  assert.equal(ops.OPS_VERSION, defs.OpsStatus.properties.version.const)
  assert.deepEqual([...ops.OPS_APPS], defs.OpsStatus.properties.app.enum)
  assert.deepEqual([...ops.OPS_SEVERITIES], defs.Severity.enum)
  assert.deepEqual([...ops.OPS_HEALTH], defs.Health.enum)
  assert.deepEqual([...ops.GUARD_LEVELS], defs.GuardLevel.enum)
  assert.deepEqual([...ops.OPS_ERROR_CODES], defs.ErrorCode.enum)
  const [, paused, unavailable] = defs.StartCanaryResult.oneOf
  assert.deepEqual([...ops.CANARY_PAUSED_REASONS], paused.properties.reason.enum)
  assert.deepEqual([...ops.CANARY_UNAVAILABLE_REASONS], unavailable.properties.reason.enum)
  assert.deepEqual([...ops.CANARY_WAITING_CODES], defs.CanaryResult.oneOf[1].properties.waiting_code.enum)
  const limits = ops.OPS_LIMITS
  assert.equal(limits.reportMaxItems, defs.OpsReport.properties.items.maxItems)
  assert.equal(limits.reportMaxItems, defs.OpsReportReceipt.properties.item_count.maximum)
  assert.equal(limits.statusMaxSignals, defs.OpsStatus.properties.signals.maxItems)
  assert.equal(limits.metricsMaxKeys, defs.Signal.properties.metrics.maxProperties)
  assert.equal(limits.modesMaxKeys, defs.OpsStatus.properties.modes.maxProperties)
  assert.equal(limits.countersMaxKeys, defs.OpsStatus.properties.counters.maxProperties)
  assert.equal(limits.capabilitiesMax, defs.OpsStatus.properties.capabilities.maxItems)
  assert.equal(limits.deferredMax, defs.GuardState.properties.deferred.maxItems)
})

test('every valid OpsReport fixture fits the byte budget', () => {
  for (const item of valid.filter(item => item.def === 'OpsReport')) {
    assert.ok(Buffer.byteLength(JSON.stringify(item.value)) <= ops.OPS_LIMITS.reportMaxBytes, item.name)
  }
})
