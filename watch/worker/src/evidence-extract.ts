/** Bounded, unmasked reading evidence. It never changes the comparison Content or evaluates the owner's intent. */
import type { SourceConfig } from './config.ts';
import { FETCH_MAX_BYTES } from './limits.ts';
import { decodeBody, detectCharset, mediaType } from './extract/charset.ts';
import { decodeEntities } from './extract/entities.ts';
import { extract } from './extract/index.ts';

export const CAPTURE_TEXT_MAX = 256 * 1024;
export const CAPTURE_ACCESSIBILITY_MAX = 64 * 1024;
export const CAPTURE_SCREENSHOT_MAX = 1024 * 1024;
const LINKS_MAX = 100;
const METADATA_MAX = 32;
const DEPTH_MAX = 128;
const ELEMENTS_MAX = 50_000;
const encoder = new TextEncoder();

export interface CaptureDocument {
  readonly title: string;
  readonly finalUrl: string;
  readonly markdown: string;
  readonly links: readonly { readonly text: string; readonly url: string }[];
  readonly metadata: readonly { readonly name: string; readonly content: string }[];
  readonly accessibilityJson: string | null;
  readonly truncated: boolean;
  readonly errors: readonly string[];
  readonly screenshot: { readonly bytes: Uint8Array; readonly width: number; readonly height: number; readonly mimeType: 'image/jpeg' } | null;
}

/** UTF-8 limits never leave a partial code point. */
export function captureText(text: string, maxBytes = CAPTURE_TEXT_MAX): { readonly text: string; readonly truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

export function emptyCapture(finalUrl: string): CaptureDocument {
  return { title: '', finalUrl, markdown: '', links: [], metadata: [], accessibilityJson: null, truncated: false, errors: [], screenshot: null };
}

function linkUrl(href: string, base: string): string | null {
  if (href.trim() === '' || href.length > 2048) return null;
  try {
    const url = new URL(decodeEntities(href), base);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '' && url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}

/** Markdown stays readable without executing or fetching embedded HTML, links or images. */
function markdownLinks(text: string, base: string): CaptureDocument['links'] {
  const links: { text: string; url: string }[] = [];
  let start = 0;
  for (let close = text.indexOf('](', start); close !== -1 && links.length < LINKS_MAX; close = text.indexOf('](', start)) {
    start = close + 2;
    const target = text.slice(start, start + 2049);
    const end = target.indexOf(')');
    if (end === -1) continue;
    const label = text.slice(Math.max(0, close - 512), close);
    const open = label.lastIndexOf('[');
    if (open === -1) continue;
    const url = linkUrl(target.slice(0, end).split(/\s/, 1)[0] ?? '', base);
    if (url !== null) links.push({ text: label.slice(open + 1), url });
  }
  return links;
}

const SKIP = new Set(['head', 'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'textarea', 'object']);
const HEAD_CONTENT = new Set(['base', 'link', 'meta', 'noscript', 'script', 'style', 'template', 'title']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dt', 'dd', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'main', 'nav', 'p', 'section', 'summary', 'table', 'ul', 'ol']);
interface Frame {
  readonly parent: Frame | null;
  readonly tag: string;
  readonly href: string | null;
  readonly skipped: boolean;
  readonly landmark: boolean;
  included: boolean;
  excluded: boolean;
  optIn: boolean;
  opened: boolean;
  closed: boolean;
  text: string;
  cells: number;
  rows: number;
}

/** HTMLRewriter supplies parsing and selector matching; this pass only emits bounded reading structure. */
async function htmlCapture(html: string, finalUrl: string, source: SourceConfig | undefined): Promise<CaptureDocument> {
  const config = source?.kind === 'html' ? source : null;
  const parts: string[] = [];
  const links: { text: string; url: string }[] = [];
  const metadata: { name: string; content: string }[] = [];
  let title = '';
  let nodeText = '';
  let top: Frame | null = null;
  let current: Frame | null = null;
  let depth = 0;
  let elements = 0;
  let size = 0;
  const status = { failed: false, truncated: false, matched: config === null || config.include.length === 0 };
  const append = (text: string) => {
    if (!text || size >= CAPTURE_TEXT_MAX) { if (text) status.truncated = true; return; }
    const kept = captureText(text, CAPTURE_TEXT_MAX - size);
    parts.push(kept.text);
    size += encoder.encode(kept.text).length;
    status.truncated ||= kept.truncated;
  };
  const ancestor = (tag: string): Frame | null => {
    for (let frame = top; frame !== null; frame = frame.parent) if (frame.tag === tag) return frame;
    return null;
  };
  const counted = () => {
    let included = config === null || config.include.length === 0;
    let landmark = false;
    let optIn = false;
    for (let frame = top; frame !== null; frame = frame.parent) {
      if (frame.skipped || frame.excluded) return false;
      included ||= frame.included;
      landmark ||= frame.landmark;
      optIn ||= frame.optIn;
    }
    return included && (config === null || config.keepLandmarks || !landmark || optIn);
  };
  const open = (frame: Frame) => {
    if (frame.opened) return;
    if (frame.parent !== null) open(frame.parent);
    frame.opened = true;
    if (/^h[1-6]$/.test(frame.tag)) append(`\n\n${'#'.repeat(Number(frame.tag[1]))} `);
    else if (frame.tag === 'li') append('\n- ');
    else if (frame.tag === 'tr') append('\n');
    else if (frame.tag === 'td' || frame.tag === 'th') append('| ');
    else if (frame.tag === 'pre') append('\n\n```\n');
    else if (frame.tag === 'a' && frame.href !== null) append('[');
    else if (BLOCK.has(frame.tag)) append(ancestor('td') !== null || ancestor('th') !== null ? ' ' : '\n\n');
  };
  const close = (frame: Frame) => {
    if (frame.closed) return;
    frame.closed = true;
    if (frame.opened) {
      if (frame.tag === 'a' && frame.href !== null) {
        append(`](${frame.href})`);
        if (links.length < LINKS_MAX) links.push({ text: frame.text.trim(), url: frame.href });
        else status.truncated = true;
      } else if (frame.tag === 'td' || frame.tag === 'th') {
        append(' ');
        const row = ancestor('tr');
        if (row !== null) row.cells++;
      } else if (frame.tag === 'tr') {
        append('|\n');
        const table = ancestor('table');
        if (table !== null && table.rows++ === 0) append(`${'| --- '.repeat(Math.min(frame.cells, 100))}|\n`);
      } else if (frame.tag === 'pre') append('\n```\n\n');
      else if (BLOCK.has(frame.tag) || /^h[1-6]$/.test(frame.tag)) append('\n\n');
    }
    if (top === frame) { top = frame.parent; depth--; }
  };
  const rewriter = new HTMLRewriter().on('*', {
    element(element) {
      current = null;
      if (++elements > ELEMENTS_MAX || depth >= DEPTH_MAX) { status.failed = true; throw new Error('capture_structure_limit'); }
      const tag = element.tagName.toLowerCase();
      if (top?.tag === 'head' && !HEAD_CONTENT.has(tag)) close(top);
      if (tag === 'meta') {
        const name = element.getAttribute('name') ?? element.getAttribute('property');
        const content = element.getAttribute('content');
        if (name && content) {
          if (metadata.length < METADATA_MAX) {
            const kept = captureText(decodeEntities(content), 2048);
            metadata.push({ name: name.slice(0, 100), content: kept.text });
            status.truncated ||= kept.truncated || name.length > 100;
          } else status.truncated = true;
        }
      }
      if (VOID.has(tag)) {
        if (counted()) {
          if (top !== null) open(top);
          if (tag === 'br' || tag === 'hr') append('\n');
          if (tag === 'img') {
            const url = linkUrl(element.getAttribute('src') ?? '', finalUrl);
            const alt = decodeEntities(element.getAttribute('alt') ?? '').slice(0, 512);
            if (url !== null) append(`![${alt}](${url})`);
          }
        }
        return;
      }
      const role = element.getAttribute('role');
      const frame: Frame = { parent: top, tag, href: tag === 'a' ? linkUrl(element.getAttribute('href') ?? '', finalUrl) : null,
        skipped: SKIP.has(tag) || element.getAttribute('hidden') !== null || element.getAttribute('aria-hidden') === 'true',
        landmark: tag === 'nav' || role === 'navigation' || role === 'banner' || role === 'contentinfo' || ((tag === 'header' || tag === 'footer') && top?.tag === 'body'),
        included: false, excluded: false, optIn: false, opened: false, closed: false, text: '', cells: 0, rows: 0 };
      try { element.onEndTag(() => { close(frame); }); }
      catch { return; } // A self-closed foreign element has no matching end tag.
      top = frame;
      current = frame;
      depth++;
    },
  }).onDocument({
    text(chunk) {
      nodeText += chunk.text;
      if (!chunk.lastInTextNode) return;
      const raw = decodeEntities(nodeText);
      nodeText = '';
      if (!counted() || top === null) return;
      open(top);
      const text = ancestor('pre') === null ? raw.replace(/\s+/g, ' ') : raw;
      append(text);
      const anchor = ancestor('a');
      if (anchor !== null && anchor.text.length < 512) anchor.text += text.slice(0, 512 - anchor.text.length);
    },
  }).on('title', { text(chunk) { if (title.length < 4096) title += chunk.text.slice(0, 4096 - title.length); else status.truncated = true; } });
  for (const selector of config?.include ?? []) rewriter.on(selector, { element() {
    if (current === null) return;
    status.matched = true;
    current.included = true;
    for (let frame = top; frame !== null; frame = frame.parent) if (frame.landmark) current.optIn = true;
  } });
  for (const selector of config?.exclude ?? []) rewriter.on(selector, { element() { if (current !== null) current.excluded = true; } });
  try { await rewriter.transform(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })).arrayBuffer(); }
  catch { status.failed = true; }
  const keptTitle = captureText(decodeEntities(title).trim(), 1024);
  const errors = status.failed ? ['EVIDENCE_STRUCTURE_LIMIT'] : status.matched ? [] : ['SELECTOR_MISS'];
  return { ...emptyCapture(finalUrl), title: keptTitle.text, markdown: parts.join('').replace(/\n{3,}/g, '\n\n').trim(), links, metadata,
    truncated: status.truncated || status.failed || keptTitle.truncated, errors };
}

export async function extractCapture(input: { readonly body: Uint8Array; readonly contentType: string | null; readonly finalUrl: string; readonly source?: SourceConfig }): Promise<CaptureDocument> {
  if (input.body.byteLength > FETCH_MAX_BYTES) return { ...emptyCapture(input.finalUrl), truncated: true, errors: ['EVIDENCE_BODY_TOO_LARGE'] };
  const type = mediaType(input.contentType);
  const text = decodeBody(input.body, detectCharset(input.contentType, input.body).label);
  if (input.source !== undefined && input.source.kind !== 'html') {
    const result = await extract({ source: input.source, contentType: input.contentType, body: input.body, url: input.finalUrl, blocks: false });
    if (!result.ok) return { ...emptyCapture(input.finalUrl), errors: [result.failure] };
    const markdown = captureText(result.page.lines.join('\n\n'));
    return { ...emptyCapture(input.finalUrl), markdown: markdown.text, truncated: result.page.truncated || markdown.truncated };
  }
  if (type === 'text/html' || type === 'application/xhtml+xml' || type === '') return htmlCapture(text, input.finalUrl, input.source);
  const kept = captureText(text);
  if (type === 'text/markdown' || type === 'text/plain') return { ...emptyCapture(input.finalUrl),
    title: type === 'text/markdown' ? /^#\s+([^\n]+)/m.exec(kept.text)?.[1]?.slice(0, 1024) ?? '' : '',
    markdown: kept.text, links: markdownLinks(kept.text, input.finalUrl), truncated: kept.truncated };
  return { ...emptyCapture(input.finalUrl), errors: ['EVIDENCE_UNSUPPORTED_CONTENT_TYPE'] };
}
