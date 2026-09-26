import PostalMime from 'postal-mime';
import { parseFragment } from 'parse5';
import type { Env } from './types.ts';
import { MAX_RAW_BYTES } from './ingest.ts';
import { ATTACHMENT_BYTES, ATTACHMENT_METADATA_LIMIT, CONTENT_POLICY_VERSION, HTML_BYTES, MESSAGE_ATTACHMENT_BYTES, UI_TEXT_BYTES, truncateUTF8 } from './content-policy.ts';

export interface Address { address: string; name: string }
export interface Attachment {
  part_id: string; filename: string; content_type: string; size: number; r2_key?: string;
  storage_status?: 'stored' | 'omitted';
  omitted_reason?: 'size_limit' | 'message_size_limit' | 'inline_image' | 'capacity';
}
export interface ParsedMail {
  subject: string; text: string; html: string; from: Address[]; to: Address[]; cc: Address[]; reply_to: Address[];
  sent_at: string | null; rfc_message_id: string | null; headers: {key: string; value: string}[];
  attachments: Attachment[]; needs_review: boolean; warnings: string[];
  text_truncated?: boolean; original_text_bytes?: number; html_omitted?: boolean;
  attachments_omitted_count?: number; content_policy_version?: string;
}
const utf8 = new TextEncoder();
const MAX_HEADERS = 256 * 1024;
export class ParseError extends Error {}

interface HTMLNode { nodeName: string; value?: string; attrs?: {name: string; value: string}[]; childNodes?: HTMLNode[] }
const allowed = new Set(['p','br','div','span','strong','b','em','i','u','s','blockquote','pre','code','ul','ol','li','table','thead','tbody','tfoot','tr','th','td','hr','h1','h2','h3','h4','h5','h6','a']);
const hidden = new Set(['script','style','iframe','object','embed','form','input','button','textarea','select','option','svg','math','template','img','video','audio','source','link','meta','base']);
const blocks = new Set(['p','div','blockquote','pre','li','tr','h1','h2','h3','h4','h5','h6','br','hr']);
const escapeHTML = (value: string) => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function safeHTML(source: string): { html: string; text: string } {
  const tree = parseFragment(source) as HTMLNode;
  let count = 0;
  function visit(node: HTMLNode, depth: number): {html: string; text: string} {
    if (++count > 100_000 || depth > 100) throw new ParseError('html_limit');
    if (node.nodeName === '#text') return {html: escapeHTML(node.value ?? ''), text: node.value ?? ''};
    if (hidden.has(node.nodeName)) return {html:'', text:''};
    const children = (node.childNodes ?? []).map(child => visit(child, depth + 1));
    const inner = children.map(child => child.html).join('');
    const text = children.map(child => child.text).join('') + (blocks.has(node.nodeName) ? '\n' : '');
    if (!allowed.has(node.nodeName)) return {html: inner, text};
    let attrs = '';
    if (node.nodeName === 'a') {
      const href = node.attrs?.find(attr => attr.name === 'href')?.value;
      if (href) {
        try {
          const url = new URL(href);
          if (['http:', 'https:', 'mailto:'].includes(url.protocol)) attrs = ` href="${escapeHTML(url.href)}" target="_blank" rel="noopener noreferrer"`;
        } catch { /* Invalid/relative destinations are inert text. */ }
      }
    }
    return {html: `<${node.nodeName}${attrs}>${inner}${['br','hr'].includes(node.nodeName) ? '' : `</${node.nodeName}>`}`, text};
  }
  return visit(tree, 0);
}

/** Inspect the MIME boundaries before decoding attachments. Every header and
 * part is bounded; boundaries are ASCII and inspected without copying bodies. */
function inspectMIME(bytes: Uint8Array): void {
  let parts = 0;
  function lineEnd(at: number, end: number): number {
    let i = at; while (i < end && bytes[i] !== 10) i++; return i < end ? i + 1 : end;
  }
  function walk(start: number, end: number, depth: number): void {
    if (++parts > 200 || depth > 20) throw new ParseError('mime_structure_limit');
    let body = start;
    while (body < end) {
      const next = lineEnd(body, end);
      if (next - start > MAX_HEADERS) throw new ParseError('mime_header_limit');
      const length = next - body;
      if (length === 1 || (length === 2 && bytes[body] === 13)) { body = next; break; }
      body = next;
    }
    const header = new TextDecoder('utf-8').decode(bytes.subarray(start, body)).replace(/\r?\n[ \t]+/g, ' ');
    const type = /^content-type:\s*([^\r\n]*)/im.exec(header)?.[1] ?? '';
    if (!/^multipart\//i.test(type)) return;
    const match = /(?:^|;)\s*boundary\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/i.exec(type);
    const boundary = (match?.[1]?.replace(/\\(.)/g, '$1') ?? match?.[2] ?? '');
    if (!boundary || boundary.length > 200) throw new ParseError('mime_boundary_invalid');
    const delimiter = utf8.encode(`--${boundary}`);
    let partStart: number | null = null;
    for (let pos = body; pos < end;) {
      const next = lineEnd(pos, end);
      let same = next - pos >= delimiter.length;
      for (let i = 0; same && i < delimiter.length; i++) if (bytes[pos + i] !== delimiter[i]) same = false;
      const suffix = bytes[pos + delimiter.length];
      const closing = suffix === 45 && bytes[pos + delimiter.length + 1] === 45;
      if (same && (closing || suffix === 13 || suffix === 10 || suffix === 32 || suffix === 9 || suffix === undefined)) {
        if (partStart !== null) walk(partStart, pos, depth + 1);
        partStart = closing ? null : next;
        if (closing) return;
      }
      pos = next;
    }
    if (partStart !== null) throw new ParseError('mime_boundary_unclosed');
  }
  walk(0, bytes.length, 0);
}
function addresses(items: unknown): Address[] {
  const result: Address[] = [];
  for (const item of (Array.isArray(items) ? items : items ? [items] : [])) {
    if (item && typeof item === 'object') {
      if ('group' in item) result.push(...addresses(item.group));
      else if ('address' in item && typeof item.address === 'string') result.push({address:item.address, name:typeof item.name === 'string' ? item.name : ''});
    }
  }
  return result;
}
export async function parseMail(raw: ArrayBuffer, env: Env, prefix: string, options: {storeAttachmentCopies?: boolean} = {}): Promise<{mail: ParsedMail; bytes: number}> {
  if (raw.byteLength < 1 || raw.byteLength > MAX_RAW_BYTES) throw new ParseError('raw_limit');
  inspectMIME(new Uint8Array(raw));
  let parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
  try { parsed = await PostalMime.parse(raw, { maxNestingDepth: 20, maxHeadersSize: MAX_HEADERS, forceRfc822Attachments: true, maxRfc822NestingDepth: 1, attachmentEncoding: 'arraybuffer' }); }
  catch { throw new ParseError('mime_parse_failed'); }
  const sourceHTML = parsed.html ?? '';
  let safe = {html:'', text:''};
  let htmlOmitted = utf8.encode(sourceHTML).length > HTML_BYTES;
  if (!htmlOmitted) {
    try {
      safe = safeHTML(sourceHTML);
      // Escaping can expand the output even when the original was small.
      if (utf8.encode(safe.html).length > HTML_BYTES) { safe.html = ''; htmlOmitted = true; }
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      htmlOmitted = true;
    }
  }
  const selectedText = parsed.text?.trim() || safe.text.trim();
  const body = truncateUTF8(selectedText, UI_TEXT_BYTES);
  let decoded = utf8.encode(parsed.text ?? '').length + utf8.encode(sourceHTML).length;
  if (decoded > 50 * 1024 * 1024) throw new ParseError('decoded_limit');
  if ((parsed.attachments?.length ?? 0) > 200) throw new ParseError('attachment_limit');
  const mail: ParsedMail = {
    subject: parsed.subject ?? '', text:body.text, html:safe.html, from: addresses(parsed.from), to: addresses(parsed.to),
    cc: addresses(parsed.cc), reply_to: addresses(parsed.replyTo),
    sent_at: parsed.date && Number.isFinite(Date.parse(parsed.date)) ? new Date(parsed.date).toISOString() : null,
    rfc_message_id: parsed.messageId?.replace(/^<|>$/g, '') ?? null,
    headers: (parsed.headers ?? []).map(h => ({ key:h.key, value:h.value })), attachments: [], needs_review:false, warnings:[],
    text_truncated:body.truncated, original_text_bytes:body.original_bytes, html_omitted:htmlOmitted,
    attachments_omitted_count:0, content_policy_version:CONTENT_POLICY_VERSION,
  };
  if (body.truncated) mail.warnings.push('text_truncated');
  if (htmlOmitted) mail.warnings.push('html_omitted');
  if (utf8.encode(mail.subject).length > MAX_HEADERS) throw new ParseError('subject_limit');
  let storedBytes = 0;
  for (const [index, attachment] of (parsed.attachments ?? []).entries()) {
    const content = typeof attachment.content === 'string' ? utf8.encode(attachment.content) : attachment.content instanceof Uint8Array ? attachment.content : new Uint8Array(attachment.content);
    decoded += content.byteLength;
    if (decoded > 50 * 1024 * 1024) throw new ParseError('decoded_limit');
    if (/^(message\/rfc822|application\/(?:vnd\.ms-tnef|ms-tnef|pkcs7-mime))$/i.test(attachment.mimeType)) {
      mail.warnings.push('attached_or_opaque_message'); mail.needs_review = true;
    }
    if (index >= ATTACHMENT_METADATA_LIMIT) { mail.attachments_omitted_count!++; continue; }
    const key = `${prefix}/attachment-${index + 1}`;
    const filename = Array.from((attachment.filename || `attachment-${index + 1}`).replace(/\\/g, '/').split('/').pop()!.replace(/[\u0000-\u001f\u007f]/g, '_')).slice(0,120).join('');
    const item: Attachment = {part_id:`1.${index + 1}`, filename, content_type:attachment.mimeType || 'application/octet-stream', size:content.byteLength};
    const inlineImage = /^image\//i.test(item.content_type) && (attachment.disposition === 'inline' || attachment.related === true);
    const reason: Attachment['omitted_reason'] = inlineImage ? 'inline_image' : content.byteLength > ATTACHMENT_BYTES ? 'size_limit' : options.storeAttachmentCopies === false ? 'capacity' : storedBytes + content.byteLength > MESSAGE_ATTACHMENT_BYTES ? 'message_size_limit' : undefined;
    if (reason) {
      item.storage_status = 'omitted'; item.omitted_reason = reason;
      mail.warnings.push('attachment_copies_omitted');
    } else {
      await env.MAIL_STORE.put(key, content, {httpMetadata:{contentType:'application/octet-stream'}});
      storedBytes += content.byteLength;
      item.storage_status = 'stored'; item.r2_key = key;
    }
    mail.attachments.push(item);
  }
  if (mail.attachments_omitted_count) mail.warnings.push('attachment_metadata_limit');
  if (!mail.text && (!mail.subject.trim() || sourceHTML.trim())) {
    mail.warnings.push('no_readable_body'); mail.needs_review = true;
  }
  mail.warnings = [...new Set(mail.warnings)];
  return {mail, bytes:storedBytes};
}
