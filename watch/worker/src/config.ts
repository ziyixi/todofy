/**
 * A watch's settings (../../docs/design.md §3): the owner's fields of watch.ui.v1.Watch read into one plain, checked
 * value that the pipeline uses, and the value rules the IDL cannot express (limits.ts holds the numbers).
 *
 * The stored form of the settings is the wire JSON of a Watch that holds only the owner's fields (`settingsWire`), so
 * an AIP-134 update mask applies to it field by field and a later field of the IDL needs no migration. `readConfig`
 * turns a Watch into a WatchConfig or names the first rule it breaks; it is pure, and the HTMLRewriter selector check
 * is passed in (Node has no HTMLRewriter, the unit tests pass a stand-in).
 *
 * Two hashes of a config decide what a check may reuse (pipeline.ts):
 * - `readHash`: what is read (uri, source, normalize, fetcher, request_locale, fetch_policy). When it changes, the next
 *   check sets a new notified state without a change;
 * - `checkHash`: everything the pipeline uses (also the trigger and the confirmation). When it changes, the next check
 *   evaluates its page even if the bytes did not change.
 */
import {
  EmbeddedSource_Kind,
  Watch_Fetcher,
  Watch_NotifyPolicy,
  WatchSchema,
  type Trigger,
  type Watch,
  type WatchSource,
} from '@ziyixi/proto/watch/ui/v1/watch_pb';
import { create } from '@ziyixi/proto/protobuf';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { parsePath } from './extract/jsonpath.ts';
import {
  AI_INTENT_MAX,
  CHANGE_PERCENT_MAX,
  CONFIRM_DELAY,
  DEFAULT_LOCALE,
  DISPLAY_NAME_MAX,
  IGNORED_LINE_MAX,
  IGNORED_LINES_MAX,
  INTERVAL,
  LOCALE_MAX,
  MIN_CHANGED_LINES_MAX,
  MIN_NEW_ITEMS_MAX,
  NUMBER_LABEL_MAX,
  SELECTOR_MAX,
  SELECTORS_MAX,
  TRIGGER_TEXT_MAX,
} from './limits.ts';
import { checkUri } from './url-policy.ts';

export type SourceConfig =
  | { readonly kind: 'html'; readonly include: readonly string[]; readonly exclude: readonly string[]; readonly keepLinks: boolean; readonly keepLandmarks: boolean }
  | { readonly kind: 'feed'; readonly includeSummaries: boolean }
  | { readonly kind: 'json'; readonly path: string }
  | { readonly kind: 'embedded'; readonly embedded: 'json_ld' | 'next_data'; readonly path: string };

export type TriggerConfig =
  | { readonly kind: 'any_change'; readonly minLines: number; readonly minPercent: number }
  | { readonly kind: 'text_appears' | 'text_disappears'; readonly text: string }
  | { readonly kind: 'new_item'; readonly minItems: number }
  | { readonly kind: 'number'; readonly upper: number | null; readonly lower: number | null; readonly changePercent: number; readonly label: string }
  | { readonly kind: 'availability'; readonly onlyWhenAvailable: boolean };

export type TriggerKind = TriggerConfig['kind'];

export interface NormalizeConfig {
  readonly ignoredLines: readonly string[];
  readonly defaultMasks: boolean;
  readonly maskNumbers: boolean;
}

export interface WatchConfig {
  readonly displayName: string;
  /** The URL as fetched (normalized by url-policy.ts: no fragment). */
  readonly uri: string;
  readonly host: string;
  readonly source: SourceConfig;
  readonly normalize: NormalizeConfig;
  readonly trigger: TriggerConfig;
  /** The confirmation fetch: null when skipped (and always for a non-HTML source). */
  readonly confirmDelayMinutes: number | null;
  readonly intervalMinutes: number;
  readonly fetcher: 'http' | 'browser';
  readonly notify: 'digest' | 'urgent';
  readonly locale: string;
  readonly aiIntent: string;
  readonly allowHttp: boolean;
  readonly ignoreRobots: boolean;
}

/** Why a Watch cannot be saved: an ErrorReason of watch.ui.v1, or the common BAD_REQUEST. */
export type ConfigProblem =
  | 'BAD_REQUEST'
  | 'INVALID_URI'
  | 'INVALID_SELECTOR'
  | 'INVALID_SOURCE'
  | 'INVALID_TRIGGER'
  | 'INVALID_INTERVAL'
  | 'AI_NOT_AVAILABLE'
  | 'BROWSER_NOT_AVAILABLE';

export interface ConfigEnv {
  /** Whether HTMLRewriter accepts the selector (extract/html.ts supportedSelector in the Worker). */
  readonly selectorOk: (selector: string) => boolean;
  /** The deployment has a browser binding. */
  readonly browserEnabled: boolean;
}

/** The owner's fields of Watch: the stored settings and what an update mask may name besides `shadow_mode`. */
export const SETTINGS_FIELDS = [
  'display_name',
  'uri',
  'source',
  'normalize',
  'trigger',
  'stability',
  'check_interval_minutes',
  'fetcher',
  'notify_policy',
  'request_locale',
  'ai',
  'fetch_policy',
] as const;

/** The length of `text` in Unicode code points. */
export function codePoints(text: string): number {
  return Array.from(text).length;
}

/** The number of fields of a "one of" message that are set. */
function setCount(message: object | undefined, fields: readonly string[]): number {
  if (message === undefined) return 0;
  const record = message as Record<string, unknown>;
  return fields.filter((field) => record[field] !== undefined).length;
}

function readSource(source: WatchSource | undefined, env: ConfigEnv): SourceConfig | ConfigProblem {
  if (setCount(source, ['html', 'feed', 'json', 'embedded']) > 1) return 'INVALID_SOURCE';
  if (source?.feed !== undefined) return { kind: 'feed', includeSummaries: source.feed.includeSummaries };
  if (source?.json !== undefined) {
    if (parsePath(source.json.path) === null) return 'INVALID_SOURCE';
    return { kind: 'json', path: source.json.path.trim() };
  }
  if (source?.embedded !== undefined) {
    const kind = source.embedded.kind === EmbeddedSource_Kind.NEXT_DATA ? 'next_data' : 'json_ld';
    const path = source.embedded.path.trim();
    if (parsePath(path) === null || (kind === 'next_data' && (path === '' || path === '$'))) return 'INVALID_SOURCE';
    return { kind: 'embedded', embedded: kind, path };
  }
  const html = source?.html;
  const include = html?.includeSelectors.map((selector) => selector.trim()) ?? [];
  const exclude = html?.excludeSelectors.map((selector) => selector.trim()) ?? [];
  for (const list of [include, exclude]) {
    if (list.length > SELECTORS_MAX) return 'INVALID_SELECTOR';
    if (list.some((selector) => selector === '' || selector.length > SELECTOR_MAX || !env.selectorOk(selector))) return 'INVALID_SELECTOR';
  }
  return { kind: 'html', include, exclude, keepLinks: html?.keepLinks ?? false, keepLandmarks: html?.keepLandmarks ?? false };
}

function finite(value: number | undefined): number | null | 'bad' {
  if (value === undefined) return null;
  return Number.isFinite(value) ? value : 'bad';
}

function readTrigger(trigger: Trigger | undefined, source: SourceConfig): TriggerConfig | ConfigProblem {
  if (setCount(trigger, ['anyChange', 'textAppears', 'textDisappears', 'newItem', 'number', 'availability']) > 1) return 'INVALID_TRIGGER';
  const text = trigger?.textAppears ?? trigger?.textDisappears;
  if (text !== undefined) {
    const value = text.text.trim();
    if (value === '' || codePoints(value) > TRIGGER_TEXT_MAX) return 'INVALID_TRIGGER';
    return { kind: trigger?.textAppears !== undefined ? 'text_appears' : 'text_disappears', text: value };
  }
  if (trigger?.newItem !== undefined) {
    const min = trigger.newItem.minNewItems;
    if (min < 0 || min > MIN_NEW_ITEMS_MAX) return 'INVALID_TRIGGER';
    return { kind: 'new_item', minItems: Math.max(1, min) };
  }
  if (trigger?.number !== undefined) {
    const { upperThreshold, lowerThreshold, changePercent, label } = trigger.number;
    const upper = finite(upperThreshold);
    const lower = finite(lowerThreshold);
    if (upper === 'bad' || lower === 'bad' || !Number.isFinite(changePercent) || changePercent < 0 || changePercent > CHANGE_PERCENT_MAX) return 'INVALID_TRIGGER';
    if (upper === null && lower === null && changePercent === 0) return 'INVALID_TRIGGER';
    if (codePoints(label) > NUMBER_LABEL_MAX) return 'INVALID_TRIGGER';
    return { kind: 'number', upper, lower, changePercent, label: label.trim() };
  }
  if (trigger?.availability !== undefined) {
    if (source.kind !== 'embedded' || source.embedded !== 'json_ld') return 'INVALID_TRIGGER';
    return { kind: 'availability', onlyWhenAvailable: trigger.availability.onlyWhenAvailable };
  }
  const any = trigger?.anyChange;
  const minLines = any?.minChangedLines ?? 0;
  const minPercent = any?.minChangedPercent ?? 0;
  if (minLines < 0 || minLines > MIN_CHANGED_LINES_MAX || minPercent < 0 || minPercent > 100) return 'INVALID_TRIGGER';
  return { kind: 'any_change', minLines: Math.max(1, minLines), minPercent };
}

/** Whether a header value is safe as Accept-Language (visible ASCII and spaces, no separators of other headers). */
const LOCALE_PATTERN = /^[A-Za-z0-9*,;=. -]*$/;

/** A Watch's settings as a WatchConfig, or the first rule they break. */
export function readConfig(watch: Watch, env: ConfigEnv): WatchConfig | ConfigProblem {
  const name = watch.displayName.trim();
  if (name === '' || codePoints(name) > DISPLAY_NAME_MAX) return 'BAD_REQUEST';
  const allowHttp = watch.fetchPolicy?.allowHttp ?? false;
  const url = checkUri(watch.uri.trim(), { allowHttp });
  if (url === null) return 'INVALID_URI';
  const source = readSource(watch.source, env);
  if (typeof source === 'string') return source;
  const trigger = readTrigger(watch.trigger, source);
  if (typeof trigger === 'string') return trigger;
  const normalize = watch.normalize;
  const ignored = normalize?.ignoredLines ?? [];
  if (ignored.length > IGNORED_LINES_MAX || ignored.some((line) => line === '' || codePoints(line) > IGNORED_LINE_MAX)) return 'BAD_REQUEST';
  const delay = watch.stability?.confirmDelayMinutes ?? 0;
  if (delay !== 0 && (delay < CONFIRM_DELAY.min || delay > CONFIRM_DELAY.max)) return 'BAD_REQUEST';
  if (watch.fetcher !== Watch_Fetcher.UNSPECIFIED && watch.fetcher !== Watch_Fetcher.HTTP && watch.fetcher !== Watch_Fetcher.BROWSER) return 'BAD_REQUEST';
  const fetcher = watch.fetcher === Watch_Fetcher.BROWSER ? 'browser' : 'http';
  const range = INTERVAL[fetcher];
  const interval = watch.checkIntervalMinutes === 0 ? range.defaultMinutes : watch.checkIntervalMinutes;
  if (interval < range.min || interval > range.max) return 'INVALID_INTERVAL';
  const locale = watch.requestLocale.trim();
  if (locale.length > LOCALE_MAX || !LOCALE_PATTERN.test(locale)) return 'BAD_REQUEST';
  if (codePoints(watch.ai?.intent ?? '') > AI_INTENT_MAX) return 'BAD_REQUEST';
  if (watch.ai?.enabled === true) return 'AI_NOT_AVAILABLE';
  if (fetcher === 'browser' && !env.browserEnabled) return 'BROWSER_NOT_AVAILABLE';
  // The confirmation fetch is for pages only: feeds and structured sources are what the site publishes.
  const confirm = source.kind === 'html' && watch.stability?.skipConfirmation !== true ? (delay === 0 ? CONFIRM_DELAY.defaultMinutes : delay) : null;
  return {
    displayName: name,
    uri: url.href,
    host: url.hostname.toLowerCase(),
    source,
    normalize: { ignoredLines: [...ignored], defaultMasks: normalize?.disableDefaultMasks !== true, maskNumbers: normalize?.maskNumbers === true },
    trigger,
    confirmDelayMinutes: confirm,
    intervalMinutes: interval,
    fetcher,
    notify: watch.notifyPolicy === Watch_NotifyPolicy.URGENT ? 'urgent' : 'digest',
    locale: locale === '' ? DEFAULT_LOCALE : locale,
    aiIntent: watch.ai?.intent ?? '',
    allowHttp,
    ignoreRobots: watch.fetchPolicy?.ignoreRobots ?? false,
  };
}

/** The wire JSON of the owner's fields of `watch` (the stored settings): every other field dropped. */
export function settingsWire(watch: Watch): Record<string, unknown> {
  const wire = toWire(WatchSchema, watch) as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const field of SETTINGS_FIELDS) if (wire[field] !== undefined && wire[field] !== null) kept[field] = wire[field];
  // The URI as stored is the checked one (no fragment), so a read answers what is fetched.
  return kept;
}

/** The Watch of stored settings (no name, state or health: model.ts adds those). */
export function settingsWatch(settings: string): Watch {
  return fromWire(WatchSchema, JSON.parse(settings) as unknown).message;
}

/** An empty Watch (for tests and defaults). */
export function emptyWatch(): Watch {
  return create(WatchSchema);
}

/** Compact JSON with object keys sorted. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

/** SHA-256 of `text` as hex. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** What is read: when it changes, the notified state is set again without a change. */
export function readHash(config: WatchConfig): Promise<string> {
  return sha256Hex(
    canonical({ uri: config.uri, source: config.source, normalize: config.normalize, fetcher: config.fetcher, locale: config.locale, allowHttp: config.allowHttp, ignoreRobots: config.ignoreRobots }),
  );
}

/** Everything a check's decision depends on: when it changes, an unchanged page is evaluated again. */
export function checkHash(config: WatchConfig): Promise<string> {
  return sha256Hex(canonical({ read: { uri: config.uri, source: config.source, normalize: config.normalize, fetcher: config.fetcher, locale: config.locale }, trigger: config.trigger, confirm: config.confirmDelayMinutes }));
}

/** The Accept header of a check (docs/design.md §4): what the source can read, best first. */
export function acceptFor(source: SourceConfig): string {
  switch (source.kind) {
    case 'feed':
      return 'application/feed+json, application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.9, application/json;q=0.8';
    case 'json':
      return 'application/json, text/json;q=0.9, */*;q=0.1';
    case 'embedded':
      return 'text/html, application/xhtml+xml;q=0.9';
    case 'html':
      // Markdown (a site's own rendering for agents) only when nothing selects elements: selectors need HTML.
      return source.include.length === 0 && source.exclude.length === 0 ? 'text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.8' : 'text/html, application/xhtml+xml;q=0.9';
  }
}
