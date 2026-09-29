import type { ParsedMail } from './parser.ts';

export const CONTENT_POLICY_VERSION = 'storage-v1';
export const UI_TEXT_BYTES = 1024 * 1024;
export const WEBHOOK_TEXT_BYTES = 256 * 1024;
export const HTML_BYTES = 2 * 1024 * 1024;
export const ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MESSAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_METADATA_LIMIT = 100;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal:true});

/** A byte budget may end inside a Unicode code point. Never emit a replacement
 * character in place of a partial tail, and report the size before truncation. */
export function truncateUTF8(text: string, maxBytes: number): {text: string; original_bytes: number; truncated: boolean} {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('invalid_text_budget');
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return {text, original_bytes:bytes.byteLength, truncated:false};
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return {text:decoder.decode(bytes.subarray(0, end)), original_bytes:bytes.byteLength, truncated:true};
}

/** Only call when creating a NEW event. Retries keep the original frozen bytes. */
export function webhookContent(mail: ParsedMail) {
  const body = truncateUTF8(mail.text, WEBHOOK_TEXT_BYTES);
  const truncated = body.truncated || mail.text_truncated === true;
  const originalBytes = Math.max(body.original_bytes, mail.original_text_bytes ?? 0);
  const omitted = (mail.attachments_omitted_count ?? 0) + Math.max(0, mail.attachments.length - ATTACHMENT_METADATA_LIMIT);
  const warnings = new Set(mail.warnings ?? []);
  if (truncated) warnings.add('text_truncated');
  if (omitted) warnings.add('attachment_metadata_limit');
  return {
    text:body.text, text_truncated:truncated, original_text_bytes:originalBytes,
    html_omitted:mail.html_omitted === true, needs_review:mail.needs_review === true,
    warnings:[...warnings], content_policy_version:CONTENT_POLICY_VERSION,
    attachments_omitted_count:omitted,
    attachments:mail.attachments.slice(0, ATTACHMENT_METADATA_LIMIT).map(attachment => ({
      filename:attachment.filename, content_type:attachment.content_type, size:attachment.size,
      ...(attachment.storage_status ? {storage_status:attachment.storage_status} : {}),
      ...(attachment.omitted_reason ? {omitted_reason:attachment.omitted_reason} : {}),
    })),
  };
}
