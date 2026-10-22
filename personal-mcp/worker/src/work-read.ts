import { z } from 'zod';
import {
  canonicalInput, workContextSchema, workError, workExportSchema, workGetSchema, workListSchema,
  type Work, type WorkEntry, type WorkLink,
} from './work-model.ts';

export type WorkStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;
export type WorkRow = Omit<Work, 'links' | 'etag'> & { etag: number };
export type EntryRow = Omit<WorkEntry, 'source' | 'review'> & {
  source_type: WorkLink['type'] | null; source_ref: string | null;
  review_json: string | null;
};

const tokenSchema = z.strictObject({
  kind: z.string(), selectors: z.string(), after: z.string().max(1000), before: z.number().int().nonnegative().default(0),
});
const contextPositionSchema = z.strictObject({
  as_of: z.iso.datetime(), rank: z.number().int().min(0).max(3), sort_at: z.iso.datetime(), id: z.uuid(),
});

function token(kind: string, selectors: unknown, after: string, before = 0): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ kind, selectors: canonicalInput(selectors), after, before }));
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
}

function cursor(input: string, kind: string, selectors: unknown): z.infer<typeof tokenSchema> | null {
  if (!input) return null;
  try {
    const bytes = Uint8Array.from(atob(input), character => character.charCodeAt(0));
    const parsed = tokenSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown);
    if (parsed.kind === kind && parsed.selectors === canonicalInput(selectors)) return parsed;
  } catch { /* Invalid or reused selectors must not widen a query. */ }
  return workError('INVALID_PAGE_TOKEN', 'Use a returned page token with the same selectors.');
}

export function readWork(storage: WorkStorage, id: string): Work {
  const row = storage.sql.exec<WorkRow>('SELECT * FROM work WHERE id = ?', id).toArray()[0];
  if (!row) return workError('WORK_NOT_FOUND', 'The work record was not found.');
  const links = storage.sql.exec<{ payload: string }>('SELECT payload FROM work_links WHERE work_id = ? ORDER BY type, ref', id)
    .toArray().map(link => JSON.parse(link.payload) as WorkLink);
  return { ...row, etag: String(row.etag), links };
}

export function readEntry(row: EntryRow): WorkEntry {
  return { seq: row.seq, work_id: row.work_id, kind: row.kind, summary: row.summary, created_at: row.created_at,
    observed_at: row.observed_at, evidence_ref: row.evidence_ref, report_id: row.report_id,
    source: row.source_type && row.source_ref ? { type: row.source_type, ref: row.source_ref } : null,
    review: row.review_json ? JSON.parse(row.review_json) as WorkEntry['review'] : null };
}

function summary(storage: WorkStorage, row: WorkRow) {
  const pending = storage.sql.exec<{ count: number }>(
    'SELECT count(*) AS count FROM work_entries WHERE work_id = ? AND report_id IS NOT NULL AND seq > ?',
    row.id, row.handled_through_report_seq,
  ).toArray()[0]?.count ?? 0;
  return { id: row.id, title: row.title, state: row.state, etag: String(row.etag),
    checkpoint: row.checkpoint.slice(0, 500), checkpoint_truncated: row.checkpoint.length > 500,
    next_action: row.next_action, waiting_for: row.waiting_for, review_at: row.review_at,
    pending_reports: pending, last_report_seq: row.last_report_seq,
    handled_through_report_seq: row.handled_through_report_seq, updated_at: row.updated_at };
}

export function readWorkContext(storage: WorkStorage, raw: z.input<typeof workContextSchema>) {
  const input = workContextSchema.parse(raw);
  const previous = cursor(input.page_token, 'context', {});
  let position: z.infer<typeof contextPositionSchema> | null = null;
  if (previous) {
    try { position = contextPositionSchema.parse(JSON.parse(previous.after) as unknown); }
    catch { workError('INVALID_PAGE_TOKEN', 'Use a returned context page token.'); }
  }
  const asOf = position?.as_of ?? new Date().toISOString();
  const rows = storage.sql.exec<WorkRow & {
    reason: 'report' | 'review_due' | 'waiting' | 'next_action'; context_rank: number; sort_at: string;
  }>(`WITH ranked AS (
      SELECT *, CASE WHEN last_report_seq > handled_through_report_seq THEN 0
        WHEN review_at IS NOT NULL AND review_at <= ? THEN 1 WHEN state = 'waiting' THEN 2 ELSE 3 END AS context_rank,
        COALESCE(review_at, updated_at) AS sort_at FROM work WHERE state IN ('active','waiting')
    ) SELECT *, CASE context_rank WHEN 0 THEN 'report' WHEN 1 THEN 'review_due' WHEN 2 THEN 'waiting'
      ELSE 'next_action' END AS reason FROM ranked
    ${position ? 'WHERE (context_rank,sort_at,id) > (?,?,?)' : ''}
    ORDER BY context_rank,sort_at,id LIMIT ?`, asOf,
  ...(position ? [position.rank, position.sort_at, position.id] : []), input.page_size + 1).toArray();
  const page = rows.slice(0, input.page_size);
  const last = page.at(-1);
  return { generated_at: asOf, works: page.map(row => ({ ...summary(storage, row), reason: row.reason })),
    next_page_token: rows.length > input.page_size && last ? token('context', {}, JSON.stringify({ as_of: asOf,
      rank: last.context_rank, sort_at: last.sort_at, id: last.id })) : '',
    meaning: 'review_at is a follow-up plan; only a linked native schedule proves a scheduled wakeup exists.' };
}

export function listWorks(storage: WorkStorage, raw: z.input<typeof workListSchema>) {
  const input = workListSchema.parse(raw);
  const selectors = { state: input.state, link_type: input.link_type, link_ref: input.link_ref };
  const after = cursor(input.page_token, 'list', selectors)?.after ?? '';
  const where = ['w.id > ?'];
  const bindings: SqlStorageValue[] = [after];
  if (input.state === 'open') where.push("w.state IN ('active','waiting')");
  else if (input.state !== 'all') { where.push('w.state = ?'); bindings.push(input.state); }
  if (input.link_type) {
    where.push(`EXISTS (SELECT 1 FROM work_links l WHERE l.work_id = w.id AND l.type = ?${input.link_ref ? ' AND l.ref = ?' : ''})`);
    bindings.push(input.link_type);
    if (input.link_ref) bindings.push(input.link_ref);
  }
  const rows = storage.sql.exec<WorkRow>(`SELECT w.* FROM work w WHERE ${where.join(' AND ')} ORDER BY w.id LIMIT ?`,
    ...bindings, input.page_size + 1).toArray();
  const page = rows.slice(0, input.page_size);
  return { works: page.map(row => summary(storage, row)),
    next_page_token: rows.length > input.page_size ? token('list', selectors, page.at(-1)?.id ?? '') : '' };
}

export function getWork(storage: WorkStorage, raw: z.input<typeof workGetSchema>) {
  const input = workGetSchema.parse(raw);
  const work = readWork(storage, input.work_id);
  const historyBefore = cursor(input.entry_page_token, 'entries', { work_id: work.id })?.before ?? Number.MAX_SAFE_INTEGER;
  const entries = storage.sql.exec<EntryRow>(`SELECT * FROM work_entries
    WHERE work_id = ? AND seq < ? AND summary <> '' ORDER BY seq DESC LIMIT ?`, work.id, historyBefore, input.entry_page_size + 1).toArray();
  const history = entries.slice(0, input.entry_page_size);
  const reportsAfter = cursor(input.report_page_token, 'reports', { work_id: work.id })?.before ?? work.handled_through_report_seq;
  const reports = storage.sql.exec<EntryRow>(`SELECT * FROM work_entries
    WHERE work_id = ? AND report_id IS NOT NULL AND seq > ? ORDER BY seq LIMIT ?`,
  work.id, Math.max(reportsAfter, work.handled_through_report_seq), input.report_page_size + 1).toArray();
  const pending = reports.slice(0, input.report_page_size);
  return { work, entries: history.map(readEntry),
    next_entry_page_token: entries.length > input.entry_page_size
      ? token('entries', { work_id: work.id }, '', history.at(-1)?.seq ?? 0) : '',
    pending_reports: pending.map(readEntry),
    handled_through_candidate: pending.at(-1)?.seq ?? work.handled_through_report_seq,
    next_report_page_token: reports.length > input.report_page_size
      ? token('reports', { work_id: work.id }, '', pending.at(-1)?.seq ?? 0) : '' };
}

/** Records and meaningful entries only; subscription callbacks, secrets and receipt fingerprints are excluded. */
export function exportWork(storage: WorkStorage, raw: z.input<typeof workExportSchema>) {
  const input = workExportSchema.parse(raw);
  const selectors = { work_id: input.work_id };
  const previous = cursor(input.page_token, 'export', selectors);
  const stage = previous?.after.startsWith('entries:') ? 'entries' : 'works';
  const after = previous?.after.split(':').slice(1).join(':') ?? '';
  if (input.work_id) readWork(storage, input.work_id);
  if (stage === 'works') {
    const rows = storage.sql.exec<{ id: string }>(`SELECT id FROM work WHERE id > ?${input.work_id ? ' AND id = ?' : ''} ORDER BY id LIMIT ?`,
      after, ...(input.work_id ? [input.work_id] : []), input.page_size + 1).toArray();
    const page = rows.slice(0, input.page_size);
    return { format: 'personal-work-memory-v1', section: stage, records: page.map(row => readWork(storage, row.id)),
      next_page_token: rows.length > input.page_size
        ? token('export', selectors, `works:${page.at(-1)?.id ?? ''}`) : token('export', selectors, 'entries:', 0) };
  }
  const rows = storage.sql.exec<EntryRow>(`SELECT * FROM work_entries WHERE seq > ? AND summary <> ''${input.work_id ? ' AND work_id = ?' : ''}
    ORDER BY seq LIMIT ?`, previous?.before ?? 0, ...(input.work_id ? [input.work_id] : []), input.page_size + 1).toArray();
  const page = rows.slice(0, input.page_size);
  return { format: 'personal-work-memory-v1', section: stage, records: page.map(readEntry),
    next_page_token: rows.length > input.page_size ? token('export', selectors, 'entries:', page.at(-1)?.seq ?? 0) : '' };
}
