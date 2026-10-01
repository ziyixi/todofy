/**
 * Lab's owner API (proto/lab/ui/v1): one handler per rpc of LabUiService, served by the shared transcoder
 * (proto/ts/http-transcoder.ts) from src/http.ts after authentication. A handler validates what the IDL
 * cannot (value rules, limits.ts), reads D1 for the views or hands the mutation to LabState in one RPC (Workers
 * Free: 10 ms of CPU per request), and maps Lab's internal records (model.ts) to the API's messages. Errors are
 * RpcErrors with an ErrorReason (errors.proto); REASONS gives each its google.rpc.Code and its copy.
 */
import { create, type MessageInitShape } from '@ziyixi/proto/protobuf';
import { timestampFromDate, type Timestamp } from '@ziyixi/proto/protobuf/wkt';
import {
  DeckKind,
  DeckSchema,
  DeckStateSchema,
  DeckSummarySchema,
  Send_State,
  SendErrorCode,
  SendMode,
  SendSchema,
  UndoKind,
  UndoTargetSchema,
  type DeckState as DeckStateMessage,
  type Send as SendMessage,
  type UndoTarget as UndoTargetMessage,
} from '@ziyixi/proto/lab/ui/v1/deck_pb';
import type { ErrorReason } from '@ziyixi/proto/lab/ui/v1/errors_pb';
import { BuildPhase, GuardLevel, Notice, PipelineStatusSchema, SettingsSchema, TodaySchema, type Settings as SettingsMessage } from '@ziyixi/proto/lab/ui/v1/home_pb';
import {
  DecideDeckResponseSchema,
  ImportSeedsResponseSchema,
  ListLikedPapersResponseSchema,
  ListSeedsResponseSchema,
  RestartDeckResponseSchema,
  SendDeckResponseSchema,
  SnoozeDeckResponseSchema,
  UndoDeckResponseSchema,
  type LabUiService,
} from '@ziyixi/proto/lab/ui/v1/lab_ui_service_pb';
import { LikedPaperSchema, Seed_State, SeedSchema } from '@ziyixi/proto/lab/ui/v1/library_pb';
import { AnnounceType, Decision as DecisionValue, PaperSchema } from '@ziyixi/proto/lab/ui/v1/paper_pb';
import type { ServiceHandlers, ShapeOf } from '@ziyixi/proto/http-transcoder';
import { Code, errorDetail, RpcError, type ErrorDetail } from '@ziyixi/proto/rpc-status';
import { EmptySchema } from '@ziyixi/proto/protobuf/wkt';
import { isArxivId, paperKey, bareId } from './arxiv.ts';
import { isDay } from './config.ts';
import { CATEGORY_SETTING_RE, decodeCursor, deckView, readDeck, readLiked, readLikedPaper, readSeeds, readSettings, sendRowFrom, summaryView, type SendDbRow } from './db.ts';
import type { Env } from './env.ts';
import { pollable, SEND_MODES, sendStatus } from './intent.ts';
import { CATEGORIES_MAX, DECK_VERSION_MAX, LIKED_FILTER_MAX, LIKED_PAGE, SEED_INPUT_MAX, SEEDS_MAX } from './limits.ts';
import type * as model from './model.ts';
import { TLDR_MODELS } from './models.ts';
import { settingsResponse, type DeckMutationInput, type OwnerResult } from './owner.ts';
import { LAB_OBJECT, type LabState } from './state.ts';

/** What every handler gets: the bindings (src/http.ts authenticated the owner before routing). */
export interface ApiContext {
  readonly env: Env;
}

type Reason = Exclude<keyof typeof ErrorReason, 'UNSPECIFIED'>;

/**
 * Each reason's code (errors.proto lists the same), its developer message and its user-facing copy (the
 * LocalizedMessage). Exhaustive: a new ErrorReason fails the typecheck until it is mapped here.
 */
export const REASONS: Readonly<Record<Reason, { readonly code: Code; readonly message: string; readonly zh: string }>> = {
  UNAUTHORIZED: { code: Code.UNAUTHENTICATED, message: 'no valid Cloudflare Access login for the owner', zh: '未登录或凭据无效' },
  ACCESS_NOT_CONFIGURED: { code: Code.UNAVAILABLE, message: 'the Access settings are incomplete', zh: 'Cloudflare Access 配置不完整' },
  NOT_CONFIGURED: { code: Code.UNAVAILABLE, message: 'a required secret is missing', zh: '服务缺少必需的密钥配置' },
  CSRF_FAILED: { code: Code.PERMISSION_DENIED, message: 'the CSRF token or Origin is not valid', zh: '页面安全令牌已失效，请刷新后重试' },
  BAD_REQUEST: { code: Code.INVALID_ARGUMENT, message: 'the request is not valid', zh: '请求格式不正确' },
  NOT_FOUND: { code: Code.NOT_FOUND, message: 'no such resource', zh: '找不到该资源' },
  METHOD_NOT_ALLOWED: { code: Code.UNIMPLEMENTED, message: 'this method is not allowed on this path', zh: '不支持该请求方法' },
  UNAVAILABLE: { code: Code.UNAVAILABLE, message: 'the service is unavailable; repeat the request', zh: '服务暂时不可用，请稍后再试' },
  DECK_NOT_FOUND: { code: Code.NOT_FOUND, message: 'no ready deck for that day', zh: '找不到这组卡片' },
  DECK_CHANGED: { code: Code.ABORTED, message: 'the deck changed since base_version', zh: '这组卡片已在其他设备上改动' },
  ALREADY_DECIDED: { code: Code.ALREADY_EXISTS, message: 'the card is decided already', zh: '这张卡片已经选过了' },
  NOTHING_TO_UNDO: { code: Code.FAILED_PRECONDITION, message: 'nothing to undo', zh: '没有可以撤销的操作' },
  DECK_LOG_FULL: { code: Code.FAILED_PRECONDITION, message: 'the deck decision log is full', zh: '这组卡片的操作次数已达上限' },
  NOT_IN_DECK: { code: Code.NOT_FOUND, message: 'the paper is not a card of this deck', zh: '这篇论文不在这组卡片里' },
  NOTHING_TO_SEND: { code: Code.FAILED_PRECONDITION, message: 'no paper to send', zh: '没有需要发送的论文' },
  SEND_IN_PROGRESS: { code: Code.ABORTED, message: 'the send in flight holds this deck', zh: '这些论文正在发送中' },
  SEEDS_FULL: { code: Code.FAILED_PRECONDITION, message: `at most ${String(SEEDS_MAX)} seeds`, zh: `种子最多 ${String(SEEDS_MAX)} 篇` },
  ALREADY_LIKED: { code: Code.ALREADY_EXISTS, message: 'the paper is liked already', zh: '已经喜欢过这篇论文' },
};

export function labError(reason: Reason, details: readonly ErrorDetail[] = [], headers: Readonly<Record<string, string>> = {}): RpcError {
  const { code, message } = REASONS[reason];
  return new RpcError(code, reason, message, { details, headers });
}

export function isReason(value: string): value is Reason {
  return Object.hasOwn(REASONS, value);
}

function bad(): never {
  throw labError('BAD_REQUEST');
}

// ---- names ------------------------------------------------------------------------------------------------

const DECK_NAME = /^decks\/([^/]+)(?:\/(summary|send))?$/;

/** The day of `decks/{deck}` (or its summary or send): DECK_NOT_FOUND for anything that is not a day. */
function dayOf(name: string, child?: 'summary' | 'send'): string {
  const match = DECK_NAME.exec(name);
  const day = match?.[1] ?? '';
  if (match === null || match[2] !== child || !isDay(day)) throw labError('DECK_NOT_FOUND');
  return day;
}

/**
 * A paper's resource ID (likedPapers/{id}, seeds/{id}): its bare arXiv ID, with the `/` of an old-style ID
 * (hep-th/9901001) written as `~` (hep-th~9901001), since a resource ID has no `/` (AIP-122).
 */
export function resourceIdOf(key: string): string {
  return (bareId(key) ?? key).replace('/', '~');
}

function keyOfResource(name: string, collection: 'likedPapers' | 'seeds'): string {
  const prefix = `${collection}/`;
  const id = name.startsWith(prefix) ? name.slice(prefix.length).replace('~', '/') : '';
  return isArxivId(id) ? paperKey(id) : bad();
}

/** The op ID of a mutation: its request_id (the transcoder checked and lower-cased it), else a fresh one. */
function opOf(requestId: string): string {
  return requestId === '' ? crypto.randomUUID() : requestId;
}

// ---- internal records as messages -----------------------------------------------------------------------------

function time(iso: string | null): Timestamp | undefined {
  return iso === null ? undefined : timestampFromDate(new Date(iso));
}

const DECISIONS = { like: DecisionValue.LIKE, dislike: DecisionValue.DISLIKE } as const satisfies Record<model.Decision, DecisionValue>;

function decisionOf(value: DecisionValue): model.Decision {
  if (value === DecisionValue.LIKE) return 'like';
  if (value === DecisionValue.DISLIKE) return 'dislike';
  return bad();
}

const SEND_MODE_VALUES = { subtasks: SendMode.SUBTASKS, separate: SendMode.SEPARATE } as const satisfies Record<model.SendMode, SendMode>;

function sendModeOf(value: SendMode): model.SendMode {
  const name = Object.entries(SEND_MODE_VALUES).find(([, v]) => v === value)?.[0];
  return name !== undefined && SEND_MODES.value(name) !== undefined ? (name as model.SendMode) : bad();
}

const SEND_STATES = {
  sending: Send_State.SENDING,
  pending: Send_State.PENDING,
  created: Send_State.CREATED,
  duplicate: Send_State.DUPLICATE,
  paused: Send_State.PAUSED,
  failed: Send_State.FAILED,
  rejected: Send_State.REJECTED,
  unknown: Send_State.UNKNOWN,
} as const satisfies Record<model.SendState, Send_State>;

/** task-intent-v1's error codes and Lab's own: exhaustive, so a new Todofy code fails the typecheck until mapped. */
const SEND_ERRORS = {
  maintenance: SendErrorCode.MAINTENANCE,
  processing_paused: SendErrorCode.PROCESSING_PAUSED,
  todoist_paused: SendErrorCode.TODOIST_PAUSED,
  todoist_blocked: SendErrorCode.TODOIST_BLOCKED,
  backup_active: SendErrorCode.BACKUP_ACTIVE,
  rate_limited: SendErrorCode.RATE_LIMITED,
  retry_wait: SendErrorCode.RETRY_WAIT,
  todoist_rejected: SendErrorCode.TODOIST_REJECTED,
  todoist_result_unknown: SendErrorCode.TODOIST_RESULT_UNKNOWN,
  intent_conflict: SendErrorCode.INTENT_CONFLICT,
  daily_limit: SendErrorCode.DAILY_LIMIT,
  url_not_allowed: SendErrorCode.URL_NOT_ALLOWED,
  source_not_allowed: SendErrorCode.SOURCE_NOT_ALLOWED,
  invalid_input: SendErrorCode.INVALID_INPUT,
  unavailable: SendErrorCode.UNAVAILABLE,
  busy: SendErrorCode.BUSY,
} as const satisfies Record<NonNullable<model.SendStatus['error_code']>, SendErrorCode>;

function paperMessage(p: model.Paper): MessageInitShape<typeof PaperSchema> {
  return {
    id: p.id,
    version: p.version,
    title: p.title,
    authors: p.authors,
    categories: [...p.categories],
    primaryCategory: p.primary_category,
    abstractText: p.abstract,
    announceType: p.announce_type === 'cross' ? AnnounceType.CROSS : AnnounceType.NEW,
    abstractUri: p.abs_url,
    pdfUri: p.pdf_url,
    newVersion: p.new_version,
  };
}

function undoMessage(undo: model.UndoTarget): MessageInitShape<typeof DeckStateSchema>['undo'] {
  if (undo === null) return undefined;
  return undo.kind === 'decide'
    ? { kind: UndoKind.DECIDE, paperId: undo.paper_id, decision: DECISIONS[undo.decision] }
    : { kind: UndoKind.RESTART, clearedCount: undo.cleared };
}

export function deckStateMessage(state: model.DeckState): DeckStateMessage {
  return create(DeckStateSchema, {
    deck: `decks/${state.deck_id}`,
    version: state.version,
    decisions: Object.fromEntries(Object.entries(state.decisions).map(([paper, decision]) => [paper, DECISIONS[decision]])),
    counts: { ...state.counts },
    nextPosition: state.next_position ?? undefined,
    finishTime: time(state.finished_at),
    undo: undoMessage(state.undo),
  });
}

export function sendMessage(deckId: string, send: model.SendStatus): SendMessage {
  return create(SendSchema, {
    name: `decks/${deckId}/send`,
    generation: send.generation,
    intentId: send.intent_id,
    mode: SEND_MODE_VALUES[send.mode],
    state: SEND_STATES[send.state],
    recorded: send.recorded,
    itemCount: send.items,
    tasksTotal: send.tasks_total,
    tasksCreated: send.tasks_created,
    errorCode: send.error_code === null ? SendErrorCode.UNSPECIFIED : SEND_ERRORS[send.error_code],
    frozen: send.frozen,
    nextPollTime: time(send.poll_after),
    updateTime: time(send.updated_at),
  });
}

function undoTargetMessage(undo: NonNullable<model.UndoTarget>): UndoTargetMessage {
  return create(UndoTargetSchema, undoMessage(undo));
}

function summaryMessage(summary: model.DeckSummary) {
  return create(DeckSummarySchema, {
    name: `decks/${summary.deck_id}/summary`,
    state: deckStateMessage(summary.state),
    likedItems: summary.liked.map((item) => ({
      position: item.position,
      paperId: item.paper_id,
      title: item.title,
      briefLine: item.brief_line ?? undefined,
      abstractUri: item.abs_url,
      excluded: item.excluded,
      sentGeneration: item.sent_generation ?? undefined,
    })),
    sendableCount: summary.sendable,
    latestSend: summary.send === null ? undefined : sendMessage(summary.deck_id, summary.send),
    defaultMode: SEND_MODE_VALUES[summary.default_mode],
  });
}

function likedMessage(paper: model.LikedPaper): MessageInitShape<typeof LikedPaperSchema> {
  return {
    name: `likedPapers/${resourceIdOf(paper.id)}`,
    paper: paperMessage(paper),
    brief: paper.brief ?? undefined,
    createTime: time(paper.liked_at),
    deck: paper.deck_id === null ? '' : `decks/${paper.deck_id}`,
  };
}

const SEED_STATES = { pending: Seed_State.PENDING, resolved: Seed_State.RESOLVED, not_found: Seed_State.NOT_FOUND } as const satisfies Record<model.SeedState, Seed_State>;

function seedMessage(seed: model.Seed): MessageInitShape<typeof SeedSchema> {
  return {
    name: `seeds/${resourceIdOf(seed.paper_id)}`,
    paperId: seed.paper_id,
    title: seed.title ?? undefined,
    state: SEED_STATES[seed.state],
    createTime: time(seed.added_at),
  };
}

function settingsMessage(settings: model.SettingsResponse) {
  return create(SettingsSchema, {
    name: 'settings',
    categories: [...settings.categories],
    dislikeWeight: settings.lambda,
    neuronCap: settings.neuron_cap,
    summaryModel: settings.tldr_model,
    ingestPaused: settings.ingest_paused,
    sendMode: SEND_MODE_VALUES[settings.send_mode],
    neuronCeiling: settings.ceiling,
    summaryModels: [...settings.tldr_models],
  });
}

const PHASES = {
  waiting: BuildPhase.WAITING,
  fetching: BuildPhase.FETCHING,
  embedding: BuildPhase.EMBEDDING,
  ranking: BuildPhase.RANKING,
  summarizing: BuildPhase.SUMMARIZING,
  paused: BuildPhase.PAUSED,
  cap_hit: BuildPhase.CAP_HIT,
  failed: BuildPhase.FAILED,
} as const satisfies Record<model.BuildPhase, BuildPhase>;
const NOTICES = { cap_hit: Notice.CAP_HIT, feed_stale: Notice.FEED_STALE, paused: Notice.PAUSED } as const satisfies Record<NonNullable<model.TodayResponse['notice']>, Notice>;
const KINDS = { ranked: DeckKind.RANKED, explore: DeckKind.EXPLORE } as const satisfies Record<model.DeckKind, DeckKind>;

function pointerMessage(pointer: model.DeckPointer) {
  return { deck: `decks/${pointer.deck_id}`, kind: KINDS[pointer.kind], total: pointer.total, decided: pointer.decided, finished: pointer.finished };
}

// ---- LabState ---------------------------------------------------------------------------------------------------

function lab(env: Env): DurableObjectStub<LabState> {
  return env.LAB.get(env.LAB.idFromName(LAB_OBJECT));
}

/** Any failure of the Durable Object call is UNAVAILABLE (the request may be repeated with its request_id). */
async function callLab<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw labError('UNAVAILABLE');
  }
}

/** An OwnerResult's body, or its failure as the reason of the same name (DECK_CHANGED carries the current state). */
async function owned<T>(fn: () => Promise<OwnerResult<T>>): Promise<T> {
  const result = (await callLab(fn as () => Promise<unknown>)) as OwnerResult<T>;
  if (result.ok) return result.body;
  const reason = result.code.toUpperCase();
  const details = result.state === undefined ? [] : [errorDetail(DeckStateSchema, deckStateMessage(result.state))];
  throw labError(isReason(reason) ? reason : 'UNAVAILABLE', details);
}

function deckMutation(day: string, input: DeckMutationInput, env: Env): Promise<model.DeckMutationResponse> {
  return owned(() => lab(env).mutateDeck(day, input) as Promise<OwnerResult<model.DeckMutationResponse>>);
}

function baseVersion(value: number): number {
  return value >= 0 && value <= DECK_VERSION_MAX ? value : bad();
}

function paperIdOf(value: string): string {
  return bareId(value) === null ? bad() : value;
}

/**
 * The editable settings of an UpdateSettings request after the value rules the IDL cannot express (1 to
 * CATEGORIES_MAX distinct categories, λ in 0-1, a known model); BAD_REQUEST otherwise. LabState refuses a cap
 * above the ceiling.
 */
export function settingsOf(settings: SettingsMessage): model.Settings {
  const categories = settings.categories;
  const valid =
    categories.length >= 1 &&
    categories.length <= CATEGORIES_MAX &&
    categories.every((c) => CATEGORY_SETTING_RE.test(c)) &&
    new Set(categories).size === categories.length &&
    settings.dislikeWeight >= 0 &&
    settings.dislikeWeight <= 1 &&
    settings.neuronCap >= 0 &&
    (TLDR_MODELS as readonly string[]).includes(settings.summaryModel);
  if (!valid) bad();
  return {
    categories: [...categories],
    lambda: settings.dislikeWeight,
    neuron_cap: settings.neuronCap,
    tldr_model: settings.summaryModel as model.Settings['tldr_model'],
    ingest_paused: settings.ingestPaused,
    send_mode: sendModeOf(settings.sendMode),
  };
}

// ---- the handlers -------------------------------------------------------------------------------------------------

export const handlers: ServiceHandlers<ShapeOf<typeof LabUiService>, ApiContext> = {
  async getToday(_request, { env }) {
    const today = await callLab(() => lab(env).today() as Promise<model.TodayResponse>);
    return create(TodaySchema, {
      name: 'today',
      deck: today.deck === null ? undefined : pointerMessage(today.deck),
      building: today.building === null ? undefined : { day: today.building.day ?? undefined, phase: PHASES[today.building.phase] },
      nextFetchTime: time(today.next_run_at),
      coldStart: today.cold_start,
      olderUnfinishedDecks: today.older_unfinished.map(pointerMessage),
      notice: today.notice === null ? Notice.UNSPECIFIED : NOTICES[today.notice],
    });
  },

  async getPipelineStatus(_request, { env }) {
    const status = await callLab(() => lab(env).statusView() as Promise<model.StatusResponse>);
    return create(PipelineStatusSchema, {
      name: 'pipelineStatus',
      ingestedLastDay: status.counters.ingested_24h,
      rankedLastDay: status.counters.ranked_24h,
      likedLastWeek: status.counters.liked_7d,
      decidedLastWeek: status.counters.decided_7d,
      neuronsToday: status.counters.neurons_today,
      neuronCap: status.counters.neuron_cap,
      lastFetchTime: time(status.last_fetch_at),
      lastFetchError: status.last_fetch_error ?? undefined,
      guardLevel: status.guard.level === 'shed' ? GuardLevel.SHED : GuardLevel.NORMAL,
      guardEndTime: time(status.guard.until),
      build: status.build ?? '',
    });
  },

  async getDeck(request, { env }) {
    const bundle = await readDeck(env.DB, dayOf(request.name));
    if (bundle === null || bundle.deck.ready_at === null) throw labError('DECK_NOT_FOUND');
    const deck = deckView(bundle);
    return create(DeckSchema, {
      name: `decks/${deck.deck_id}`,
      kind: KINDS[deck.kind],
      createTime: time(deck.created_at),
      cards: deck.cards.map((card) => ({
        position: card.position,
        paper: paperMessage(card.paper),
        brief: card.brief ?? undefined,
        because: card.because === null ? undefined : { paperId: card.because.id, title: card.because.title },
      })),
      state: deckStateMessage(deck.state),
      latestSend: deck.send === null ? undefined : sendMessage(deck.deck_id, deck.send),
      snoozeTime: time(deck.later_at),
    });
  },

  async decideDeck(request, { env }) {
    const day = dayOf(request.name);
    const input: DeckMutationInput = {
      kind: 'decide',
      op_id: opOf(request.requestId),
      base_version: baseVersion(request.baseVersion),
      paper_id: paperIdOf(request.paperId),
      decision: decisionOf(request.decision),
    };
    const result = await deckMutation(day, input, env);
    return create(DecideDeckResponseSchema, { state: deckStateMessage(result.state) });
  },

  async undoDeck(request, { env }) {
    const day = dayOf(request.name);
    const result = await deckMutation(day, { kind: 'undo', op_id: opOf(request.requestId), base_version: baseVersion(request.baseVersion) }, env);
    // A stored response of an older build may lack `applied`; the state is what the UI adopts.
    const undone = result.applied.kind === 'undo' ? undoTargetMessage(result.applied.undone) : undefined;
    return create(UndoDeckResponseSchema, { state: deckStateMessage(result.state), undone });
  },

  async restartDeck(request, { env }) {
    const day = dayOf(request.name);
    const result = await deckMutation(day, { kind: 'restart', op_id: opOf(request.requestId), base_version: baseVersion(request.baseVersion) }, env);
    return create(RestartDeckResponseSchema, { state: deckStateMessage(result.state), clearedCount: result.applied.kind === 'restart' ? result.applied.cleared : 0 });
  },

  async snoozeDeck(request, { env }) {
    const day = dayOf(request.name);
    const op = opOf(request.requestId);
    const result = await owned(() => lab(env).later(day, op) as Promise<OwnerResult<{ later_at: string }>>);
    return create(SnoozeDeckResponseSchema, { snoozeTime: time(result.later_at) });
  },

  async excludePaper(request, { env }) {
    const day = dayOf(request.name, 'summary');
    const op = opOf(request.requestId);
    const paper = paperIdOf(request.paperId);
    const summary = await owned(() => lab(env).exclude(day, op, paper, request.excluded) as Promise<OwnerResult<model.DeckSummary>>);
    return summaryMessage(summary);
  },

  async sendDeck(request, { env }) {
    const day = dayOf(request.name);
    const op = opOf(request.requestId);
    const mode = sendModeOf(request.mode);
    const send = await owned(() => lab(env).send(day, op, mode) as Promise<OwnerResult<model.SendStatus>>);
    return create(SendDeckResponseSchema, { send: sendMessage(day, send) });
  },

  async getDeckSummary(request, { env }) {
    const day = dayOf(request.name, 'summary');
    const [bundle, settings] = await Promise.all([readDeck(env.DB, day), readSettings(env.DB)]);
    if (bundle === null || bundle.deck.ready_at === null) throw labError('DECK_NOT_FOUND');
    return summaryMessage(summaryView(bundle, settings.send_mode));
  },

  async getSend(request, { env }) {
    const day = dayOf(request.name, 'send');
    const row = await env.DB.prepare('SELECT * FROM sends WHERE deck_id = ? ORDER BY generation DESC LIMIT 1').bind(day).first<SendDbRow>();
    if (row === null) throw labError('NOT_FOUND');
    const send = sendRowFrom(row);
    // A send waiting for Todofy is refreshed by LabState once its poll time has come.
    if (pollable(send) && (send.next_poll_at === null || send.next_poll_at <= Date.now())) {
      const result = await callLab(() => lab(env).pollSend(day) as Promise<OwnerResult<model.SendStatus | null>>);
      if (result.ok && result.body !== null) return sendMessage(day, result.body);
    }
    return sendMessage(day, sendStatus(send));
  },

  async listLikedPapers(request, { env }) {
    if (request.pageSize < 0 || request.filter.length > LIKED_FILTER_MAX) bad();
    const cursor = decodeCursor(request.pageToken);
    if (request.pageToken !== '' && cursor === null) bad();
    const page = await readLiked(env.DB, cursor, request.filter === '' ? null : request.filter, request.pageSize === 0 ? LIKED_PAGE : request.pageSize);
    return create(ListLikedPapersResponseSchema, { likedPapers: page.papers.map(likedMessage), nextPageToken: page.next_cursor ?? '' });
  },

  async deleteLikedPaper(request, { env }) {
    const paper = keyOfResource(request.name, 'likedPapers');
    const op = opOf(request.requestId);
    await owned(() => lab(env).feedback(op, paper, null) as Promise<OwnerResult<model.FeedbackResponse>>);
    return create(EmptySchema);
  },

  async createLikedPaper(request, { env }) {
    const paper = keyOfResource(`likedPapers/${request.likedPaperId}`, 'likedPapers');
    const op = opOf(request.requestId);
    await owned(() => lab(env).feedback(op, paper, 'like', true) as Promise<OwnerResult<model.FeedbackResponse>>);
    const liked = await readLikedPaper(env.DB, paper);
    if (liked === null) throw labError('UNAVAILABLE');
    return create(LikedPaperSchema, likedMessage(liked));
  },

  async listSeeds(request, { env }) {
    if (request.pageSize < 0 || request.pageToken !== '') bad();
    const seeds = await readSeeds(env.DB);
    return create(ListSeedsResponseSchema, { seeds: seeds.map(seedMessage) });
  },

  async importSeeds(request, { env }) {
    const inputs = request.inputs;
    if (inputs.length === 0 || inputs.length > SEEDS_MAX || inputs.some((input) => input.length > SEED_INPUT_MAX)) bad();
    const op = opOf(request.requestId);
    const seeds = await owned(() => lab(env).addSeeds(op, inputs) as Promise<OwnerResult<model.SeedsResponse>>);
    return create(ImportSeedsResponseSchema, { seeds: seeds.seeds.map(seedMessage) });
  },

  async deleteSeed(request, { env }) {
    const paper = keyOfResource(request.name, 'seeds');
    const op = opOf(request.requestId);
    await owned(() => lab(env).removeSeed(op, paper) as Promise<OwnerResult<model.SeedsResponse>>);
    return create(EmptySchema);
  },

  async getSettings(_request, { env }) {
    return settingsMessage(await settingsResponse({ db: env.DB, env }));
  },

  async updateSettings(request, { env }) {
    const next = settingsOf(request.settings ?? bad());
    const op = opOf(request.requestId);
    return settingsMessage(await owned(() => lab(env).putSettings(op, next) as Promise<OwnerResult<model.SettingsResponse>>));
  },
};
