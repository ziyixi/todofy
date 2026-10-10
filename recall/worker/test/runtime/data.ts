/**
 * Synthetic uploads for the workerd suite: batches, visits and captured texts in recall-ingest-v1's wire JSON, as the
 * extension sends them (normalized, scrubbed, with the page ID of the whole normalized URL). Pages on example.com,
 * example.org and example.net; texts written for the tests.
 */
import { normalizeUrl, pageIdOf } from '../../../shared/url.ts';
import { T0 } from './harness.ts';

export const DEVICE = { device_id: '5d0c3b52-8a5e-4f8e-9b8e-2d7c1a6f4e10', label: 'MacBook · 工作', extension_version: '2026.1010.900', queued_count: 0 };

/** A deterministic lower-case UUID (version 4 shape) for item `n`. */
export function uuid(n: number, kind = 0): string {
  return `${kind.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export const iso = (ms: number) => new Date(ms).toISOString();

export function batch(items: readonly unknown[], options: { sentMs?: number; device?: Partial<typeof DEVICE> & { last_error_code?: string }; batchId?: string } = {}): unknown {
  return {
    version: 'recall-ingest-v1',
    batch_id: options.batchId ?? crypto.randomUUID(),
    sent_time: iso(options.sentMs ?? T0),
    device: { ...DEVICE, ...options.device },
    items,
  };
}

/** The normalized URL and page ID of a URL, as the extension computes them. */
export async function page(url: string): Promise<{ url: string; pageId: string }> {
  const normalized = normalizeUrl(url);
  if (normalized === null) throw new Error('not an http(s) URL');
  return { url: normalized.url, pageId: await pageIdOf(normalized.url) };
}

export interface VisitInput {
  readonly id: string;
  readonly url: string;
  readonly title?: string;
  readonly revision?: number;
  /** Focus spans [start_ms, end_ms]. */
  readonly spans: readonly (readonly [number, number])[];
  /** Overrides (an older or broken build's item). */
  readonly pageId?: string;
  readonly rawUrl?: boolean;
}

export async function visit(input: VisitInput): Promise<unknown> {
  const normalized = input.rawUrl === true ? { url: input.url, pageId: input.pageId ?? '0'.repeat(32) } : await page(input.url);
  return {
    kind: 'visit',
    visit: {
      id: input.id,
      revision: input.revision ?? 1,
      page_id: input.pageId ?? normalized.pageId,
      url: normalized.url,
      title: input.title ?? '',
      focus_spans: input.spans.map(([start, end]) => ({ start_time: iso(start), end_time: iso(end) })),
    },
  };
}

export interface DocumentInput {
  readonly id: string;
  readonly visitId: string;
  readonly url: string;
  readonly title?: string;
  readonly description?: string;
  readonly captureMs: number;
  readonly text: string;
  readonly truncated?: boolean;
}

export async function document(input: DocumentInput): Promise<unknown> {
  const normalized = await page(input.url);
  return {
    kind: 'document',
    document: {
      id: input.id,
      visit_id: input.visitId,
      page_id: normalized.pageId,
      url: normalized.url,
      title: input.title ?? '',
      description: input.description ?? '',
      capture_time: iso(input.captureMs),
      text: input.text,
      ...(input.truncated === true ? { text_truncated: true } : {}),
    },
  };
}

export interface IngestAnswer {
  readonly accepted_count: number;
  readonly rejected: readonly { readonly id: string; readonly reason: string }[];
  readonly denylist_patterns: readonly string[];
  readonly denylist_etag: string;
}

export interface Change {
  readonly seq: number;
  readonly id: string;
  readonly kind: string;
  readonly page_id?: string;
  readonly blobs: readonly { readonly path: string; readonly sha256: string; readonly size_bytes: number }[];
  readonly visit?: Record<string, unknown>;
  readonly document?: Record<string, unknown>;
  readonly tombstone?: { readonly target: string };
}

export interface ChangePage {
  readonly version: string;
  readonly feed_id: string;
  readonly changes: readonly Change[];
  readonly last_seq: number;
  readonly head_seq: number;
  readonly oldest_seq: number;
}

/** A synthetic Chinese and English text of about `bytes` bytes of UTF-8. */
export function text(bytes: number, seed = 0): string {
  const sentences = [
    `第${String(seed)}段：Durable Object 是一个有名字的单例，带自己的 SQLite 存储。`,
    'This synthetic page explains alarms, storage and the 30 second CPU budget. ',
    '全文检索用二元分词处理中文，数据库的索引会稍微变大。',
    'Every archive consumer applies the change feed idempotently. ',
  ];
  let out = '';
  for (let i = 0; new TextEncoder().encode(out).byteLength < bytes; i++) out += sentences[i % sentences.length] ?? '';
  return out;
}
