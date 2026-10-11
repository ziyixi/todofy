/**
 * The email (../../docs/design.md §11): the weekday brief, the Saturday deep read and a quiet day's note, each as HTML
 * and as a text/plain part with the same words.
 *
 * - Layout: one column of at most 600 px in a full-width table that carries the page colour (Gmail drops <body> and its
 *   styles), 18 px gutters, so a phone shows the panel edge to edge. Sections 研究前沿 and 世界与经济 with a rule under
 *   their label; items separated by a rule; 还有 after the research items; the deep read with its headings and its
 *   sources listed at the end.
 * - Chinese typography: the system font stack with PingFang SC, Hiragino Sans GB and Noto Sans SC first among the CJK
 *   faces and `lang="zh-CN"` on the panel (so Han characters take their Simplified Chinese forms), 17 px text at line
 *   height 1.75, full-width punctuation in every label, long Latin words wrapped, and in the model's text a space
 *   between Han characters and Latin letters or digits (render only: the check and the archive keep the text as written).
 * - Gmail-safe: every style that matters is inline; the head <style> only adds the dark scheme for the clients that
 *   honour `prefers-color-scheme` (Apple Mail, iOS Mail, next to the `color-scheme` metas), one class per coloured
 *   element. The light colours are mid-tones that survive Gmail's forced dark inversion: no background image, no pure
 *   black on a white panel.
 * - Nothing remote: no image, no font, no tracking pixel, no script; links are https only. Under EMAIL_HTML_MAX bytes
 *   (Gmail clips at 102 KB): render.test.ts holds the largest issues to it.
 * - The markers are dropped (the archive shows them). The source line is code's, from the registry and the fetch, never
 *   the model's (sourceLine). Each item ends with 👍 · 👎 · 多来点 (feedback.ts): each opens a page whose button records
 *   the vote, so a mail scanner that follows links votes nothing.
 * - A quiet day is said, not silent: a weekday with no item, or a Saturday without a deep read, sends its title and one
 *   line with the reason in words.
 */
import { feedbackKey, signFeedback, VOTE_WORDS, VOTES, type VoteName } from './feedback.ts';
import { withoutMarkers, type Paragraph } from './ground.ts';
import { OPUS_MODEL } from './limits.ts';
import { REVIEW_WORDS, type TextScopeName, type VerdictName } from './prompts.ts';
import type { FormatName, ReviewName } from './registry.ts';
import { issueKind, weekdayOf } from './schedule.ts';

export interface Reference {
  readonly source: string;
  readonly venue: string;
  readonly title: string;
  readonly uri: string;
  readonly review: ReviewName;
  readonly scope: TextScopeName;
  readonly published: number | null;
}

export interface Citation {
  readonly n: number;
  /** An index into the item's references. */
  readonly ref: number;
  /** The source's own characters. */
  readonly quote: string;
  readonly verdict: VerdictName | '';
}

export interface FinalItem {
  readonly id: string;
  readonly section: 'research' | 'world' | 'deep_read';
  readonly topic: string;
  readonly format: FormatName;
  readonly title: string;
  readonly paragraphs: readonly Paragraph[];
  readonly why: string;
  /** The packet's documents, the primary one first. */
  readonly refs: readonly Reference[];
  readonly citations: readonly Citation[];
  readonly reason: string;
  readonly score: number;
  readonly keys: readonly string[];
  readonly sources: readonly string[];
}

export interface MoreItem {
  readonly source: string;
  readonly title: string;
  readonly venue: string;
  readonly review: ReviewName;
  readonly uri: string;
}

export type QuietReasonName = 'no_candidates' | 'not_scored' | 'none_grounded' | 'no_readable_thread' | 'budget_spent' | 'calls_rejected' | 'write_failed';

export const QUIET_WORDS: Readonly<Record<QuietReasonName, string>> = {
  no_candidates: '没有新的候选',
  not_scored: '候选未能打分',
  none_grounded: '入选条目都未通过核对',
  no_readable_thread: '没有可读全文的线索',
  budget_spent: '预算已用完',
  calls_rejected: '调用被拒',
  write_failed: '写作未能完成',
};

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function monthDay(date: string): string {
  const [, month, day] = date.split('-').map(Number);
  return `${String(month)}月${String(day)}日`;
}

/** The subject without the shadow tag (Issue.title). */
export function issueTitle(date: string, deepTitle: string | null, quiet: QuietReasonName | null): string {
  if (issueKind(date) === 'deep_read') return quiet !== null || deepTitle === null ? `深读 · ${monthDay(date)}：本周无深读` : `深读 · ${monthDay(date)}：${deepTitle}`;
  return quiet !== null ? `简报 · ${monthDay(date)}：今日无条目` : `简报 · ${monthDay(date)}（${WEEKDAYS[weekdayOf(date)] ?? ''}）`;
}

/** The email's subject: `[影子版] ` before the title in shadow mode. */
export function subjectOf(title: string, shadow: boolean): string {
  return shadow ? `[影子版] ${title}` : title;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

/** Only https links are rendered as links. */
function safeHref(uri: string): string | null {
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// ---- the words: the model's text typeset, and the lines code writes -----------------------------------------------------------

const HAN = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';
const HAN_THEN_LATIN = new RegExp(`([${HAN}])([A-Za-z0-9])`, 'gu');
const LATIN_THEN_HAN = new RegExp(`([A-Za-z0-9%])([${HAN}])`, 'gu');

/**
 * A text of the model's as the email shows it: without its markers, a space between Han characters and Latin letters or
 * digits (`GPT-5 的`, `30% 的`), no space doubled or left before Chinese punctuation, and one entry per line (a line
 * break inside a paragraph starts a new one).
 */
export function typeset(text: string): string[] {
  return withoutMarkers(text)
    .replace(HAN_THEN_LATIN, '$1 $2')
    .replace(LATIN_THEN_HAN, '$1 $2')
    .split(/\s*\n\s*/)
    .map((line) => line.replace(/[ \t\u00a0]{2,}/g, ' ').replace(/[ \t\u00a0]+(?=[，。、；：！？）》」』])/gu, '').trim())
    .filter((line) => line !== '');
}

function oneLine(text: string): string {
  return typeset(text).join(' ');
}

/**
 * The source line of an item (design §11): its venues (at most three, joined by 、), the primary document's review
 * status in words, 仅摘要 when no full text was read (a research item's paper, its first document; any article of a
 * world story), and 原文, the primary document's link (the arXiv abstract page, the DOI link or the article).
 */
export function sourceLine(item: Pick<FinalItem, 'section' | 'refs'>): { text: string; uri: string | null } {
  const primary = item.refs[0];
  if (primary === undefined) return { text: '', uri: null };
  const venues = [...new Set(item.refs.map((ref) => ref.venue).filter((venue) => venue !== ''))].slice(0, 3).join('、');
  const read = item.section === 'world' ? item.refs.some((ref) => ref.scope === 'full_text') : primary.scope === 'full_text';
  const parts = [venues, REVIEW_WORDS[primary.review], read ? '' : '仅摘要'].filter((part) => part !== '');
  return { text: parts.join(' · '), uri: safeHref(primary.uri) };
}

/** A model's name for the footer: `claude-opus-4-8` is Claude Opus 4.8; an ID of another shape stays as it is. */
export function modelName(id: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d))?(?:-\d{8})?$/.exec(id);
  if (match === null) return id;
  const family = match[1] ?? '';
  return `Claude ${family.charAt(0).toUpperCase()}${family.slice(1)} ${match[2] ?? ''}${match[3] === undefined ? '' : `.${match[3]}`}`;
}

/** The footer's words for the writer after a server-side fallback (design §7), or nothing. */
function writerWords(writers: readonly string[]): string {
  const fallbacks = writers.filter((model) => model !== OPUS_MODEL);
  if (fallbacks.length === 0) return '';
  return `${writers.includes(OPUS_MODEL) ? '部分由' : '由'} ${fallbacks.map(modelName).join('、')} 撰写`;
}

// ---- the HTML -----------------------------------------------------------------------------------------------------------------

/** The light colours inline; the dark ones in the head <style> for the clients that honour prefers-color-scheme. */
const LIGHT = { page: '#f2f2f5', panel: '#ffffff', text: '#24252b', muted: '#62646d', link: '#2457c5', rule: '#e4e4e9', pill: '#f4f4f7', pillBorder: '#d6d7de' } as const;
const DARK = { page: '#141518', panel: '#1e1f23', text: '#e4e4e8', muted: '#a3a5ae', link: '#8fb3ff', rule: '#34353c', pill: '#28292e', pillBorder: '#46474f' } as const;

const FONT = `-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Noto Sans SC','Noto Sans CJK SC','Microsoft YaHei',sans-serif`;

/** One class per coloured element: bg (the page), panel, m (muted), a (links), rule (borders), pill (the votes). */
const HEAD_STYLE =
  ':root{color-scheme:light dark;supported-color-schemes:light dark}' +
  '@media (prefers-color-scheme:dark){' +
  `.bg{background-color:${DARK.page}!important}` +
  `.panel{background-color:${DARK.panel}!important;color:${DARK.text}!important}` +
  `.m{color:${DARK.muted}!important}` +
  `.a{color:${DARK.link}!important}` +
  `.rule{border-color:${DARK.rule}!important}` +
  `.pill{background-color:${DARK.pill}!important;border-color:${DARK.pillBorder}!important;color:${DARK.text}!important}` +
  '}';

const STYLE = {
  h1: 'margin:0;font-size:22px;line-height:1.45;font-weight:700;',
  note: 'margin:12px 0 0;',
  section: `margin:28px 0 0;padding:0 0 6px;border-bottom:1px solid ${LIGHT.rule};font-size:15px;line-height:1.5;font-weight:600;letter-spacing:0.1em;color:${LIGHT.muted};`,
  first: 'padding:16px 0 0;',
  next: `margin:18px 0 0;padding:18px 0 0;border-top:1px solid ${LIGHT.rule};`,
  sources: `margin:22px 0 10px;padding:14px 0 0;border-top:1px solid ${LIGHT.rule};`,
  title: 'margin:0 0 6px;font-size:19px;line-height:1.5;font-weight:600;',
  heading: 'margin:22px 0 6px;font-size:18px;line-height:1.5;font-weight:600;',
  /** A deep read's first heading, right under the email's title. */
  headingFirst: 'margin:6px 0 6px;font-size:18px;line-height:1.5;font-weight:600;',
  label: 'margin:0 0 6px;font-size:16px;line-height:1.5;font-weight:600;',
  p: 'margin:0 0 10px;',
  why: `margin:0 0 6px;font-size:15px;line-height:1.7;color:${LIGHT.muted};`,
  meta: `margin:0 0 10px;font-size:14px;line-height:1.6;color:${LIGHT.muted};`,
  more: 'margin:0 0 8px;font-size:15px;line-height:1.6;',
  muted: `color:${LIGHT.muted};`,
  link: `color:${LIGHT.link};`,
  votes: 'margin:0;',
  pill: `display:inline-block;margin:0 8px 4px 0;padding:4px 14px;border:1px solid ${LIGHT.pillBorder};border-radius:16px;background-color:${LIGHT.pill};color:${LIGHT.text};font-size:15px;line-height:1.6;text-decoration:none;`,
  footer: `margin:28px 0 0;padding:12px 0 0;border-top:1px solid ${LIGHT.rule};font-size:13px;line-height:1.6;color:${LIGHT.muted};`,
} as const;

function link(href: string, words: string): string {
  return `<a class="a" href="${escapeHtml(href)}" style="${STYLE.link}">${words}</a>`;
}

/** ` · 原文` after a line, kept on one line with its separator, or nothing without an https link. */
function original(href: string | null): string {
  return href === null ? '' : ` <span style="white-space:nowrap;">· ${link(href, '原文')}</span>`;
}

/** The document around the body: the metas, the dark scheme, the page table and the 600 px panel. */
function page(subject: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="supported-color-schemes" content="light dark">',
    '<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">',
    `<title>${escapeHtml(subject)}</title>`,
    `<style>${HEAD_STYLE}</style>`,
    '</head>',
    `<body class="bg" style="margin:0;padding:0;background-color:${LIGHT.page};-webkit-text-size-adjust:100%;">`,
    `<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${LIGHT.page};">`,
    '<tr><td align="center" style="padding:16px 0;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">',
    `<tr><td class="panel" lang="zh-CN" style="padding:24px 18px;background-color:${LIGHT.panel};color:${LIGHT.text};font-family:${FONT};font-size:17px;line-height:1.75;text-align:left;word-wrap:break-word;overflow-wrap:break-word;">`,
    body,
    '</td></tr>',
    '</table>',
    '</td></tr>',
    '</table>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// ---- the parts ----------------------------------------------------------------------------------------------------------------

export interface RenderInput {
  readonly date: string;
  readonly shadow: boolean;
  readonly items: readonly FinalItem[];
  readonly more: readonly MoreItem[];
  readonly costUsd: number;
  readonly writers: readonly string[];
  readonly publicHost: string;
  /** FEEDBACK_SIGNING_KEY (64 hex), or empty: no vote links. */
  readonly feedbackKeyHex: string;
  readonly now: number;
  readonly quiet: QuietReasonName | null;
}

export interface Rendered {
  readonly title: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** The two parts as they grow, line by line. */
interface Parts {
  readonly html: string[];
  readonly text: string[];
}

async function voteLinks(input: RenderInput, key: CryptoKey | null, item: string): Promise<{ vote: VoteName; href: string }[]> {
  if (key === null) return [];
  const links: { vote: VoteName; href: string }[] = [];
  for (const vote of VOTES) {
    const token = await signFeedback(key, { issue: input.date, item, vote }, input.now);
    links.push({ vote, href: `https://${input.publicHost}/feedback?t=${encodeURIComponent(token)}` });
  }
  return links;
}

function section(parts: Parts, name: string): void {
  parts.html.push(`<h2 class="m rule" style="${STYLE.section}">${name}</h2>`);
  parts.text.push(`【${name}】`, '');
}

/** One item: its title (a deep read's is the email's), paragraphs, why, source line or sources, and its votes. */
async function renderItem(parts: Parts, item: FinalItem, first: boolean, input: RenderInput, key: CryptoKey | null): Promise<void> {
  const deep = item.section === 'deep_read';
  parts.html.push(first ? `<div style="${STYLE.first}">` : `<div class="rule" style="${STYLE.next}">`);
  if (!deep) {
    const title = oneLine(item.title);
    parts.html.push(`<h3 style="${STYLE.title}">${escapeHtml(title)}</h3>`);
    parts.text.push(title, '');
  }
  for (const [i, paragraph] of item.paragraphs.entries()) {
    const heading = oneLine(paragraph.heading);
    if (heading !== '') {
      parts.html.push(`<h3 style="${deep && i === 0 ? STYLE.headingFirst : STYLE.heading}">${escapeHtml(heading)}</h3>`);
      parts.text.push(`【${heading}】`, '');
    }
    for (const line of typeset(paragraph.text)) {
      parts.html.push(`<p style="${STYLE.p}">${escapeHtml(line)}</p>`);
      parts.text.push(line, '');
    }
  }
  const why = oneLine(item.why);
  if (why !== '') {
    parts.html.push(`<p class="m" style="${STYLE.why}">为什么看：${escapeHtml(why)}</p>`);
    parts.text.push(`为什么看：${why}`);
  }
  if (deep) {
    parts.html.push(`<div class="rule" style="${STYLE.sources}">`, `<h4 class="m" style="${STYLE.label}${STYLE.muted}">来源</h4>`);
    parts.text.push('来源');
    item.refs.forEach((ref, i) => {
      const href = safeHref(ref.uri);
      const words = [`${String(i + 1)}. ${ref.title}`, ref.venue, REVIEW_WORDS[ref.review], ref.scope === 'full_text' ? '' : '仅摘要'].filter((part) => part !== '').join(' · ');
      parts.html.push(`<p class="m" style="${STYLE.meta}">${escapeHtml(words)}${original(href)}</p>`);
      parts.text.push(words, ...(href === null ? [] : [`   原文：${href}`]));
    });
    parts.html.push('</div>');
  } else {
    const line = sourceLine(item);
    if (line.text !== '') {
      parts.html.push(`<p class="m" style="${STYLE.meta}">${escapeHtml(line.text)}${original(line.uri)}</p>`);
      parts.text.push(line.text, ...(line.uri === null ? [] : [`原文：${line.uri}`]));
    }
  }
  const votes = await voteLinks(input, key, item.id);
  if (votes.length > 0) {
    parts.html.push(`<p style="${STYLE.votes}">${votes.map((vote) => `<a class="pill" href="${escapeHtml(vote.href)}" style="${STYLE.pill}">${VOTE_WORDS[vote.vote].emoji}</a>`).join('')}</p>`);
    parts.text.push(...votes.map((vote) => `${VOTE_WORDS[vote.vote].emoji} ${vote.href}`));
  }
  parts.html.push('</div>');
  parts.text.push('');
}

/** 还有 (design §6): the professional topics' titles the pick did not take, as published, by code. */
function renderMore(parts: Parts, more: readonly MoreItem[], first: boolean): void {
  parts.html.push(first ? `<div style="${STYLE.first}">` : `<div class="rule" style="${STYLE.next}">`);
  parts.html.push(`<h4 style="${STYLE.label}">还有</h4>`);
  parts.text.push('还有');
  for (const entry of more) {
    const href = safeHref(entry.uri);
    const meta = [entry.venue, REVIEW_WORDS[entry.review]].filter((part) => part !== '').join(' · ');
    parts.html.push(`<p style="${STYLE.more}">${escapeHtml(entry.title)}<span class="m" style="${STYLE.muted}"> · ${escapeHtml(meta)}${original(href)}</span></p>`);
    parts.text.push(`- ${entry.title} · ${meta}`, ...(href === null ? [] : [`  原文：${href}`]));
  }
  parts.html.push('</div>');
  parts.text.push('');
}

function renderFooter(parts: Parts, archive: string, words: readonly string[]): void {
  const shown = words.filter((word) => word !== '');
  parts.html.push(`<p class="m rule" style="${STYLE.footer}">${link(archive, '网页版')}${shown.map((word) => ` · <span style="white-space:nowrap;">${escapeHtml(word)}</span>`).join('')}</p>`);
  parts.text.push(`网页版：${archive}`, ...(shown.length > 0 ? [shown.join(' · ')] : []));
}

/** The email of an issue (or its quiet note), HTML and text. */
export async function renderEmail(input: RenderInput): Promise<Rendered> {
  const deep = input.items.find((item) => item.section === 'deep_read');
  const title = issueTitle(input.date, deep === undefined ? null : oneLine(deep.title), input.quiet);
  const subject = subjectOf(title, input.shadow);
  const archive = `https://${input.publicHost}/issues/${input.date}`;
  const cost = `本期 $${input.costUsd.toFixed(2)}`;
  const parts: Parts = { html: [`<h1 style="${STYLE.h1}">${escapeHtml(title)}</h1>`], text: [title, ''] };
  if (input.quiet !== null) {
    const reason = `原因：${QUIET_WORDS[input.quiet]}。`;
    parts.html.push(`<p style="${STYLE.note}">${escapeHtml(reason)}</p>`);
    parts.text.push(reason, '');
    renderFooter(parts, archive, input.costUsd >= 0.005 ? [cost] : []);
  } else {
    const key = input.feedbackKeyHex === '' ? null : await feedbackKey(input.feedbackKeyHex);
    if (deep !== undefined) await renderItem(parts, deep, true, input, key);
    else {
      const research = input.items.filter((item) => item.section === 'research');
      const world = input.items.filter((item) => item.section === 'world');
      if (research.length > 0 || input.more.length > 0) {
        section(parts, '研究前沿');
        for (const [i, item] of research.entries()) await renderItem(parts, item, i === 0, input, key);
        if (input.more.length > 0) renderMore(parts, input.more, research.length === 0);
      }
      if (world.length > 0) {
        section(parts, '世界与经济');
        for (const [i, item] of world.entries()) await renderItem(parts, item, i === 0, input, key);
      }
    }
    const count = deep === undefined ? `${String(input.items.length)} 条` : `${String(deep.refs.length)} 个来源`;
    renderFooter(parts, archive, [count, cost, writerWords(input.writers)]);
  }
  return { title, subject, html: page(subject, parts.html.join('\n')), text: `${parts.text.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n` };
}

/** SHA-256 hex of the frozen render (the ledger's hash). */
export async function renderHash(rendered: Pick<Rendered, 'subject' | 'html' | 'text'>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${rendered.subject}\u0000${rendered.html}\u0000${rendered.text}`)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
