import type { RecommendationReport as RecommendationWire, SummaryReport as SummaryWire } from '@ziyixi/proto/todofy/report/v1/report_wire'
import type { components } from './schema'

type Schemas = components['schemas']

export type ApiErrorCode = Schemas['ApiErrorCode']
export type EventState = Schemas['EventState']
export type EventErrorCode = Schemas['EventErrorCode']
export type ReminderState = Schemas['ReminderState']
export type ReminderErrorCode = Schemas['ReminderErrorCode']
export type ReconcileAction = Schemas['ReconcileAction']
export type EventSummary = Schemas['EventSummary']
export type EventDetail = Schemas['EventDetail']
export type Transition = Schemas['Transition']
export type EventPage = Schemas['EventPage']
export type ReconcileRequest = Schemas['ReconcileRequest']
export type Reminder = Schemas['Reminder']
export type ReminderPage = Schemas['ReminderPage']
export type Overview = Schemas['Overview']
export type BackupStatus = Schemas['BackupStatus']
// The newsletter reports are proto/todofy/report/v1 (recommendation-v1, summary-v1): their wire JSON types come from
// the IDL, a union by status (`report.status === 'empty_window'` narrows `report.summary` to the fixed sentence).
export type SummaryReport = SummaryWire
export type RecommendationReport = RecommendationWire
// The owner API's ReportsLatest (its OpenAPI document stays the source of that envelope until the UI API moves to
// proto/), with the reports typed from the IDL: a field the document adds reaches the UI without an edit here.
export type ReportsLatest = Omit<Schemas['ReportsLatest'], 'summary' | 'recommendations'> & {
  readonly summary: SummaryReport | null
  readonly recommendations: readonly RecommendationReport[]
}
export type RecomputeRequest = Schemas['RecomputeRequest']
export type LegacyText = Schemas['LegacyText']
export type Setup = Schemas['Setup']
export type DailyMetrics = Schemas['DailyMetrics']
export type DailyMetricsDay = Schemas['DailyMetricsDay']
export type GtdDaily = Schemas['GtdDaily']
export type GtdDay = Schemas['GtdDay']
export type GtdScope = Schemas['GtdScope']
export type ErrorBody = Schemas['Error']

export type EventView = 'recent' | 'attention'

// The owner API's OpenAPI document refers to the reports' JSON Schemas, which are generated from the same IDL: what
// it says the API answers must be what the UI's types accept (a compile error otherwise).
type Accepts<Wire, Documented extends Wire> = Documented
// The same property names, both ways (so neither side can gain a field the other lacks).
type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false
type Assert<Holds extends true> = Holds
export type DocumentedReports = [
  Assert<SameKeys<ReportsLatest, Schemas['ReportsLatest']>>,
  Accepts<SummaryReport, Schemas['summary-v1.schema']>,
  Accepts<RecommendationReport, Schemas['recommendation-v1.schema']>,
  Accepts<ReportsLatest, Schemas['ReportsLatest']>,
  Accepts<Schemas['summary-v1.schema']['status'], SummaryReport['status']>,
  Accepts<Schemas['recommendation-v1.schema']['status'], RecommendationReport['status']>,
]
