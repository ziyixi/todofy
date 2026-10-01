import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import {
  API_ERROR_HINTS,
  EVENT_ERRORS,
  EVENT_STATES,
  RECOMMENDATION_STATUS,
  RECONCILE_ACTIONS,
  REMINDER_ERRORS,
  REMINDER_STATES,
  SUMMARY_STATUS,
} from './labels'

const API = join(__dirname, '../../../api')
const spec = parse(readFileSync(join(API, 'owner-api-v1.openapi.yaml'), 'utf8')) as {
  components: { schemas: Record<string, { enum?: string[] }> }
}
// A report schema (generated from proto/todofy/report/v1) is a union by status: one oneOf branch per status.
const statuses = (name: string) =>
  (JSON.parse(readFileSync(join(API, name), 'utf8')) as { oneOf: { properties: { status: { const: string } } }[] }).oneOf.map(
    (branch) => branch.properties.status.const,
  )

function enumOf(...names: string[]): string[] {
  return names.flatMap((name) => {
    const values = spec.components.schemas[name]?.enum
    if (!values) throw new Error(`OpenAPI schema ${name} has no enum`)
    return values
  })
}

const sorted = (values: Iterable<string>) => [...values].sort()

describe('every contract enum value has exactly one Chinese label', () => {
  it.each([
    ['EventState', EVENT_STATES, enumOf('EventState')],
    ['EventErrorCode', EVENT_ERRORS, enumOf('CurrentEventErrorCode', 'LegacyEventErrorCode')],
    ['ReminderState', REMINDER_STATES, enumOf('ReminderState')],
    ['ReminderErrorCode', REMINDER_ERRORS, enumOf('CurrentReminderErrorCode', 'LegacyReminderErrorCode')],
    ['ReconcileAction', RECONCILE_ACTIONS, enumOf('ReconcileAction')],
    ['summary-v1 status', SUMMARY_STATUS, statuses('summary-v1.schema.json')],
    ['recommendation-v1 status', RECOMMENDATION_STATUS, statuses('recommendation-v1.schema.json')],
  ])('%s', (_name, table, values) => {
    expect(sorted(Object.keys(table))).toEqual(sorted(values))
    for (const label of Object.values(table)) expect(JSON.stringify(label)).toMatch(/[一-鿿]/)
  })

  it.each([
    ['event', EVENT_ERRORS, enumOf('LegacyEventErrorCode')],
    ['reminder', REMINDER_ERRORS, enumOf('LegacyReminderErrorCode')],
  ])('%s codes only the Go service wrote are marked legacy, and only those', (_name, table, legacy) => {
    for (const [code, { title, detail }] of Object.entries(table)) {
      const isLegacy = legacy.includes(code)
      expect([title.startsWith('（旧版）'), detail.startsWith('（旧版）')], code).toEqual([isLegacy, isLegacy])
    }
  })

  it('ApiErrorCode plus the two client-side codes', () => {
    expect(sorted(Object.keys(API_ERROR_HINTS))).toEqual(sorted([...enumOf('ApiErrorCode'), 'network_error', 'bad_response']))
  })
})

describe('reconcile copy states the consequences', () => {
  it('task_not_created warns about a second Todoist call', () => {
    expect(RECONCILE_ACTIONS.task_not_created.consequence).toContain('会再次调用 Todoist，可能重复建任务')
  })

  it('dismiss says Todoist is not checked', () => {
    expect(RECONCILE_ACTIONS.dismiss.consequence).toContain('不会检查 Todoist')
  })
})

describe('source guard', () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? files(path) : [path]
    })
  }

  it('never references the other repository by its package or directory name', () => {
    // The CI grep over web/src, built from parts so this file does not match itself.
    // The product name written with a space and capitals is fine.
    const pattern = new RegExp(['mail', 'hero'].join('[_-]'))
    const offenders = files(join(__dirname, '..')).filter((path) => pattern.test(readFileSync(path, 'utf8')))
    expect(offenders).toEqual([])
  })
})
