import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CommonReason } from '@ziyixi/proto/common/errors/v1/errors_pb'
import { ErrorReason } from '@ziyixi/proto/todofy/ui/v1/errors_pb'
import { describe, expect, it } from 'vitest'
import {
  backupErrors,
  backupStates,
  eventErrors,
  eventStates,
  reconcileActions,
  reminderErrors,
  reminderStates,
  reportStatuses,
} from '../api/types'
import {
  API_ERROR_HINTS,
  BACKUP_ERRORS,
  BACKUP_STATUS,
  EVENT_ERRORS,
  EVENT_STATES,
  RECOMMENDATION_STATUS,
  RECONCILE_ACTIONS,
  REMINDER_ERRORS,
  REMINDER_STATES,
  SUMMARY_STATUS,
} from './labels'

const API = join(__dirname, '../../../api')
// A report schema (generated from proto/todofy/report/v1) is a union by status: one oneOf branch per status.
const statuses = (name: string) =>
  (JSON.parse(readFileSync(join(API, name), 'utf8')) as { oneOf: { properties: { status: { const: string } } }[] }).oneOf.map(
    (branch) => branch.properties.status.const,
  )
// Every reason Todofy answers: its own (proto/todofy/ui/v1/errors.proto) and the common ones (common/errors/v1).
const reasons = (values: Readonly<Record<string, number>>) => Object.keys(values).filter((name) => name !== 'UNSPECIFIED')

const sorted = (values: Iterable<string>) => [...values].sort()

describe('every value of the IDL has exactly one Chinese label', () => {
  it.each([
    ['MailEvent.State', EVENT_STATES, eventStates.names],
    ['EventErrorCode', EVENT_ERRORS, eventErrors.names],
    ['DailyReminder.State', REMINDER_STATES, reminderStates.names],
    ['ReminderErrorCode', REMINDER_ERRORS, reminderErrors.names],
    ['ReconcileAction', RECONCILE_ACTIONS, reconcileActions.names],
    ['BackupStatus.State', BACKUP_STATUS, backupStates.names],
    ['BackupStatus.ErrorCode', BACKUP_ERRORS, backupErrors.names],
    ['summary-v1 status', SUMMARY_STATUS, statuses('summary-v1.schema.json')],
    ['recommendation-v1 status', RECOMMENDATION_STATUS, statuses('recommendation-v1.schema.json')],
  ])('%s', (_name, table, values) => {
    expect(sorted(Object.keys(table))).toEqual(sorted(values))
    for (const label of Object.values(table)) expect(JSON.stringify(label)).toMatch(/[一-鿿]/)
  })

  it('the report statuses are the IDL\'s', () => {
    expect(sorted(reportStatuses.names)).toEqual(sorted(statuses('recommendation-v1.schema.json')))
  })

  it.each([
    ['event', EVENT_ERRORS, ['invalid_saved_event', 'llm_client_unavailable', 'summary_render_failed', 'todo_client_unavailable', 'database_client_unavailable', 'cache_write_failed', 'checkpoint_failed']],
    ['reminder', REMINDER_ERRORS, ['empty_task_id', 'todo_client_unavailable']],
  ])('%s codes only the Go service wrote are marked legacy, and only those', (_name, table, legacy) => {
    for (const [code, { title, detail }] of Object.entries(table)) {
      const isLegacy = legacy.includes(code)
      expect([title.startsWith('（旧版）'), detail.startsWith('（旧版）')], code).toEqual([isLegacy, isLegacy])
    }
  })

  it('every reason Todofy answers plus the two client-side codes has a hint', () => {
    expect(sorted(Object.keys(API_ERROR_HINTS))).toEqual(sorted([...reasons(ErrorReason), ...reasons(CommonReason), 'NETWORK_ERROR', 'BAD_RESPONSE']))
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
