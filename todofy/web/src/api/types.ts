/**
 * The owner API's types are the generated messages of todofy.ui.v1 (proto/todofy/ui/v1): this file only re-exports
 * the ones the pages name, with the small helpers they share: each enum's wire names (the codes the labels and the
 * URLs use, lib/labels.ts), RFC 3339 text of a Timestamp, and the resources' names.
 */
import { timestampDate, type Timestamp } from '@ziyixi/proto/protobuf/wkt'
import {
  EventErrorCode,
  EventErrorCodeSchema,
  MailEvent_State,
  MailEvent_StateSchema,
  ReconcileAction,
  ReconcileActionSchema,
  Transition_Actor,
  Transition_ActorSchema,
} from '@ziyixi/proto/todofy/ui/v1/mail_event_pb'
import { GtdReview_State, GtdReview_StateSchema } from '@ziyixi/proto/todofy/ui/v1/history_pb'
import {
  BackupStatus_ErrorCode,
  BackupStatus_ErrorCodeSchema,
  BackupStatus_State,
  BackupStatus_StateSchema,
  DailyReminder_State,
  DailyReminder_StateSchema,
  ReminderErrorCode,
  ReminderErrorCodeSchema,
} from '@ziyixi/proto/todofy/ui/v1/status_pb'
import { ReportStatus, ReportStatusSchema } from '@ziyixi/proto/todofy/report/v1/report_pb'
import { wireEnum, type WireName } from '@ziyixi/proto/wire-json'

export type { LegacyText, MailEvent, Transition } from '@ziyixi/proto/todofy/ui/v1/mail_event_pb'
export type { GtdDay, GtdReview, GtdScope, MetricDay } from '@ziyixi/proto/todofy/ui/v1/history_pb'
export type { BackupStatus, DailyReminder, Integration, ServiceStatus, Switches } from '@ziyixi/proto/todofy/ui/v1/status_pb'
export type { LatestReports } from '@ziyixi/proto/todofy/ui/v1/reports_pb'
export type { RecommendationReport, SummaryReport } from '@ziyixi/proto/todofy/report/v1/report_pb'
export { ReconcileAction, ReportStatus }
export { ReportKind } from '@ziyixi/proto/todofy/ui/v1/reports_pb'

// Each enum's wire names, e.g. eventStates.name(MailEvent_State.TODO_UNKNOWN) === 'todo_unknown'.
export const eventStates = wireEnum(MailEvent_StateSchema, MailEvent_State)
export const eventErrors = wireEnum(EventErrorCodeSchema, EventErrorCode)
export const reconcileActions = wireEnum(ReconcileActionSchema, ReconcileAction)
export const actors = wireEnum(Transition_ActorSchema, Transition_Actor)
export const reminderStates = wireEnum(DailyReminder_StateSchema, DailyReminder_State)
export const reminderErrors = wireEnum(ReminderErrorCodeSchema, ReminderErrorCode)
export const backupStates = wireEnum(BackupStatus_StateSchema, BackupStatus_State)
export const backupErrors = wireEnum(BackupStatus_ErrorCodeSchema, BackupStatus_ErrorCode)
export const reviewStates = wireEnum(GtdReview_StateSchema, GtdReview_State)
export const reportStatuses = wireEnum(ReportStatusSchema, ReportStatus)

export type EventState = WireName<typeof MailEvent_State>
export type EventErrorName = WireName<typeof EventErrorCode>
export type ReconcileActionName = WireName<typeof ReconcileAction>
export type ReminderStateName = WireName<typeof DailyReminder_State>
export type ReminderErrorName = WireName<typeof ReminderErrorCode>
export type BackupStateName = WireName<typeof BackupStatus_State>
export type BackupErrorName = WireName<typeof BackupStatus_ErrorCode>
export type ReportStatusName = WireName<typeof ReportStatus>

/** A Timestamp as RFC 3339 UTC text (what lib/format.ts formats), or null when it is not set; whole seconds as the
 * wire writes them (`2026-09-28T08:00:00Z`). */
export function iso(timestamp: Timestamp | undefined): string | null {
  return timestamp === undefined ? null : timestampDate(timestamp).toISOString().replace('.000Z', 'Z')
}

/** mailEvents/{id} of a Mail Hero event ID. */
export function mailEventName(eventId: string): string {
  return `mailEvents/${eventId}`
}

/** The last segment of a resource name (`mailEvents/<id>` → `<id>`, `dailyReminders/2026-09-30` → the day). */
export function idOf(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1)
}
