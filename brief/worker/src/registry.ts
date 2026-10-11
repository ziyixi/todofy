/**
 * The source registry and the profile's topics (../../docs/design.md §3.1, §5.1), bundled into the Worker as text
 * (wrangler.toml [[rules]]: content-config/*.yaml and *.md) and read once per isolate. There is no runtime config
 * fetch: an edit deploys through CI like code, and the unit test (test/registry.test.ts) refuses an unknown field or
 * value, a duplicate ID or a URL the fetch policy would refuse. A registry that does not load fails the Worker's
 * startup, which is its deploy, never a request.
 *
 * IDs are stable: votes and learned weights hang on them. Sources carry no topic: the gate gives each item one of the
 * profile's topics.
 */
import policyText from '../../content-config/policy.md';
import profileText from '../../content-config/profile.md';
import sourcesText from '../../content-config/sources.yaml';
import { FEED_MAX_BYTES } from './limits.ts';
import { parseYaml, type YamlValue } from './yaml.ts';

export const SECTIONS = ['research', 'world'] as const;
export const KINDS = ['rss', 'atom', 'rdf', 'json', 'crossref', 'sitemap', 'geojson', 'arxiv_api'] as const;
export const ROLES = ['candidate', 'signal_only'] as const;
export const TEXTS = ['feed_full', 'feed_abstract', 'feed_summary', 'page_full', 'page_abstract', 'headline'] as const;
export const REVIEWS = ['peer_reviewed', 'preprint', 'institution', 'commentary', 'news', 'government', 'data'] as const;
export const FORMATS = ['professional', 'familiar', 'plain', 'world_short'] as const;

export type SectionName = (typeof SECTIONS)[number];
export type Kind = (typeof KINDS)[number];
export type Role = (typeof ROLES)[number];
export type TextTier = (typeof TEXTS)[number];
export type ReviewName = (typeof REVIEWS)[number];
export type FormatName = (typeof FORMATS)[number];

export interface Keyword {
  readonly text: string;
  readonly pattern: RegExp;
}

export interface Source {
  readonly id: string;
  readonly name: string;
  readonly section: SectionName;
  readonly kind: Kind;
  readonly url: string;
  readonly query: string | null;
  readonly pathPrefixes: readonly string[];
  readonly maxBytes: number;
  readonly role: Role;
  readonly text: TextTier;
  readonly review: ReviewName;
  readonly pollPerDay: 1 | 2 | 4;
  readonly maxItems: number;
  readonly keywords: readonly Keyword[];
  readonly requiresAbstract: boolean;
  readonly enabled: boolean;
  /** DOI prefix -> review, longest prefix first. */
  readonly doiReview: readonly (readonly [string, ReviewName])[];
  readonly dateOffsetDays: number;
  /** Its position in the registry. */
  readonly index: number;
}

export interface Topic {
  readonly id: string;
  readonly section: SectionName;
  readonly format: FormatName;
  readonly description: string;
}

export interface Registry {
  readonly sources: readonly Source[];
  readonly byId: ReadonlyMap<string, Source>;
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

const SOURCE_FIELDS = new Set([
  'id', 'name', 'section', 'kind', 'url', 'query', 'path_prefixes', 'max_bytes', 'role', 'text', 'review', 'poll_per_day',
  'max_items', 'keywords', 'requires_abstract', 'enabled', 'doi_review', 'date_offset_days',
]);
const DEFAULT_FIELDS = new Set(['role', 'poll_per_day', 'max_items', 'max_bytes', 'enabled']);
const TOP_FIELDS = new Set(['version', 'defaults', 'sources']);

function isMap(value: YamlValue | undefined): value is { [key: string]: YamlValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: YamlValue | undefined, allowed: readonly T[], where: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new RegistryError(`${where}: must be one of ${allowed.join(', ')}`);
  return value as T;
}

function integer(value: YamlValue | undefined, min: number, max: number, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new RegistryError(`${where}: an integer from ${String(min)} to ${String(max)}`);
  return value;
}

function bool(value: YamlValue | undefined, where: string): boolean {
  if (typeof value !== 'boolean') throw new RegistryError(`${where}: true or false`);
  return value;
}

function text(value: YamlValue | undefined, where: string, max = 500): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new RegistryError(`${where}: a non-empty text of at most ${String(max)} characters`);
  return value;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A keyword prefilter (design §3.2): whole words and phrases; a trailing `*` matches the start of a word (`fault*`
 * matches faults, not default); a keyword written with capitals matches case-sensitively (`AI` matches AI, not said
 * or domain), others ignore case.
 */
export function compileKeyword(keyword: string): Keyword {
  const trimmed = keyword.trim();
  const star = trimmed.endsWith('*');
  const body = (star ? trimmed.slice(0, -1) : trimmed).trim();
  if (body === '' || body.includes('*')) throw new RegistryError(`keyword "${keyword}": a word or phrase, with at most a trailing *`);
  const caseSensitive = body !== body.toLowerCase();
  const words = body.split(/\s+/).map(escapeRegExp).join('\\s+');
  const tail = star ? '[\\p{L}\\p{N}]*' : '(?![\\p{L}\\p{N}])';
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${words}${tail}`, caseSensitive ? 'u' : 'iu');
  return { text: trimmed, pattern };
}

/** Whether a title or summary passes the keyword prefilter (no keywords: everything passes). */
export function keywordsMatch(keywords: readonly Keyword[], ...texts: string[]): boolean {
  if (keywords.length === 0) return true;
  return texts.some((value) => keywords.some((keyword) => keyword.pattern.test(value)));
}

function checkUrl(url: string, where: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url.replace(/\{(q|start|date)\}/g, 'x'));
  } catch {
    throw new RegistryError(`${where}: not a URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.port !== '') throw new RegistryError(`${where}: https only, no credentials, no port`);
  if (/^[0-9.]+$|^\[/.test(parsed.hostname) || !parsed.hostname.includes('.')) throw new RegistryError(`${where}: a DNS name`);
  const placeholders = url.match(/\{[a-z]+\}/g) ?? [];
  if (placeholders.some((placeholder) => !['{q}', '{start}', '{date}'].includes(placeholder))) throw new RegistryError(`${where}: only {q}, {start} and {date}`);
}

/** The registry of a sources.yaml text, validated. */
export function loadRegistry(yamlText: string): Registry {
  const document = parseYaml(yamlText);
  if (!isMap(document)) throw new RegistryError('the document must be a mapping');
  for (const key of Object.keys(document)) if (!TOP_FIELDS.has(key)) throw new RegistryError(`unknown top-level field "${key}"`);
  if (document['version'] !== 1) throw new RegistryError('version: must be 1');
  const defaults = document['defaults'] ?? {};
  if (!isMap(defaults)) throw new RegistryError('defaults: must be a mapping');
  for (const key of Object.keys(defaults)) if (!DEFAULT_FIELDS.has(key)) throw new RegistryError(`defaults: unknown field "${key}"`);
  const list = document['sources'];
  if (!Array.isArray(list) || list.length === 0) throw new RegistryError('sources: must be a non-empty list');
  const sources: Source[] = [];
  const byId = new Map<string, Source>();
  list.forEach((entry, index) => {
    if (!isMap(entry)) throw new RegistryError(`sources[${String(index)}]: must be a mapping`);
    const rawId = entry['id'];
    const where = `source ${typeof rawId === 'string' ? rawId : `#${String(index)}`}`;
    for (const key of Object.keys(entry)) if (!SOURCE_FIELDS.has(key)) throw new RegistryError(`${where}: unknown field "${key}"`);
    const merged: { [key: string]: YamlValue } = { ...defaults, ...entry };
    const id = text(merged['id'], `${where}.id`, 64);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) throw new RegistryError(`${where}.id: [a-z0-9-] only`);
    if (byId.has(id)) throw new RegistryError(`${where}: duplicate id`);
    const kind = oneOf(merged['kind'], KINDS, `${where}.kind`);
    const url = text(merged['url'], `${where}.url`, 1000);
    checkUrl(url, `${where}.url`);
    const query = merged['query'] === undefined ? null : text(merged['query'], `${where}.query`, 2000);
    if ((kind === 'arxiv_api') !== (query !== null)) throw new RegistryError(`${where}: query belongs to arxiv_api sources only, and each has one`);
    if (kind === 'arxiv_api' && (!url.includes('{q}') || !url.includes('{start}'))) throw new RegistryError(`${where}.url: an arxiv_api URL needs {q} and {start}`);
    const prefixes = merged['path_prefixes'];
    let pathPrefixes: string[] = [];
    if (prefixes !== undefined) {
      if (kind !== 'sitemap' || !Array.isArray(prefixes) || prefixes.length === 0) throw new RegistryError(`${where}.path_prefixes: a non-empty list, sitemap sources only`);
      pathPrefixes = prefixes.map((prefix, i) => {
        const value = text(prefix, `${where}.path_prefixes[${String(i)}]`, 200);
        if (!value.startsWith('/')) throw new RegistryError(`${where}.path_prefixes[${String(i)}]: a path starting with /`);
        return value;
      });
    } else if (kind === 'sitemap') throw new RegistryError(`${where}: a sitemap source needs path_prefixes`);
    const keywords = merged['keywords'] === undefined ? [] : merged['keywords'];
    if (!Array.isArray(keywords)) throw new RegistryError(`${where}.keywords: a list`);
    const doiReview: [string, ReviewName][] = [];
    const doi = merged['doi_review'];
    if (doi !== undefined) {
      if (!isMap(doi)) throw new RegistryError(`${where}.doi_review: a mapping of DOI prefix to review`);
      for (const [prefix, review] of Object.entries(doi)) {
        if (!/^10\.\d{4,9}\/\S*$/.test(prefix)) throw new RegistryError(`${where}.doi_review: "${prefix}" is no DOI prefix`);
        doiReview.push([prefix.toLowerCase(), oneOf(review, REVIEWS, `${where}.doi_review`)]);
      }
      doiReview.sort((a, b) => b[0].length - a[0].length);
    }
    const poll = merged['poll_per_day'] ?? 1;
    if (poll !== 1 && poll !== 2 && poll !== 4) throw new RegistryError(`${where}.poll_per_day: 1, 2 or 4`);
    const dateOffsetDays = merged['date_offset_days'] === undefined ? 0 : integer(merged['date_offset_days'], 0, 30, `${where}.date_offset_days`);
    if (merged['date_offset_days'] !== undefined && !url.includes('{date}')) throw new RegistryError(`${where}: date_offset_days needs {date} in the URL`);
    const source: Source = {
      id,
      name: text(merged['name'], `${where}.name`, 80),
      section: oneOf(merged['section'], SECTIONS, `${where}.section`),
      kind,
      url,
      query,
      pathPrefixes,
      maxBytes: merged['max_bytes'] === undefined ? FEED_MAX_BYTES : integer(merged['max_bytes'], 4096, 4 * 1024 * 1024, `${where}.max_bytes`),
      role: merged['role'] === undefined ? 'candidate' : oneOf(merged['role'], ROLES, `${where}.role`),
      text: oneOf(merged['text'], TEXTS, `${where}.text`),
      review: oneOf(merged['review'], REVIEWS, `${where}.review`),
      pollPerDay: poll,
      maxItems: merged['max_items'] === undefined ? 50 : integer(merged['max_items'], 1, 500, `${where}.max_items`),
      keywords: keywords.map((keyword, i) => compileKeyword(text(keyword, `${where}.keywords[${String(i)}]`, 80))),
      requiresAbstract: merged['requires_abstract'] === undefined ? false : bool(merged['requires_abstract'], `${where}.requires_abstract`),
      enabled: merged['enabled'] === undefined ? true : bool(merged['enabled'], `${where}.enabled`),
      doiReview,
      dateOffsetDays,
      index,
    };
    if (source.role === 'signal_only' && !['headline', 'feed_summary'].includes(source.text)) throw new RegistryError(`${where}: a signal-only source is never read, so its text is headline or feed_summary`);
    sources.push(source);
    byId.set(id, source);
  });
  return { sources, byId };
}

/** The review status of a document of `source` with `doi` (doi_review overrides the source's). */
export function reviewOf(source: Source, doi: string | null): ReviewName {
  if (doi !== null) {
    const lower = doi.toLowerCase();
    for (const [prefix, review] of source.doiReview) if (lower.startsWith(prefix)) return review;
  }
  return source.review;
}

const FORMAT_WORDS: Readonly<Record<string, FormatName>> = { 专业: 'professional', 熟悉: 'familiar', 通俗: 'plain' };

/**
 * The topics of profile.md (its list under 主题): `- \`id\`（写法）：description`, continued on indented lines. The
 * topics after the 世界与经济 line are the world section's, all 通俗.
 */
export function loadTopics(markdown: string): Topic[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('## 主题'));
  if (start < 0) throw new RegistryError('profile.md: no 主题 section');
  const topics: Topic[] = [];
  let section: SectionName = 'research';
  let current: { id: string; section: SectionName; format: FormatName; description: string } | null = null;
  const flush = (): void => {
    if (current !== null) topics.push({ ...current, description: current.description.trim() });
    current = null;
  };
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (line.startsWith('世界与经济')) {
      flush();
      section = 'world';
      continue;
    }
    const match = /^- `([a-z0-9]+(?:\.[a-z0-9]+)*)`(?:（(专业|熟悉|通俗)）)?：(.*)$/.exec(line);
    if (match !== null) {
      flush();
      const word = match[2];
      current = { id: match[1] ?? '', section, format: word === undefined ? 'plain' : (FORMAT_WORDS[word] ?? 'plain'), description: match[3] ?? '' };
      continue;
    }
    if (current !== null && /^\s{2,}\S/.test(line)) current.description += line.trim();
    else if (line.trim() !== '') flush();
  }
  flush();
  const ids = new Set<string>();
  for (const topic of topics) {
    if (ids.has(topic.id)) throw new RegistryError(`profile.md: duplicate topic ${topic.id}`);
    ids.add(topic.id);
  }
  if (!topics.some((topic) => topic.section === 'research') || !topics.some((topic) => topic.section === 'world')) throw new RegistryError('profile.md: topics of both sections');
  return topics;
}

let cached: { registry: Registry; topics: Topic[] } | null = null;

/** The bundled registry and topics (parsed once per isolate). */
export function bundled(): { readonly registry: Registry; readonly topics: readonly Topic[] } {
  cached ??= { registry: loadRegistry(sourcesText), topics: loadTopics(profileText) };
  return cached;
}

/** The bundled texts the prompts are built from (the owner's words, never rewritten by learning). */
export const PROFILE_TEXT: string = profileText;
export const POLICY_TEXT: string = policyText;
export const SOURCES_TEXT: string = sourcesText;
