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

  it('codes only a retired writer wrote (the Go service, or the task writes until 2026-10-21) are marked legacy, and only those', () => {
    // worker/todofy/core/vocab.py: EVENT_ERROR_CODES' legacy entries.
    const legacy = [
      'invalid_saved_event', 'llm_client_unavailable', 'summary_render_failed', 'todo_client_unavailable',
      'database_client_unavailable', 'cache_write_failed', 'checkpoint_failed', 'todoist_rejected', 'todoist_auth_blocked',
      'todoist_rate_limited', 'todoist_unavailable', 'todo_result_unknown', 'interrupted_todo_call', 'lookup_not_found',
      'lookup_failed', 'lookup_ambiguous', 'canary_side_effect_blocked',
    ]
    for (const [code, { title, detail }] of Object.entries(EVENT_ERRORS)) {
      const isLegacy = legacy.includes(code)
      expect([title.startsWith('（旧版）'), detail.startsWith('（旧版）')], code).toEqual([isLegacy, isLegacy])
    }
  })

  it('every reason Todofy answers plus the two client-side codes has a hint', () => {
    expect(sorted(Object.keys(API_ERROR_HINTS))).toEqual(sorted([...reasons(ErrorReason), ...reasons(CommonReason), 'NETWORK_ERROR', 'BAD_RESPONSE']))
  })
})

describe('reconcile copy states the consequences', () => {
  it('the task actions say they are no longer offered', () => {
    for (const action of ['task_created', 'task_not_created'] as const) {
      expect(RECONCILE_ACTIONS[action].title).toMatch(/^（旧版）/)
      expect(RECONCILE_ACTIONS[action].consequence).toContain('不再提供')
    }
  })

  it('dismiss says the ledger keeps the event', () => {
    expect(RECONCILE_ACTIONS.dismiss.consequence).toContain('账本保留去重记录')
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
