/**
 * One issue's pipeline (../../docs/design.md §5.3-§12, §14), one step per alarm, each step resumable:
 *
 *   weekday:  pick → shortlist → read → write (bisection on a refusal) → check → repair → render → entail → send
 *   Saturday: thread → read → deep_read → check → repair → render → entail → send
 *
 * The run's row holds its step, its data (cards, the pick, the packets, the writer's answer, the checked items) and the
 * step's open marker: a step that started and never committed counts a crash unless an older build started it (a deploy
 * kills in-flight work after 30 s); after STEP_CRASHES_MAX crashes the step gives up with a code. Model calls count
 * their attempts in the `calls` table (claude.ts): a deploy-killed call uses none, a crashed one does; an answer stored
 * before a crash is read back instead of paying for the call again.
 *
 * A step that cannot go on ends the day with its note (render.ts, a quiet day is said, not silent): 没有新的候选,
 * 候选未能打分, 入选条目都未通过核对, 没有可读全文的线索, 预算已用完, 调用被拒 or 写作未能完成. The send is read at the moment
 * of the send: the mode is `shadow` or `live`, the brief is not paused, the mail secrets are set and it is before
 * 12:00; otherwise the issue is archived.
 *
 * The day ends at its send cutoff (12:00): no model call and no page fetch start past it, and every retry (a transient
 * error's backoff, a write's next attempt) is due at the cutoff at the latest, where the step then ends the day with
 * its note, which can only be archived. A model call blocked because the owner paused the brief or the deployment is
 * off waits without a call or an attempt (PAUSED_RECHECK_MS at a time) and resumes when the stop lifts, or ends the day
 * at the cutoff.
 */
import type { StepBudget } from './budget.ts';
import { attemptsOf, callModel, markRead, readAnswer, unreadAnswer, type BlockedReason, type CallContext, type CallStep, type ModelOutcome, type ModelRequest } from './claude.ts';
import { mailSettings, type Env, type ModeName } from './env.ts';
import type { Clock, Hosts } from './fetch/hosts.ts';
import type { FetchFn } from './fetch/net.ts';
import { checkItem, cutItem, describeFailures, sentences, markersOf, withoutMarkers, type Packet, type WrittenItem } from './ground.ts';
import { displayLink } from './keys.ts';
import {
  BISECT_CALLS_MAX,
  DEEP_CHARS_MAX,
  DEEP_CHARS_MIN,
  DEEP_CUT_MAX,
  DEEP_DOCUMENTS,
  DEEP_HARD_MAX,
  DEEP_HARD_MIN,
  DEEP_RECENT,
  DEEP_RETRY_DOCUMENTS,
  DROP_WARN,
  GATE_MODEL,
  ITEM_CUT_MAX,
  MINUTE,
  MODEL_MIN_LEFT_MS,
  OPUS_MODEL,
  PAUSED_RECHECK_MS,
  PICK_ATTEMPTS,
  READ_SEND_MARGIN_MS,
  READ_WAIT_MAX_MS,
  REPAIR_ATTEMPTS,
  STEP_CRASHES_MAX,
  TRANSIENT_RETRY_MAX_MS,
  TRANSIENT_RETRY_MS,
  WORLD_DOCUMENTS,
  WRITE_ATTEMPTS,
  WRITE_RETRY_MS,
} from './limits.ts';
import {
  deepPickRequest,
  deepWriteRequest,
  entailRequest,
  pickRequest,
  readDeepPick,
  readDeepWrite,
  readEntail,
  readPick,
  readWrite,
  repairRequest,
  writeRequest,
  type Card,
  type EntailCase,
  type PacketDocument,
  type Picked,
  type TextScopeName,
  type Thread,
  type WriterPacket,
} from './prompts.ts';
import { initialText, readStep } from './read.ts';
import { reviewOf, type FormatName, type Registry, type Source, type TextTier, type Topic } from './registry.ts';
import { renderEmail, renderHash, type Citation, type FinalItem, type MoreItem, type QuietReasonName, type Reference } from './render.ts';
import { deepCards, fallbackShortlist, loadWeights, moreItems, primarySource, researchCards, resolveRefused, worldCards, type ResearchCard, type WorldCard } from './select.ts';
import { sendOnce, sendRow } from './send.ts';
import { addDays, issueKind, sendCutoffOf, sendTimeOf } from './schedule.ts';
import { parseJson, type IssueItemRow, type ItemRow, type RunRow, type Store, type TextRow } from './store.ts';

export type StepName = 'pick' | 'shortlist' | 'read' | 'write' | 'check' | 'repair' | 'render' | 'entail' | 'send' | 'thread' | 'deep_read' | 'done';

export interface PipelineEnv {
  readonly store: Store;
  readonly registry: Registry;
  readonly topics: readonly Topic[];
  readonly env: Env;
  readonly budget: StepBudget;
  readonly clock: Clock;
  readonly hosts: Hosts;
  readonly fetchFn: FetchFn;
  readonly own: readonly string[];
  readonly transact: <T>(fn: () => T) => T;
  readonly claude: CallContext;
  readonly build: string;
  readonly publicHost: string;
  readonly mode: ModeName;
  readonly paused: boolean;
  /** Wall time left in this alarm (an Opus call starts only with MODEL_MIN_LEFT_MS). */
  readonly timeLeft: () => number;
}

/** A packet's document as the run keeps it (its text is in `texts`). */
interface DocMeta extends Omit<PacketDocument, 'text' | 'scope'> {
  readonly key: string;
  readonly tier: TextTier;
}

interface PacketMeta extends Omit<WriterPacket, 'documents'> {
  readonly documents: readonly DocMeta[];
  /** The card it came from, and the pick's reason. */
  readonly card: string;
  readonly reason: string;
  readonly score: number;
  /** A candidate Haiku refused is in it (the bisection's first cut). */
  readonly refused: boolean;
  /** A world story's cluster (when it runs, the whole cluster has run: design §4). */
  readonly cluster: number | null;
}

interface Bisection {
  pending: string[][];
  answered: WrittenItem[];
  dropped: string[];
  calls: number;
  /** Why the write was split: a refusal (design §7), or an answer that ran out of tokens or time. */
  cause: 'refusal' | 'length';
}

interface Checked {
  readonly passed: { readonly packet: string; readonly item: WrittenItem }[];
  readonly failing: { readonly packet: string; readonly item: WrittenItem; readonly problems: readonly string[] }[];
}

export interface RunData {
  cards?: { research: Card[]; world: CompactWorld[] };
  candidates?: number;
  picked?: { research: Picked[]; world: Picked[] };
  pickFallback?: boolean;
  more?: MoreItem[];
  /** The items 还有 lists (marked when the issue renders, so no later 还有 lists them again). */
  moreRows?: number[];
  /** The deep read ran out of tokens or time: its next attempts read the thread's first DEEP_RETRY_DOCUMENTS documents. */
  deepShrink?: boolean;
  packets?: PacketMeta[];
  thread?: Thread;
  written?: WrittenItem[];
  bisect?: Bisection;
  checked?: Checked;
  final?: { packet: string; item: WrittenItem }[];
  dropped?: number;
  writers?: string[];
  quiet?: QuietReasonName;
  errorCode?: string;
  entailed?: boolean;
}

export interface StepResult {
  /** When to run the next step: 0 at once, a time, or -1 when the run is done. */
  readonly next: number;
  readonly code: string;
}

const DONE: StepResult = { next: -1, code: 'done' };

function data(run: RunRow): RunData {
  return parseJson<RunData>(run.data, {});
}

/** Saves a step's patch over the run's stored data (never over the snapshot the step started from). */
function save(env: PipelineEnv, run: RunRow, step: StepName, patch: Partial<RunData>, extra: { notBefore?: number; backoff?: number; errorCode?: string } = {}): void {
  const stored = env.store.one<{ data: string }>(`SELECT data FROM runs WHERE issue = ?`, run.issue)?.data ?? run.data;
  const merged = { ...parseJson<RunData>(stored, {}), ...patch };
  env.store.run(
    `UPDATE runs SET step = ?, data = ?, done = ?, open_build = NULL, open_ms = NULL, crashes = CASE WHEN step = ? THEN crashes ELSE 0 END, not_before_ms = ?, backoff_ms = ?, error_code = ?, updated_ms = ? WHERE issue = ?`,
    step,
    JSON.stringify(merged),
    step === 'done' ? 1 : 0,
    step,
    extra.notBefore ?? 0,
    extra.backoff ?? 0,
    extra.errorCode ?? run.error_code,
    env.clock.now(),
    run.issue,
  );
}

/** Ends the day with its note (rendered next). */
function quiet(env: PipelineEnv, run: RunRow, reason: QuietReasonName, code: string): StepResult {
  env.transact(() => {
    save(env, run, 'render', { quiet: reason, errorCode: code }, { errorCode: code });
    env.store.pushError(code);
  });
  return { next: 0, code };
}

function transientDelay(run: RunRow, outcome: Extract<ModelOutcome, { kind: 'transient' }>): number {
  const backoff = Math.min(TRANSIENT_RETRY_MAX_MS, run.backoff_ms > 0 ? run.backoff_ms * 2 : TRANSIENT_RETRY_MS);
  return Math.max(backoff, outcome.retryAfterMs ?? 0);
}

/** When a step tries again after `delay`: never past the send cutoff, where it then ends the day. */
function retryAt(env: PipelineEnv, run: RunRow, delay: number): number {
  return Math.min(env.clock.now() + delay, sendCutoffOf(run.issue));
}

/** A transient error before the stream (design §7): the step waits for its backoff and runs again. */
function retryTransient(env: PipelineEnv, run: RunRow, step: StepName, outcome: Extract<ModelOutcome, { kind: 'transient' }>): StepResult {
  const delay = transientDelay(run, outcome);
  const at = retryAt(env, run, delay);
  env.transact(() => { save(env, run, step, {}, { notBefore: at, backoff: delay }); });
  return { next: at, code: outcome.code };
}

/**
 * A model call of a step, or the answer an earlier crashed invocation already stored. No call starts past the issue's
 * send cutoff (`blocked: cutoff`): the issue could only be archived, and a call a deploy killed would otherwise run
 * again at full price.
 */
async function call(env: PipelineEnv, run: RunRow, step: CallStep, model: string, built: { params: ModelRequest['params']; estimatedInputTokens: number }): Promise<ModelOutcome> {
  const stored = unreadAnswer(env.store, run.issue, step, 0);
  if (stored !== null) {
    const answer = readAnswer(stored.id, stored.answer, stored.served, parseJson<string[]>(stored.writers, []));
    if (answer.kind === 'answer') return answer;
    // A stored answer that does not parse was an attempt: never read again.
    env.transact(() => { markRead(env.store, stored.id); });
  }
  if (env.clock.now() >= sendCutoffOf(run.issue)) return { kind: 'blocked', reason: 'cutoff' };
  return callModel(env.claude, { step, issue: run.issue, model, params: built.params, estimatedInputTokens: built.estimatedInputTokens });
}

/** What a call that was not made means for its step: a pause waits; anything else ends the day with its note. */
type Stop = { readonly park: Extract<BlockedReason, 'paused' | 'mode_off'> } | { readonly quiet: QuietReasonName; readonly code: string };

function stopOf(outcome: ModelOutcome): Stop | null {
  if (outcome.kind === 'rejected') return { quiet: 'calls_rejected', code: 'anthropic_rejected' };
  if (outcome.kind !== 'blocked') return null;
  switch (outcome.reason) {
    case 'paused':
    case 'mode_off':
      return { park: outcome.reason };
    case 'cutoff':
      return { quiet: 'write_failed', code: 'after_cutoff' };
    case 'rejected':
      return { quiet: 'calls_rejected', code: 'anthropic_rejected' };
    case 'budget':
      return { quiet: 'budget_spent', code: 'budget_spent' };
    case 'not_configured':
      return { quiet: 'calls_rejected', code: 'anthropic_not_configured' };
  }
}

/**
 * Paused (设置 → 暂停) or switched off (BRIEF_MODE=off) mid-run: the step stays where it is and looks again in
 * PAUSED_RECHECK_MS, with no call and no attempt; at the send cutoff the day ends (its note is only archived).
 */
function park(env: PipelineEnv, run: RunRow, step: StepName, reason: 'paused' | 'mode_off'): StepResult {
  const at = env.clock.now() + PAUSED_RECHECK_MS;
  if (at >= sendCutoffOf(run.issue)) return quiet(env, run, 'write_failed', reason);
  env.transact(() => { save(env, run, step, {}, { notBefore: at }); });
  return { next: at, code: reason };
}

function stopStep(env: PipelineEnv, run: RunRow, step: StepName, stop: Stop): StepResult {
  return 'park' in stop ? park(env, run, step, stop.park) : quiet(env, run, stop.quiet, stop.code);
}

/** An answer that ran out of tokens or time: the same request would again (design §7). */
function tooLong(outcome: ModelOutcome): boolean {
  return (outcome.kind === 'invalid' && outcome.code === 'max_tokens') || (outcome.kind === 'failed' && outcome.code === 'MODEL_TIMEOUT');
}

// ---- the weekday pick (design §5.3) ------------------------------------------------------------------------------------------------

/** The fields of a card the pick reads (and the run keeps). */
function cardFields(card: Card): Card {
  return {
    id: card.id,
    section: card.section,
    topic: card.topic,
    venues: card.venues,
    review: card.review,
    title: card.title,
    summary: card.summary,
    corroboration: card.corroboration,
    readable: card.readable,
    heldBack: card.heldBack,
    ...(card.votes === undefined ? {} : { votes: card.votes }),
  };
}

/** A world card as the run keeps it: its members' rows, not the rows themselves. */
type CompactWorld = Card & { members: number[]; signals: string[]; score: number; cluster: number | null };

function compactWorld(card: WorldCard): CompactWorld {
  return { ...cardFields(card), members: card.members.map((member) => member.rowid), signals: card.signals.slice(0, 6), score: card.score, cluster: card.cluster };
}

function compactResearch(card: ResearchCard): Card & { rowid: number; listed: boolean } {
  return { ...cardFields(card), rowid: card.rowid, listed: card.listed };
}

async function pickStep(env: PipelineEnv, run: RunRow): Promise<StepResult> {
  const d = data(run);
  let cards = d.cards;
  if (cards === undefined) {
    const built = env.transact(() => {
      resolveRefused(env.store, env.registry, env.topics);
      const weights = loadWeights(env.store);
      return { research: researchCards(env.store, env.registry, weights, run.issue, env.topics), world: worldCards(env.store, env.registry, weights, run.issue) };
    });
    const fresh = { research: built.research.map(compactResearch), world: built.world.map(compactWorld) };
    cards = fresh;
    const candidates = fresh.research.length + fresh.world.length;
    if (candidates === 0) {
      const unscored = env.store.count(`SELECT count(*) AS n FROM items WHERE candidate = 1 AND gate IN ('pending', 'unscored') AND fetched_ms >= ?`, env.clock.now() - 7 * 24 * 60 * MINUTE);
      env.transact(() => { save(env, run, 'pick', { cards: fresh, candidates: 0 }); });
      return quiet(env, run, unscored > 0 ? 'not_scored' : 'no_candidates', unscored > 0 ? 'not_scored' : 'no_candidates');
    }
    env.transact(() => { save(env, run, 'pick', { cards: fresh, candidates }); });
  }
  const weights = Object.fromEntries(env.topics.map((topic) => [topic.id, Math.round((loadWeights(env.store).topics.get(topic.id) ?? 1) * 100) / 100]));
  let picked: { research: Picked[]; world: Picked[] } | null = null;
  let fallback = false;
  const attempts = attemptsOf(env.store, run.issue, 'pick');
  if (attempts >= PICK_ATTEMPTS && unreadAnswer(env.store, run.issue, 'pick', 0) === null) fallback = true;
  else {
    if (env.timeLeft() < MODEL_MIN_LEFT_MS) return { next: 0, code: 'wait_for_alarm' };
    const outcome = await call(env, run, 'pick', OPUS_MODEL, pickRequest(run.issue, cards.research, cards.world, weights));
    const stop = stopOf(outcome);
    if (stop !== null) return stopStep(env, run, 'pick', stop);
    if (outcome.kind === 'transient') {
      // The issue never fails for its pick: past an hour before the send, the gate order.
      if (env.clock.now() + transientDelay(run, outcome) > sendTimeOf(run.issue) - 60 * MINUTE) fallback = true;
      else return retryTransient(env, run, 'pick', outcome);
    } else if (outcome.kind === 'answer') {
      picked = readPick(outcome.json, cards.research, cards.world);
      env.transact(() => { markRead(env.store, outcome.callId); });
      if (picked === null && attempts + 1 < PICK_ATTEMPTS) return { next: 0, code: 'pick_invalid' };
      if (picked === null) fallback = true;
    } else if (attempts + 1 < PICK_ATTEMPTS) return { next: 0, code: `pick_${outcome.kind}` };
    else fallback = true;
  }
  if (fallback || picked === null) {
    const weightsAgain = loadWeights(env.store);
    picked = fallbackShortlist(researchCards(env.store, env.registry, weightsAgain, run.issue, env.topics), worldCards(env.store, env.registry, weightsAgain, run.issue));
    env.transact(() => { env.store.pushError('pick_fallback'); });
  }
  const pickedIds = new Set(picked.research.map((entry) => entry.id));
  const moreCards = moreItems(cards.research as ResearchCard[], pickedIds, env.topics);
  const more = moreCards.map((card) => moreOf(env, card));
  const final = picked;
  env.transact(() => { save(env, run, 'shortlist', { picked: final, pickFallback: fallback, more, moreRows: moreCards.map((card) => card.rowid) }, fallback ? { errorCode: 'pick_fallback' } : {}); });
  return { next: 0, code: fallback ? 'pick_fallback' : 'picked' };
}

function moreOf(env: PipelineEnv, card: Card & { rowid?: number }): MoreItem {
  const item = env.store.one<ItemRow>(`SELECT * FROM items WHERE rowid = ?`, card.rowid ?? Number(card.id.slice(1)));
  const source = item === undefined ? undefined : primarySource(env.registry, item);
  return {
    source: source?.id ?? '',
    title: item?.title ?? card.title,
    venue: source?.name ?? card.venues[0] ?? '',
    review: source === undefined || item === undefined ? card.review : reviewOf(source, item.doi),
    uri: item === undefined ? '' : displayLink(item),
  };
}

// ---- packets (design §6) -------------------------------------------------------------------------------------------------------------

function formatOf(topics: readonly Topic[], topic: string): FormatName {
  return topics.find((entry) => entry.id === topic)?.format ?? 'plain';
}

function docOf(item: ItemRow, source: Source, doc: string): DocMeta {
  return { doc, key: item.key, source: source.id, venue: source.name, review: reviewOf(source, item.doi), title: item.title, published: item.published_ms, uri: displayLink(item), tier: source.text };
}

function insertTexts(env: PipelineEnv, issue: string, docs: readonly { meta: DocMeta; item: ItemRow }[]): void {
  for (const { meta, item } of docs) {
    const start = initialText(meta.tier, meta.tier === 'feed_full' ? (item.body ?? item.summary) : item.summary, displayLink(item), item.arxiv);
    env.store.run(`INSERT OR IGNORE INTO texts (issue, doc, uri, text, scope, state) VALUES (?, ?, ?, ?, ?, ?)`, issue, meta.doc, start.uri, start.text, start.scope, start.state);
  }
}

function itemByRow(env: PipelineEnv, rowid: number): ItemRow | undefined {
  return env.store.one<ItemRow>(`SELECT * FROM items WHERE rowid = ?`, rowid);
}

function shortlistStep(env: PipelineEnv, run: RunRow): StepResult {
  const d = data(run);
  const cards = d.cards ?? { research: [], world: [] };
  const picked = d.picked ?? { research: [], world: [] };
  const packets: PacketMeta[] = [];
  const docs: { meta: DocMeta; item: ItemRow }[] = [];
  let n = 0;
  const nextDoc = (): string => `d${String(++n)}`;
  picked.research.forEach((entry) => {
    const card = cards.research.find((c) => c.id === entry.id) as (Card & { rowid?: number }) | undefined;
    const item = card === undefined ? undefined : itemByRow(env, card.rowid ?? Number(card.id.slice(1)));
    const source = item === undefined ? undefined : primarySource(env.registry, item);
    if (card === undefined || item === undefined || source === undefined) return;
    const meta = docOf(item, source, nextDoc());
    docs.push({ meta, item });
    packets.push({ id: `p${String(packets.length + 1)}`, section: 'research', topic: card.topic, format: formatOf(env.topics, card.topic), documents: [meta], signals: [], heldBack: card.heldBack, card: card.id, reason: entry.reason, score: item.score ?? 0, refused: item.gate === 'fallback', cluster: null });
  });
  picked.world.forEach((entry) => {
    const card = cards.world.find((c) => c.id === entry.id);
    if (card === undefined) return;
    const members = card.members.map((rowid) => itemByRow(env, rowid)).filter((item): item is ItemRow => item !== undefined);
    const chosen: DocMeta[] = [];
    for (const item of members.slice(0, WORLD_DOCUMENTS)) {
      const source = primarySource(env.registry, item);
      if (source === undefined) continue;
      const meta = docOf(item, source, nextDoc());
      chosen.push(meta);
      docs.push({ meta, item });
    }
    if (chosen.length === 0) return;
    packets.push({
      id: `p${String(packets.length + 1)}`,
      section: 'world',
      topic: card.topic,
      format: 'plain',
      documents: chosen,
      signals: card.signals,
      heldBack: card.heldBack,
      card: card.id,
      reason: entry.reason,
      score: card.score,
      refused: members.some((member) => member.gate === 'fallback'),
      cluster: card.cluster,
    });
  });
  if (packets.length === 0) return quiet(env, run, 'no_candidates', 'nothing_picked');
  env.transact(() => {
    insertTexts(env, run.issue, docs);
    save(env, run, 'read', { packets });
  });
  return { next: 0, code: 'shortlisted' };
}

// ---- reading (design §6) ---------------------------------------------------------------------------------------------------------------

async function readPhase(env: PipelineEnv, run: RunRow): Promise<StepResult> {
  // Past the send cutoff the issue could only be archived: no page is fetched for it.
  if (env.clock.now() >= sendCutoffOf(run.issue)) return quiet(env, run, 'write_failed', 'after_cutoff');
  const d = data(run);
  const tiers = new Map((d.packets ?? []).flatMap((packet) => packet.documents.map((document) => [document.doc, document.tier] as const)));
  // A host that is not ready is waited for at most READ_WAIT_MAX_MS at a time, and never past an hour before the send.
  const waitUntil = Math.min(env.clock.now() + READ_WAIT_MAX_MS, sendTimeOf(run.issue) - READ_SEND_MARGIN_MS);
  const result = await readStep({ store: env.store, hosts: env.hosts, fetchFn: env.fetchFn, own: env.own, budget: env.budget, clock: env.clock, transact: env.transact }, run.issue, (doc) => tiers.get(doc) ?? 'feed_summary', waitUntil);
  if (!result.done) {
    const at = result.readyAt ?? 0;
    // Waiting for a host: the step is due then, and the fetch rounds run in between.
    if (at > env.clock.now()) env.transact(() => { save(env, run, 'read', {}, { notBefore: at }); });
    return { next: at, code: 'reading' };
  }
  // A world packet of which no full text was read is written as 世界·短.
  const texts = textsOf(env, run.issue);
  const packets = (d.packets ?? []).map((packet) => (packet.section === 'world' && packet.documents.every((document) => texts.get(document.doc)?.scope !== 'full_text') ? { ...packet, format: 'world_short' as const } : packet));
  env.transact(() => { save(env, run, issueKind(run.issue) === 'deep_read' ? 'deep_read' : 'write', { packets }); });
  return { next: 0, code: 'read' };
}

function textsOf(env: PipelineEnv, issue: string): Map<string, TextRow> {
  return new Map(env.store.all<TextRow>(`SELECT * FROM texts WHERE issue = ?`, issue).map((row) => [row.doc, row]));
}

function writerPackets(env: PipelineEnv, run: RunRow, ids: readonly string[] | null = null): WriterPacket[] {
  const texts = textsOf(env, run.issue);
  const d = data(run);
  return (d.packets ?? [])
    .filter((packet) => ids === null || ids.includes(packet.id))
    .map((packet) => ({
      id: packet.id,
      section: packet.section,
      topic: packet.topic,
      format: packet.format,
      signals: packet.signals,
      heldBack: packet.heldBack,
      documents: (d.deepShrink === true ? packet.documents.slice(0, DEEP_RETRY_DOCUMENTS) : packet.documents).map((document) => {
        const row = texts.get(document.doc);
        return { doc: document.doc, source: document.source, venue: document.venue, review: document.review, scope: (row?.scope ?? 'feed_summary') as TextScopeName, title: document.title, published: document.published, uri: document.uri, text: row?.text ?? '' };
      }),
    }));
}

/** The check's view of a packet: its documents' exact texts, all citable (signals are never documents). */
function checkPacket(packet: WriterPacket, deep: boolean): Packet {
  return { id: packet.id, section: deep ? 'deep_read' : packet.section, format: packet.format, documents: packet.documents.map((document) => ({ doc: document.doc, text: document.text, citable: true })) };
}

// ---- writing and the bisection (design §7) -------------------------------------------------------------------------------------------

async function writeStep(env: PipelineEnv, run: RunRow): Promise<StepResult> {
  if (env.timeLeft() < MODEL_MIN_LEFT_MS) return { next: 0, code: 'wait_for_alarm' };
  const d = data(run);
  const all = writerPackets(env, run);
  if (d.bisect !== undefined) return bisectStep(env, run, d.bisect, all);
  const attempts = attemptsOf(env.store, run.issue, 'write');
  if (attempts >= WRITE_ATTEMPTS && unreadAnswer(env.store, run.issue, 'write', 0) === null) return quiet(env, run, 'write_failed', 'write_attempts');
  const outcome = await call(env, run, 'write', OPUS_MODEL, writeRequest(run.issue, all));
  const stop = stopOf(outcome);
  if (stop !== null) return stopStep(env, run, 'write', stop);
  if (outcome.kind === 'transient') return retryTransient(env, run, 'write', outcome);
  if (outcome.kind === 'refusal') {
    const packets = d.packets ?? [];
    const refusedPackets = packets.filter((packet) => packet.refused).map((packet) => packet.id);
    const rest = packets.filter((packet) => !packet.refused).map((packet) => packet.id);
    const bisect: Bisection =
      refusedPackets.length > 0 && rest.length > 0
        ? { pending: [rest], answered: [], dropped: refusedPackets, calls: 0, cause: 'refusal' }
        : { pending: halves(packets.map((packet) => packet.id)), answered: [], dropped: [], calls: 0, cause: 'refusal' };
    env.transact(() => {
      save(env, run, 'write', { bisect });
      env.store.pushError('write_refused');
    });
    return { next: 0, code: 'write_refused' };
  }
  if (outcome.kind === 'answer') {
    const read = readWrite(outcome.json, all);
    if (read !== null) {
      env.transact(() => {
        markRead(env.store, outcome.callId);
        save(env, run, 'check', { written: read.items, writers: outcome.writers.slice() });
      });
      return { next: 0, code: 'written' };
    }
    env.transact(() => { markRead(env.store, outcome.callId); });
  }
  // Out of tokens or time (max_tokens, the deadline, a stall): the same request would run as long again, so the
  // shortlist is halved through the bisection (each half writes about half as much).
  if (tooLong(outcome) && all.length > 1) {
    const bisect: Bisection = { pending: halves(all.map((packet) => packet.id)), answered: [], dropped: [], calls: 0, cause: 'length' };
    env.transact(() => {
      save(env, run, 'write', { bisect });
      env.store.pushError('write_too_long');
    });
    return { next: 0, code: 'write_too_long' };
  }
  // An invalid answer, a mid-stream error: one of 3 attempts, 15 minutes apart.
  if (attempts + 1 >= WRITE_ATTEMPTS) return quiet(env, run, 'write_failed', 'write_attempts');
  const at = retryAt(env, run, WRITE_RETRY_MS);
  env.transact(() => { save(env, run, 'write', {}, { notBefore: at }); });
  return { next: at, code: outcome.kind === 'answer' ? 'write_invalid' : `write_${outcome.kind}` };
}

function halves<T>(list: readonly T[]): T[][] {
  if (list.length <= 1) return [list.slice()];
  const half = Math.ceil(list.length / 2);
  return [list.slice(0, half), list.slice(half)];
}

/**
 * The bisection (design §7). After a refusal: the call runs again without the packets that hold a candidate Haiku
 * refused, then, still refused, on each half, and so on until a refused packet is alone and dropped (`packet_refused`).
 * After an answer that ran out of tokens or time: on each half, and a half that runs out again is halved in turn. At
 * most BISECT_CALLS_MAX extra calls; the halves that answered make the issue.
 */
async function bisectStep(env: PipelineEnv, run: RunRow, bisect: Bisection, all: readonly WriterPacket[]): Promise<StepResult> {
  const finish = (state: Bisection): StepResult => {
    if (state.dropped.length > 0) env.transact(() => { env.store.pushError(state.cause === 'refusal' ? 'packet_refused' : 'packet_too_long'); });
    if (state.answered.length === 0) return quiet(env, run, 'write_failed', state.cause === 'refusal' ? 'write_refused' : 'write_too_long');
    env.transact(() => { save(env, run, 'check', { written: state.answered, bisect: state }); });
    return { next: 0, code: 'bisected' };
  };
  const group = bisect.pending[0];
  if (group === undefined) return finish(bisect);
  if (bisect.calls >= BISECT_CALLS_MAX) return finish({ ...bisect, pending: [], dropped: [...bisect.dropped, ...bisect.pending.flat()] });
  const packets = all.filter((packet) => group.includes(packet.id));
  const outcome = await call(env, run, 'bisect', OPUS_MODEL, writeRequest(run.issue, packets));
  const stop = stopOf(outcome);
  // A pause waits with the bisection as it is; any other stop keeps the halves that already answered.
  if (stop !== null) return 'park' in stop || bisect.answered.length === 0 ? stopStep(env, run, 'write', stop) : finish({ ...bisect, pending: [] });
  if (outcome.kind === 'transient') return retryTransient(env, run, 'write', outcome);
  const next: Bisection = { ...bisect, pending: bisect.pending.slice(1), calls: bisect.calls + 1 };
  const read = outcome.kind === 'answer' ? readWrite(outcome.json, packets) : null;
  if (outcome.kind === 'answer') env.transact(() => { markRead(env.store, outcome.callId); });
  if (read !== null) next.answered = [...bisect.answered, ...read.items];
  else if (group.length === 1) next.dropped = [...bisect.dropped, ...group];
  else next.pending = [...halves(group), ...next.pending];
  if (next.pending.length === 0) return finish(next);
  env.transact(() => { save(env, run, 'write', { bisect: next }); });
  return { next: 0, code: 'bisecting' };
}

// ---- the check and the repair (design §8) ----------------------------------------------------------------------------------------------

function deepLength(item: WrittenItem): number {
  return item.paragraphs.reduce((sum, paragraph) => sum + withoutMarkers(paragraph.text).replace(/\s/g, '').length, 0);
}

function checkStep(env: PipelineEnv, run: RunRow): StepResult {
  const d = data(run);
  const packets = new Map(writerPackets(env, run).map((packet) => [packet.id, packet]));
  const passed: Checked['passed'] = [];
  const failing: { packet: string; item: WrittenItem; problems: string[] }[] = [];
  for (const item of d.written ?? []) {
    const packet = packets.get(item.packet);
    if (packet === undefined) continue;
    const result = checkItem(item, checkPacket(packet, item.section === 'deep_read'));
    const problems = describeFailures(result.failures);
    if (item.section === 'deep_read') {
      const length = deepLength(item);
      if (length < DEEP_HARD_MIN || length > DEEP_HARD_MAX) problems.push(`length (item): ${String(length)} characters; write ${String(DEEP_CHARS_MIN)}-${String(DEEP_CHARS_MAX)}`);
    }
    if (problems.length === 0) passed.push({ packet: item.packet, item });
    else failing.push({ packet: item.packet, item, problems });
  }
  // The writer left every packet out as too weak (a short issue is fine; an empty one is the day's note).
  if (passed.length === 0 && failing.length === 0) return quiet(env, run, 'no_candidates', 'all_omitted');
  env.transact(() => { save(env, run, failing.length > 0 ? 'repair' : 'render', failing.length > 0 ? { checked: { passed, failing } } : { checked: { passed, failing }, final: passed, dropped: 0 }); });
  return { next: 0, code: failing.length > 0 ? 'check_failed' : 'checked' };
}

async function repairStep(env: PipelineEnv, run: RunRow): Promise<StepResult> {
  if (env.timeLeft() < MODEL_MIN_LEFT_MS) return { next: 0, code: 'wait_for_alarm' };
  const d = data(run);
  const checked = d.checked ?? { passed: [], failing: [] };
  const deep = issueKind(run.issue) === 'deep_read';
  const packets = new Map(writerPackets(env, run).map((packet) => [packet.id, packet]));
  const step: CallStep = deep ? 'deep_repair' : 'repair';
  const attempts = attemptsOf(env.store, run.issue, step);
  let repaired: WrittenItem[] | null = null;
  if (attempts < REPAIR_ATTEMPTS || unreadAnswer(env.store, run.issue, step, 0) !== null) {
    const cases = checked.failing.flatMap((entry) => {
      const packet = packets.get(entry.packet);
      return packet === undefined ? [] : [{ packet, item: entry.item, problems: entry.problems }];
    });
    const outcome = await call(env, run, step, OPUS_MODEL, repairRequest(run.issue, cases, deep));
    const stop = stopOf(outcome);
    if (stop !== null && 'park' in stop) return park(env, run, 'repair', stop.park);
    if (outcome.kind === 'transient') return retryTransient(env, run, 'repair', outcome);
    if (outcome.kind === 'answer') {
      env.transact(() => { markRead(env.store, outcome.callId); });
      if (deep) {
        const packet = [...packets.values()][0];
        const item = packet === undefined ? null : readDeepWrite(outcome.json, packet);
        repaired = item === null ? null : [item];
      } else repaired = readWrite(outcome.json, cases.map((c) => c.packet))?.items ?? null;
    }
    if (repaired === null && attempts + 1 < REPAIR_ATTEMPTS && outcome.kind !== 'blocked' && outcome.kind !== 'rejected') return { next: 0, code: 'repair_retry' };
  }
  // What still fails after the repair is cut at the smallest unit (ground.ts cutItem).
  const final = [...checked.passed];
  let dropped = 0;
  let cutShare = 0;
  for (const entry of checked.failing) {
    const packet = packets.get(entry.packet);
    if (packet === undefined) continue;
    const candidate = repaired?.find((item) => item.packet === entry.packet) ?? entry.item;
    const result = cutItem(candidate, checkPacket(packet, deep), deep ? DEEP_CUT_MAX : ITEM_CUT_MAX);
    if (result.item === null) dropped++;
    else {
      final.push({ packet: entry.packet, item: result.item });
      const before = deepLength(candidate);
      cutShare = before > 0 ? result.removedChars / before : 0;
    }
  }
  const total = final.length + dropped;
  if (deep && (final.length === 0 || cutShare > DEEP_CUT_MAX)) return quiet(env, run, 'none_grounded', 'deep_read_ungrounded');
  if (total > 0 && dropped / total > DROP_WARN) env.transact(() => { env.store.pushError('ground_drop_high'); });
  if (final.length === 0) return quiet(env, run, 'none_grounded', 'none_grounded');
  env.transact(() => { save(env, run, 'render', { final, dropped }); });
  return { next: 0, code: dropped > 0 ? 'cut' : 'repaired' };
}

// ---- the deep read (design §9) ---------------------------------------------------------------------------------------------------------

function votesByKey(env: PipelineEnv, since: string): Map<string, string> {
  const rows = env.store.all<{ keys: string; vote: string }>(`SELECT i.keys, v.vote FROM votes v JOIN issue_items i ON i.issue = v.issue AND i.id = v.item WHERE v.issue >= ?`, since);
  const out = new Map<string, string>();
  for (const row of rows) for (const key of parseJson<string[]>(row.keys, [])) out.set(key, row.vote === 'up' ? '👍' : row.vote === 'down' ? '👎' : '多来点');
  return out;
}

async function threadStep(env: PipelineEnv, run: RunRow): Promise<StepResult> {
  const weights = env.transact(() => {
    resolveRefused(env.store, env.registry, env.topics);
    return loadWeights(env.store);
  });
  const cards = deepCards(env.store, env.registry, weights, run.issue, env.topics, votesByKey(env, addDays(run.issue, -7)));
  if (cards.length === 0) return quiet(env, run, 'no_readable_thread', 'deep_read_none');
  const recent = env.store.all<{ title: string }>(`SELECT title FROM issue_items WHERE id = 'deep' ORDER BY issue DESC LIMIT ?`, DEEP_RECENT).map((row) => row.title);
  const attempts = attemptsOf(env.store, run.issue, 'deep_pick');
  let threads: Thread[] | null = null;
  if (attempts < PICK_ATTEMPTS || unreadAnswer(env.store, run.issue, 'deep_pick', 0) !== null) {
    if (env.timeLeft() < MODEL_MIN_LEFT_MS) return { next: 0, code: 'wait_for_alarm' };
    const outcome = await call(env, run, 'deep_pick', OPUS_MODEL, deepPickRequest(run.issue, cards, recent));
    const stop = stopOf(outcome);
    if (stop !== null) return stopStep(env, run, 'thread', stop);
    if (outcome.kind === 'transient') return retryTransient(env, run, 'thread', outcome);
    if (outcome.kind === 'answer') {
      env.transact(() => { markRead(env.store, outcome.callId); });
      threads = readDeepPick(outcome.json, cards);
    }
    if (threads === null && attempts + 1 < PICK_ATTEMPTS) return { next: 0, code: 'deep_pick_retry' };
  }
  const byId = new Map(cards.map((card) => [card.id, card]));
  // The first thread with at least 2 readable documents, else the second; with neither, no deep read.
  const thread = (threads ?? []).find((candidate) => candidate.ids.filter((id) => byId.get(id)?.readable === true).length >= 2);
  if (thread === undefined) return quiet(env, run, 'no_readable_thread', threads === null ? 'deep_pick_failed' : 'deep_read_none');
  const docs: { meta: DocMeta; item: ItemRow }[] = [];
  let n = 0;
  for (const id of thread.ids) {
    if (docs.length >= DEEP_DOCUMENTS) break;
    const rowid = id.startsWith('r') || id.startsWith('s') ? Number(id.slice(1)) : (env.store.one<{ rowid: number }>(`SELECT rowid FROM items WHERE cluster = ? AND candidate = 1 ORDER BY score DESC LIMIT 1`, Number(id.slice(1)))?.rowid ?? 0);
    const item = itemByRow(env, rowid);
    const source = item === undefined ? undefined : primarySource(env.registry, item);
    if (item === undefined || source === undefined) continue;
    docs.push({ meta: docOf(item, source, `d${String(++n)}`), item });
  }
  const topicCounts = new Map<string, number>();
  for (const id of thread.ids) {
    const topic = byId.get(id)?.topic;
    if (topic !== undefined) topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
  }
  const topic = [...topicCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'ml.other';
  const packet: PacketMeta = { id: 'p1', section: 'research', topic, format: formatOf(env.topics, topic), documents: docs.map((doc) => doc.meta), signals: [], heldBack: null, card: thread.ids.join(','), reason: thread.reason, score: 0, refused: false, cluster: null };
  env.transact(() => {
    insertTexts(env, run.issue, docs);
    save(env, run, 'read', { thread, packets: [packet], candidates: cards.length });
  });
  return { next: 0, code: 'thread' };
}

async function deepReadStep(env: PipelineEnv, run: RunRow): Promise<StepResult> {
  if (env.timeLeft() < MODEL_MIN_LEFT_MS) return { next: 0, code: 'wait_for_alarm' };
  const d = data(run);
  const packet = writerPackets(env, run)[0];
  if (packet === undefined || d.thread === undefined) return quiet(env, run, 'no_readable_thread', 'deep_read_none');
  const attempts = attemptsOf(env.store, run.issue, 'deep_read');
  if (attempts >= WRITE_ATTEMPTS && unreadAnswer(env.store, run.issue, 'deep_read', 0) === null) return quiet(env, run, 'write_failed', 'write_attempts');
  const outcome = await call(env, run, 'deep_read', OPUS_MODEL, deepWriteRequest(run.issue, d.thread, packet));
  const stop = stopOf(outcome);
  if (stop !== null) return stopStep(env, run, 'deep_read', stop);
  if (outcome.kind === 'transient') return retryTransient(env, run, 'deep_read', outcome);
  if (outcome.kind === 'refusal') return quiet(env, run, 'write_failed', 'deep_read_refused');
  if (outcome.kind === 'answer') {
    env.transact(() => { markRead(env.store, outcome.callId); });
    const item = readDeepWrite(outcome.json, packet);
    if (item !== null) {
      env.transact(() => { save(env, run, 'check', { written: [item], writers: outcome.writers.slice() }); });
      return { next: 0, code: 'written' };
    }
  }
  if (attempts + 1 >= WRITE_ATTEMPTS) return quiet(env, run, 'write_failed', 'write_attempts');
  // Out of tokens or time: the next attempts read the thread's first DEEP_RETRY_DOCUMENTS documents, at once (the same
  // request would run as long again); anything else waits 15 minutes.
  const shrink = tooLong(outcome) && packet.documents.length > DEEP_RETRY_DOCUMENTS;
  const at = shrink ? 0 : retryAt(env, run, WRITE_RETRY_MS);
  env.transact(() => { save(env, run, 'deep_read', shrink ? { deepShrink: true } : {}, { notBefore: at }); });
  return { next: at, code: shrink ? 'deep_read_too_long' : `deep_read_${outcome.kind}` };
}

// ---- render, the entailment log and the send (design §8, §11, §12) --------------------------------------------------------------------

/**
 * The final items with their references and verbatim citations (ids r1.., w1.., deep), in the packets' order, which is
 * the pick's (design §5.3): the writer may answer in another order, and the bisection and the repair append what they
 * answered after what had already passed.
 */
export function finalItems(final: readonly { packet: string; item: WrittenItem }[], packets: readonly WriterPacket[], meta: readonly PacketMeta[]): FinalItem[] {
  const counters = { research: 0, world: 0 };
  const position = (id: string): number => packets.findIndex((entry) => entry.id === id);
  const ordered = [...final].sort((a, b) => position(a.packet) - position(b.packet));
  return ordered.map(({ packet: packetId, item }) => {
    const packet = packets.find((entry) => entry.id === packetId) as WriterPacket;
    const info = meta.find((entry) => entry.id === packetId);
    const section = item.section === 'deep_read' ? 'deep_read' : packet.section === 'world' ? 'world' : 'research';
    const id = section === 'deep_read' ? 'deep' : section === 'world' ? `w${String(++counters.world)}` : `r${String(++counters.research)}`;
    const refs: Reference[] = packet.documents.map((document) => ({ source: document.source, venue: document.venue, title: document.title, uri: document.uri, review: document.review, scope: document.scope, published: document.published }));
    const found = checkItem(item, checkPacket(packet, section === 'deep_read')).found;
    const citations: Citation[] = item.claims.map((claim) => ({ n: claim.n, ref: Math.max(0, packet.documents.findIndex((document) => document.doc === claim.doc)), quote: found.get(claim.n)?.span ?? claim.quote, verdict: '' }));
    return {
      id,
      section,
      topic: packet.topic,
      format: packet.format,
      title: item.title,
      paragraphs: item.paragraphs,
      why: item.why,
      refs,
      citations,
      reason: info?.reason ?? '',
      score: info?.score ?? 0,
      keys: (info?.documents ?? []).map((document) => document.key),
      sources: [...new Set(packet.documents.map((document) => document.source))],
    };
  });
}

function issueCost(env: PipelineEnv, issue: string): number {
  return env.store.one<{ cost: number | null }>(`SELECT sum(cost) AS cost FROM calls WHERE issue = ? AND state != 'open' AND step != 'gate'`, issue)?.cost ?? 0;
}

async function renderStep(env: PipelineEnv, run: RunRow): Promise<StepResult> {
  const d = data(run);
  const items = d.quiet === undefined ? finalItems(d.final ?? [], writerPackets(env, run), d.packets ?? []) : [];
  const shadow = env.mode === 'shadow';
  const rendered = await renderEmail({
    date: run.issue,
    shadow,
    items,
    more: d.quiet === undefined && issueKind(run.issue) === 'weekday' ? (d.more ?? []) : [],
    costUsd: issueCost(env, run.issue),
    writers: d.writers ?? [],
    publicHost: env.publicHost,
    feedbackKeyHex: (env.env.FEEDBACK_SIGNING_KEY ?? '').trim(),
    now: env.clock.now(),
    quiet: d.quiet ?? null,
  });
  const hash = await renderHash(rendered);
  const kind = issueKind(run.issue) ?? 'weekday';
  const now = env.clock.now();
  env.transact(() => {
    env.store.run(
      `INSERT INTO issues (issue, kind, state, title, shadow, html, text, render_hash, item_count, dropped_count, candidate_count, writer_models, error_code, quiet_reason, more, pick_fallback, created_ms)
       VALUES (?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (issue) DO UPDATE SET state = 'ready', title = excluded.title, shadow = excluded.shadow, html = excluded.html, text = excluded.text, render_hash = excluded.render_hash,
         item_count = excluded.item_count, dropped_count = excluded.dropped_count, candidate_count = excluded.candidate_count, writer_models = excluded.writer_models,
         error_code = excluded.error_code, quiet_reason = excluded.quiet_reason, more = excluded.more, pick_fallback = excluded.pick_fallback`,
      run.issue,
      kind,
      rendered.title,
      shadow ? 1 : 0,
      rendered.html,
      rendered.text,
      hash,
      items.length,
      d.dropped ?? 0,
      d.candidates ?? 0,
      JSON.stringify(d.writers ?? []),
      d.errorCode ?? '',
      d.quiet ?? '',
      JSON.stringify(d.quiet === undefined ? (d.more ?? []) : []),
      d.pickFallback === true ? 1 : 0,
      run.created_ms,
    );
    env.store.run(`DELETE FROM issue_items WHERE issue = ?`, run.issue);
    items.forEach((item, position) => {
      env.store.insert('issue_items', {
        issue: run.issue,
        id: item.id,
        position,
        section: item.section,
        topic: item.topic,
        format: item.format,
        title: item.title,
        paragraphs: JSON.stringify(item.paragraphs),
        why: item.why,
        refs: JSON.stringify(item.refs),
        citations: JSON.stringify(item.citations),
        reason: item.reason,
        score: item.score,
        keys: JSON.stringify(item.keys),
        sources: JSON.stringify(item.sources),
      });
      // Never repeat (design §4): every key that ran, 400 days; its items are marked for the hold-back.
      if (item.section !== 'deep_read') {
        for (const key of item.keys) {
          env.store.run(`INSERT OR IGNORE INTO sent_keys (key, issue, title, ms) VALUES (?, ?, ?, ?)`, key, run.issue, item.title, now);
          env.store.run(`UPDATE items SET ran = ? WHERE key = ?`, run.issue, key);
        }
      }
    });
    if (d.quiet === undefined && issueKind(run.issue) === 'weekday') {
      // A world story that ran: its whole cluster did, so its other members never make the next day's card.
      const ran = new Set((d.final ?? []).map((entry) => entry.packet));
      for (const packet of d.packets ?? []) {
        if (typeof packet.cluster === 'number' && ran.has(packet.id)) env.store.run(`UPDATE items SET ran = ? WHERE cluster = ? AND ran IS NULL`, run.issue, packet.cluster);
      }
      // 还有 lists an item once.
      for (const rowid of d.moreRows ?? []) env.store.run(`UPDATE items SET listed = ? WHERE rowid = ? AND listed IS NULL`, run.issue, rowid);
    }
    save(env, run, now < sendTimeOf(run.issue) && items.length > 0 ? 'entail' : 'send', {});
  });
  return { next: 0, code: d.quiet === undefined ? 'rendered' : 'rendered_note' };
}

async function entailStep(env: PipelineEnv, run: RunRow, after: StepName): Promise<StepResult> {
  const rows = env.store.all<IssueItemRow>(`SELECT * FROM issue_items WHERE issue = ? ORDER BY position`, run.issue);
  const cases: EntailCase[] = [];
  for (const row of rows) {
    const paragraphs = parseJson<{ text: string }[]>(row.paragraphs, []);
    for (const citation of parseJson<Citation[]>(row.citations, [])) {
      const citing = paragraphs.flatMap((paragraph) => sentences(paragraph.text).filter((sentence) => markersOf(sentence).includes(citation.n))).map((sentence) => withoutMarkers(sentence).trim());
      if (citing.length > 0) cases.push({ item: row.id, n: citation.n, quote: citation.quote, sentences: citing.slice(0, 4) });
    }
  }
  let verdicts: Map<string, string> | null = null;
  if (cases.length > 0 && attemptsOf(env.store, run.issue, 'entail') === 0) {
    const built = entailRequest(cases);
    const outcome = await callModel(env.claude, { step: 'entail', issue: run.issue, model: GATE_MODEL, params: built.params, estimatedInputTokens: built.estimatedInputTokens, deadlineMs: 3 * MINUTE });
    if (outcome.kind === 'answer') {
      verdicts = readEntail(outcome.json, cases);
      env.transact(() => { markRead(env.store, outcome.callId); });
    }
  }
  env.transact(() => {
    const found = verdicts;
    if (found !== null && found.size > 0) {
      for (const row of rows) {
        const citations = parseJson<Citation[]>(row.citations, []).map((citation) => ({ ...citation, verdict: (found.get(`${row.id}:${String(citation.n)}`) ?? '') as Citation['verdict'] }));
        env.store.run(`UPDATE issue_items SET citations = ? WHERE issue = ? AND id = ?`, JSON.stringify(citations), run.issue, row.id);
      }
    } else env.store.pushError('entail_skipped');
    save(env, run, after, { entailed: true });
  });
  return { next: 0, code: verdicts === null ? 'entail_skipped' : 'entailed' };
}

/** Why an issue may not be sent now, or null (read at the moment of the send). */
export function sendBlocker(env: Pick<PipelineEnv, 'mode' | 'paused' | 'env'>, now: number, issue: string): string | null {
  if (env.mode !== 'shadow' && env.mode !== 'live') return `mode_${env.mode}`;
  if (env.paused) return 'paused';
  if (mailSettings(env.env) === null) return 'mail_not_configured';
  if (now >= sendCutoffOf(issue)) return 'after_cutoff';
  return null;
}

async function sendStep(env: PipelineEnv, run: RunRow): Promise<StepResult> {
  const now = env.clock.now();
  const at = sendTimeOf(run.issue);
  if (now < at) return { next: at, code: 'waiting_for_send_time' };
  const d = data(run);
  const issue = env.store.one<{ html: string; text: string; title: string; shadow: number; render_hash: string; state: string }>(`SELECT html, text, title, shadow, render_hash, state FROM issues WHERE issue = ?`, run.issue);
  if (issue === undefined) return quiet(env, run, 'write_failed', 'issue_missing');
  const next: StepName = d.entailed === true || (d.final ?? []).length === 0 ? 'done' : 'entail';
  if (sendRow(env.store, run.issue) !== null) {
    env.transact(() => { save(env, run, next, {}); });
    return { next: 0, code: 'already_sent' };
  }
  const blocker = sendBlocker(env, now, run.issue);
  const mail = mailSettings(env.env);
  if (blocker !== null || mail === null) {
    env.transact(() => {
      env.store.run(`UPDATE issues SET state = 'archived', error_code = CASE WHEN error_code = '' THEN ? ELSE error_code END WHERE issue = ?`, blocker ?? 'mail_not_configured', run.issue);
      if (blocker === 'after_cutoff') env.store.pushError('issue_missed');
      save(env, run, next, {});
    });
    return { next: 0, code: `archived_${blocker ?? 'mail'}` };
  }
  const subject = issue.shadow === 1 ? `[影子版] ${issue.title}` : issue.title;
  const result = await sendOnce(env.store, env.transact, env.fetchFn, mail, { issue: run.issue, subject, html: issue.html, text: issue.text, hash: issue.render_hash }, () => env.clock.now());
  env.transact(() => { save(env, run, next, {}); });
  return { next: 0, code: `send_${result.outcome}` };
}

// ---- the step dispatcher ---------------------------------------------------------------------------------------------------------------

/** Marks a step started (its open marker), for the crash counter. */
export function openStep(store: Store, run: RunRow, build: string, now: number): void {
  store.run(`UPDATE runs SET open_build = ?, open_ms = ? WHERE issue = ?`, build, now, run.issue);
}

/**
 * Settles a step a previous invocation left open: an older build's (a deploy) is not counted, this build's is a crash.
 * Answers the run's row as it now is, and whether the step gave up.
 */
export function settleOpenStep(store: Store, run: RunRow, build: string): { run: RunRow; gaveUp: boolean } {
  if (run.open_build === null) return { run, gaveUp: false };
  const crash = run.open_build === build;
  const crashes = run.crashes + (crash ? 1 : 0);
  store.run(`UPDATE runs SET open_build = NULL, open_ms = NULL, crashes = ? WHERE issue = ?`, crashes, run.issue);
  if (crash) store.pushError(`step_crashed`);
  return { run: { ...run, open_build: null, open_ms: null, crashes }, gaveUp: crashes >= STEP_CRASHES_MAX };
}

/** One step of an issue's run. */
export async function issueStep(env: PipelineEnv, run: RunRow): Promise<StepResult> {
  const step = run.step as StepName;
  if (step === 'done') return DONE;
  switch (step) {
    case 'pick':
      return pickStep(env, run);
    case 'shortlist':
      return shortlistStep(env, run);
    case 'thread':
      return threadStep(env, run);
    case 'read':
      return readPhase(env, run);
    case 'write':
      return writeStep(env, run);
    case 'deep_read':
      return deepReadStep(env, run);
    case 'check':
      return checkStep(env, run);
    case 'repair':
      return repairStep(env, run);
    case 'render':
      return renderStep(env, run);
    case 'entail':
      return entailStep(env, run, sendRow(env.store, run.issue) === null ? 'send' : 'done');
    case 'send':
      return sendStep(env, run);
    default:
      return DONE;
  }
}

/** A step that crashed STEP_CRASHES_MAX times gives up: the entailment log is skipped, anything else ends in the note. */
export function giveUp(env: PipelineEnv, run: RunRow): StepResult {
  const step = run.step as StepName;
  if (step === 'entail') {
    env.transact(() => { save(env, run, sendRow(env.store, run.issue) === null ? 'send' : 'done', { entailed: true }); });
    return { next: 0, code: 'entail_crashed' };
  }
  if (step === 'send') {
    env.transact(() => { save(env, run, 'done', {}); });
    return { next: 0, code: 'send_crashed' };
  }
  if (step === 'render') {
    env.transact(() => {
      env.store.run(`INSERT OR IGNORE INTO issues (issue, kind, state, created_ms) VALUES (?, ?, 'failed', ?)`, run.issue, issueKind(run.issue) ?? 'weekday', run.created_ms);
      env.store.run(`UPDATE issues SET state = 'failed', error_code = 'crashed_render' WHERE issue = ?`, run.issue);
      save(env, run, 'done', {}, { errorCode: 'crashed_render' });
    });
    return { next: 0, code: 'crashed_render' };
  }
  return quiet(env, run, 'write_failed', `crashed_${step}`);
}
