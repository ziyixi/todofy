/**
 * Rows of BriefState's SQLite as messages of the owner API (proto/brief/ui/v1): issues, items, sources, the profile and
 * the service status. Titles and texts are untrusted (fetched, or model-written from fetched text): the UI shows them as
 * text only. Stored enum values are their wire names (`sent`, `peer_reviewed`), read back through the generated tables.
 */
import {
  Citation_Verdict,
  Citation_VerdictSchema,
  CitationSchema,
  Issue_Kind,
  Issue_KindSchema,
  Issue_QuietReason,
  Issue_QuietReasonSchema,
  Issue_State,
  Issue_StateSchema,
  IssueSchema,
  Item_Format,
  Item_FormatSchema,
  Item_Vote,
  Item_VoteSchema,
  ItemSchema,
  MoreItemSchema,
  ParagraphSchema,
  ReferenceSchema,
  Review,
  ReviewSchema,
  Section,
  SectionSchema,
  StepCostSchema,
  TextScope,
  TextScopeSchema,
  type Issue,
  type Item,
} from '@ziyixi/proto/brief/ui/v1/issue_pb';
import { Source_Role, Source_RoleSchema, Source_State, Source_StateSchema, SourceSchema, type Source as SourceMessage } from '@ziyixi/proto/brief/ui/v1/source_pb';
import { Mode, ModeSchema, ProfileSchema, ServiceStatus_KeyState, ServiceStatus_KeyStateSchema, TopicWeightSchema, type Profile } from '@ziyixi/proto/brief/ui/v1/status_pb';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs, type Timestamp } from '@ziyixi/proto/protobuf/wkt';
import { wireEnum } from '@ziyixi/proto/wire-json';
import { health } from './health.ts';
import { HOUR } from './limits.ts';
import { tallies } from './learn.ts';
import type { Registry, Source, Topic } from './registry.ts';
import type { Citation, MoreItem, Reference } from './render.ts';
import { parseJson, type IssueItemRow, type IssueRow, type SourceRow, type Store } from './store.ts';

export const KINDS = wireEnum(Issue_KindSchema, Issue_Kind);
export const ISSUE_STATES = wireEnum(Issue_StateSchema, Issue_State);
export const QUIET = wireEnum(Issue_QuietReasonSchema, Issue_QuietReason);
export const SECTIONS = wireEnum(SectionSchema, Section);
export const REVIEWS = wireEnum(ReviewSchema, Review);
export const SCOPES = wireEnum(TextScopeSchema, TextScope);
export const FORMATS = wireEnum(Item_FormatSchema, Item_Format);
export const VOTES = wireEnum(Item_VoteSchema, Item_Vote);
export const VERDICTS = wireEnum(Citation_VerdictSchema, Citation_Verdict);
export const SOURCE_STATES = wireEnum(Source_StateSchema, Source_State);
export const ROLES = wireEnum(Source_RoleSchema, Source_Role);
export const MODES = wireEnum(ModeSchema, Mode);
export const KEY_STATES = wireEnum(ServiceStatus_KeyStateSchema, ServiceStatus_KeyState);

/** A timestamp, or undefined for a missing time (the field is then left unset). */
export function time(ms: number | null | undefined): Timestamp | undefined {
  return ms === null || ms === undefined ? undefined : timestampFromMs(ms);
}

/** The cost of each step of an issue (every model call charged to it). */
export function stepCosts(store: Store, issue: string): { step: string; model: string; calls: number; input: number; cacheWrite: number; cacheRead: number; output: number; cost: number }[] {
  return store
    .all<{ step: string; model: string; calls: number; input: number; cache_write: number; cache_read: number; output: number; cost: number }>(
      `SELECT step, CASE WHEN served = '' THEN model ELSE served END AS model, count(*) AS calls, sum(input) AS input, sum(cache_write) AS cache_write, sum(cache_read) AS cache_read, sum(output) AS output, sum(cost) AS cost
       FROM calls WHERE issue = ? AND step != 'gate' AND state != 'open' GROUP BY step, 2 ORDER BY min(id)`,
      issue,
    )
    .map((row) => ({ step: row.step === 'bisect' ? 'write' : row.step, model: row.model, calls: row.calls, input: row.input, cacheWrite: row.cache_write, cacheRead: row.cache_read, output: row.output, cost: row.cost }));
}

/** An issue row as the resource (a run without its row yet is an issue being built). */
export function issueMessage(store: Store, row: IssueRow): Issue {
  const costs = stepCosts(store, row.issue);
  return create(IssueSchema, {
    name: `issues/${row.issue}`,
    kind: KINDS.value(row.kind) ?? Issue_Kind.UNSPECIFIED,
    state: ISSUE_STATES.value(row.state) ?? Issue_State.UNSPECIFIED,
    title: row.title,
    shadow: row.shadow === 1,
    itemCount: row.item_count,
    droppedItemCount: row.dropped_count,
    candidateCount: row.candidate_count,
    costUsd: Math.round(costs.reduce((sum, cost) => sum + cost.cost, 0) * 10_000) / 10_000,
    stepCosts: costs.map((cost) =>
      create(StepCostSchema, {
        step: cost.step,
        model: cost.model,
        callCount: cost.calls,
        inputTokenCount: cost.input,
        cacheWriteTokenCount: cost.cacheWrite,
        cacheReadTokenCount: cost.cacheRead,
        outputTokenCount: cost.output,
        costUsd: Math.round(cost.cost * 10_000) / 10_000,
      }),
    ),
    writerModels: parseJson<string[]>(row.writer_models, []),
    errorCode: row.error_code,
    createTime: time(row.created_ms),
    sendTime: time(row.send_ms),
    quietReason: row.quiet_reason === '' ? Issue_QuietReason.UNSPECIFIED : (QUIET.value(row.quiet_reason) ?? Issue_QuietReason.UNSPECIFIED),
    moreItems: parseJson<MoreItem[]>(row.more, []).map((more) => create(MoreItemSchema, { source: more.source === '' ? '' : `sources/${more.source}`, title: more.title, venue: more.venue, review: REVIEWS.value(more.review) ?? Review.UNSPECIFIED, uri: more.uri })),
    pickFallback: row.pick_fallback === 1,
  });
}

/** An issue still being built (its run, no row yet). */
export function buildingIssue(run: { issue: string; kind: string; created_ms: number }, title: string): Issue {
  return create(IssueSchema, { name: `issues/${run.issue}`, kind: KINDS.value(run.kind) ?? Issue_Kind.UNSPECIFIED, state: Issue_State.BUILDING, title, createTime: time(run.created_ms) });
}

export function itemMessage(row: IssueItemRow, vote: { vote: string; ms: number } | undefined): Item {
  const refs = parseJson<Reference[]>(row.refs, []);
  return create(ItemSchema, {
    name: `issues/${row.issue}/items/${row.id}`,
    section: SECTIONS.value(row.section) ?? Section.UNSPECIFIED,
    title: row.title,
    paragraphs: parseJson<{ heading: string; text: string }[]>(row.paragraphs, []).map((paragraph) => create(ParagraphSchema, paragraph)),
    why: row.why,
    topic: row.topic,
    score: Math.round(row.score * 100) / 100,
    references: refs.map((ref) =>
      create(ReferenceSchema, {
        source: `sources/${ref.source}`,
        venue: ref.venue,
        title: ref.title,
        uri: ref.uri,
        review: REVIEWS.value(ref.review) ?? Review.UNSPECIFIED,
        textScope: SCOPES.value(ref.scope) ?? TextScope.UNSPECIFIED,
        publishTime: time(ref.published),
      }),
    ),
    citations: parseJson<Citation[]>(row.citations, []).map((citation) =>
      create(CitationSchema, { number: citation.n, referenceIndex: citation.ref, quote: citation.quote, verdict: citation.verdict === '' ? Citation_Verdict.UNSPECIFIED : (VERDICTS.value(citation.verdict) ?? Citation_Verdict.UNSPECIFIED) }),
    ),
    vote: vote === undefined ? Item_Vote.UNSPECIFIED : (VOTES.value(vote.vote) ?? Item_Vote.UNSPECIFIED),
    voteTime: time(vote?.ms),
    reason: row.reason,
    format: FORMATS.value(row.format) ?? Item_Format.UNSPECIFIED,
  });
}

export function sourceMessage(source: Source, row: SourceRow | undefined, weight: { weight: number; shown: number; up: number; down: number; more: number } | undefined, now: number): SourceMessage {
  const state = health(source, row, now);
  return create(SourceSchema, {
    name: `sources/${source.id}`,
    displayName: source.name,
    section: SECTIONS.value(source.section) ?? Section.UNSPECIFIED,
    role: ROLES.value(source.role) ?? Source_Role.UNSPECIFIED,
    review: REVIEWS.value(source.review) ?? Review.UNSPECIFIED,
    state: SOURCE_STATES.value(state.state) ?? Source_State.UNSPECIFIED,
    uri: source.url,
    failureCount: row?.failures ?? 0,
    lastErrorCode: row?.last_error ?? '',
    lastSuccessTime: time(row?.last_success_ms),
    recentItemCount: state.recent,
    weight: Math.round((weight?.weight ?? 1) * 1000) / 1000,
    shownCount: weight?.shown ?? 0,
    upCount: Math.round(weight?.up ?? 0),
    downCount: Math.round(weight?.down ?? 0),
    moreCount: Math.round(weight?.more ?? 0),
    lastItemTitle: row?.last_item_title ?? '',
    lastItemTime: time(row?.last_item_ms),
    usualGapHours: Math.round((state.usualGapMs / HOUR) * 10) / 10,
  });
}

/** The profile: every topic's weight and the current window's tallies (the weights as the last update set them). */
export function profileMessage(store: Store, topics: readonly Topic[], now: number): Profile {
  const weights = new Map(store.all<{ id: string; weight: number }>(`SELECT id, weight FROM weights WHERE kind = 'topic'`).map((row) => [row.id, row.weight]));
  const window = tallies(store, now).topics;
  const learned = Number(store.getMeta('learn_ms') ?? '');
  const reset = Number(store.getMeta('reset_ms') ?? '');
  return create(ProfileSchema, {
    name: 'profile',
    topics: topics.map((topic) => {
      const tally = window.get(topic.id);
      return create(TopicWeightSchema, {
        topic: topic.id,
        weight: Math.round((weights.get(topic.id) ?? 1) * 1000) / 1000,
        shownCount: tally?.shown ?? 0,
        upCount: Math.round(tally?.up ?? 0),
        downCount: Math.round(tally?.down ?? 0),
        moreCount: Math.round(tally?.more ?? 0),
        format: FORMATS.value(topic.format) ?? Item_Format.UNSPECIFIED,
      });
    }),
    updateTime: Number.isFinite(learned) && learned > 0 ? time(learned) : undefined,
    resetTime: Number.isFinite(reset) && reset > 0 ? time(reset) : undefined,
  });
}

/** The per-source tallies for ListSources (the same 8-week window as the weights). */
export function sourceWeights(store: Store, now: number): Map<string, { weight: number; shown: number; up: number; down: number; more: number }> {
  const stored = new Map(store.all<{ id: string; weight: number }>(`SELECT id, weight FROM weights WHERE kind = 'source'`).map((row) => [row.id, row.weight]));
  const window = tallies(store, now).sources;
  const out = new Map<string, { weight: number; shown: number; up: number; down: number; more: number }>();
  for (const [id, weight] of stored) out.set(id, { weight, shown: 0, up: 0, down: 0, more: 0 });
  for (const [id, tally] of window) out.set(id, { weight: stored.get(id) ?? 1, ...tally });
  return out;
}

/** The registry's sources as messages, in its order. */
export function sourceMessages(store: Store, registry: Registry, now: number): SourceMessage[] {
  const rows = new Map(store.all<SourceRow>(`SELECT * FROM sources`).map((row) => [row.id, row]));
  const weights = sourceWeights(store, now);
  return registry.sources.map((source) => sourceMessage(source, rows.get(source.id), weights.get(source.id), now));
}
