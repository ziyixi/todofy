import type { z } from 'zod';
import {
  canonicalInput, validateWork, workCheckpointSchema, workCreateSchema, workError, workReportSchema,
  type Work, type WorkAttention, type WorkCheckpointInput, type WorkCreateInput, type WorkFields,
  type WorkLink, type WorkLinkType, type WorkReportInput,
} from './work-model.ts';
import {
  exportWork, getWork, listWorks, readWork, readWorkContext, type WorkStorage,
} from './work-read.ts';

export type { WorkStorage } from './work-read.ts';
export type { Work, WorkAttention, WorkLink, WorkReportInput } from './work-model.ts';

type Receipt = { work_id: string; seq: number; input_fingerprint: string; mutation: string; applied_etag: number | null };

const columns = ['title', 'goal', 'scope', 'completion_criteria', 'state', 'checkpoint', 'next_action',
  'waiting_for', 'review_at', 'result'] as const;

/** Persistent checkpoints and bounded reports. Executors and schedules remain in their native applications. */
export class WorkStore {
  private readonly storage: WorkStorage;
  private readonly onAttention: (attention: WorkAttention) => void;

  constructor(storage: WorkStorage, onAttention: (attention: WorkAttention) => void = () => {}) {
    this.storage = storage;
    this.onAttention = onAttention;
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS work (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, scope TEXT NOT NULL,
        completion_criteria TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','waiting','done','cancelled')),
        checkpoint TEXT NOT NULL, next_action TEXT NOT NULL, waiting_for TEXT NOT NULL, review_at TEXT,
        result TEXT NOT NULL, etag INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_report_seq INTEGER NOT NULL DEFAULT 0, handled_through_report_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS work_state ON work(state,id);
      CREATE INDEX IF NOT EXISTS work_review ON work(state,review_at,id);
      CREATE TABLE IF NOT EXISTS work_entries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL,
        created_at TEXT NOT NULL, observed_at TEXT, evidence_ref TEXT NOT NULL DEFAULT '',
        source_type TEXT, source_ref TEXT, report_id TEXT, request_id TEXT UNIQUE, review_json TEXT,
        input_fingerprint TEXT, mutation TEXT, applied_etag INTEGER,
        UNIQUE(work_id,report_id)
      );
      CREATE INDEX IF NOT EXISTS work_history ON work_entries(work_id,seq);
      CREATE INDEX IF NOT EXISTS work_reports ON work_entries(work_id,seq) WHERE report_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS work_links (
        work_id TEXT NOT NULL, type TEXT NOT NULL, ref TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(work_id,type,ref)
      );
      CREATE INDEX IF NOT EXISTS work_link_source ON work_links(type,ref,work_id);
    `);
  }

  context(input: Parameters<typeof readWorkContext>[1] = {}) { return readWorkContext(this.storage, input); }
  list(input: Parameters<typeof listWorks>[1] = {}) { return listWorks(this.storage, input); }
  get(input: Parameters<typeof getWork>[1]) { return getWork(this.storage, input); }
  export(input: Parameters<typeof exportWork>[1] = {}) { return exportWork(this.storage, input); }

  create(raw: WorkCreateInput) {
    const input = workCreateSchema.parse(raw);
    const fingerprint = canonicalInput(input);
    return this.storage.transactionSync(() => {
      const previous = this.receipt(input.request_id, fingerprint, 'create');
      if (previous) return this.writeResult(previous, true);
      validateWork(input);
      const now = new Date().toISOString();
      const id = input.request_id;
      this.storage.sql.exec(`INSERT INTO work (id,${columns.join(',')},etag,created_at,updated_at) VALUES (${Array.from({ length: 14 }, () => '?').join(',')})`,
        id, ...columns.map(column => input[column]), 1, now, now);
      this.replaceLinks(id, input.links);
      const entry = this.storage.sql.exec<{ seq: number }>(`INSERT INTO work_entries
        (work_id,kind,summary,created_at,request_id,input_fingerprint,mutation,applied_etag)
        VALUES (?,'created','Work record created.',?,?,?,'create',1) RETURNING seq`,
      id, now, input.request_id, fingerprint).toArray()[0];
      if (!entry) throw new Error('Missing work create receipt');
      return this.writeResult({ work_id: id, seq: entry.seq, input_fingerprint: fingerprint, mutation: 'create', applied_etag: 1 }, false);
    });
  }

  checkpoint(raw: WorkCheckpointInput) {
    const input = workCheckpointSchema.parse(raw);
    const fingerprint = canonicalInput(input);
    return this.storage.transactionSync(() => {
      const previous = this.receipt(input.request_id, fingerprint, 'checkpoint');
      if (previous) return this.writeResult(previous, true);
      const current = readWork(this.storage, input.work_id);
      if (current.etag !== input.etag) workError('ETAG_MISMATCH', 'Read the work again and review the checkpoint change before using a new request_id.');
      const handled = this.handledSequence(current, input.handled_through_report_seq);
      const changes = Object.fromEntries(Object.entries(input.changes).filter(([, value]) => value !== undefined)) as Partial<WorkFields>;
      const candidate = { ...current, ...changes };
      this.preserveOwnedResources(current.links, candidate.links);
      validateWork(candidate);
      if (candidate.state === 'done' && current.last_report_seq > handled)
        workError('UNHANDLED_REPORTS', 'Read and handle pending reports before marking the work done.');
      const next = candidate.state === 'done' || candidate.state === 'cancelled'
        ? { ...candidate, next_action: '', waiting_for: '', review_at: null } : candidate;
      const now = new Date().toISOString();
      const revision = Number(current.etag) + 1;
      this.storage.sql.exec(`UPDATE work SET ${columns.map(column => `${column}=?`).join(',')},etag=?,updated_at=?,handled_through_report_seq=? WHERE id=?`,
        ...columns.map(column => next[column]), revision, now, handled, current.id);
      if (input.changes.links !== undefined) this.replaceLinks(current.id, next.links);
      const entry = this.storage.sql.exec<{ seq: number }>(`INSERT INTO work_entries
        (work_id,kind,summary,created_at,evidence_ref,request_id,input_fingerprint,mutation,applied_etag,review_json)
        VALUES (?,?,?,?,?,?,?,'checkpoint',?,?) RETURNING seq`, current.id, input.entry?.kind ?? 'checkpoint', input.entry?.summary ?? '',
      now, input.entry?.evidence_ref ?? '', input.request_id, fingerprint, revision,
      input.entry?.review ? JSON.stringify(input.entry.review) : null).toArray()[0];
      if (!entry) throw new Error('Missing checkpoint receipt');
      return this.writeResult({ work_id: current.id, seq: entry.seq, input_fingerprint: fingerprint, mutation: 'checkpoint', applied_etag: revision }, false);
    });
  }

  /** This transaction also freezes the caller's callback delivery; a queue failure rolls the report back. */
  report(raw: WorkReportInput) {
    const input = workReportSchema.parse(raw);
    const fingerprint = canonicalInput(input);
    return this.storage.transactionSync(() => {
      const previous = this.storage.sql.exec<{ seq: number; input_fingerprint: string; created_at: string }>(
        'SELECT seq,input_fingerprint,created_at FROM work_entries WHERE work_id=? AND report_id=?', input.work_id, input.report_id,
      ).toArray()[0];
      if (previous) {
        if (previous.input_fingerprint !== fingerprint) workError('REPORT_ID_CONFLICT', 'The report_id was already used with different input.');
        return { work_id: input.work_id, report_seq: previous.seq, repeated: true };
      }
      const current = readWork(this.storage, input.work_id);
      if (!current.links.some(link => link.type === input.source.type && link.ref === input.source.ref))
        workError('REPORT_SOURCE_NOT_LINKED', 'Attach the native source to the work before reporting its progress.');
      const now = new Date().toISOString();
      const entry = this.storage.sql.exec<{ seq: number }>(`INSERT INTO work_entries
        (work_id,kind,summary,created_at,observed_at,evidence_ref,source_type,source_ref,report_id,input_fingerprint)
        VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING seq`, current.id, input.kind, input.summary, now, input.observed_at ?? now,
      input.evidence_ref, input.source.type, input.source.ref, input.report_id, fingerprint).toArray()[0];
      if (!entry) throw new Error('Missing report sequence');
      // Reports do not change the checkpoint etag: handling N must leave a concurrent N+1 pending.
      this.storage.sql.exec('UPDATE work SET last_report_seq=?,updated_at=? WHERE id=?', entry.seq, now, current.id);
      const active = current.state === 'active' || current.state === 'waiting';
      if (active) this.onAttention({ event_id: `work_${current.id}_${String(entry.seq)}`, work_id: current.id,
        report_seq: entry.seq, kind: input.kind, source: input.source, timestamp: now });
      return { work_id: current.id, report_seq: entry.seq, repeated: false, attention: active };
    });
  }

  /** Private source adapters use IDs only; business bodies stay in their owning applications. */
  linkedWorkIds(type: WorkLinkType, ref: string): string[] {
    return this.storage.sql.exec<{ work_id: string }>(`SELECT l.work_id FROM work_links l JOIN work w ON w.id=l.work_id
      WHERE l.type=? AND l.ref=? AND w.state IN ('active','waiting') ORDER BY l.work_id`, type, ref).toArray().map(row => row.work_id);
  }

  private receipt(requestId: string, fingerprint: string, mutation: string): Receipt | undefined {
    const row = this.storage.sql.exec<Receipt>('SELECT work_id,seq,input_fingerprint,mutation,applied_etag FROM work_entries WHERE request_id=?', requestId).toArray()[0];
    if (row && (row.input_fingerprint !== fingerprint || row.mutation !== mutation))
      workError('REQUEST_ID_CONFLICT', 'The request_id was already used for different input.');
    return row;
  }

  private writeResult(receipt: Receipt, repeated: boolean) {
    return { work: readWork(this.storage, receipt.work_id), entry_seq: receipt.seq,
      applied_etag: String(receipt.applied_etag), repeated };
  }

  private replaceLinks(workId: string, links: readonly WorkLink[]): void {
    this.storage.sql.exec('DELETE FROM work_links WHERE work_id=?', workId);
    for (const link of links) this.storage.sql.exec('INSERT INTO work_links VALUES (?,?,?,?)', workId, link.type, link.ref, JSON.stringify(link));
  }

  private handledSequence(current: Work, supplied: number | undefined): number {
    if (supplied === undefined) return current.handled_through_report_seq;
    if (supplied < current.handled_through_report_seq || supplied > current.last_report_seq)
      return workError('INVALID_REPORT_SEQUENCE', 'handled_through_report_seq must advance within this work record’s observed report range.');
    if (supplied !== 0 && !this.storage.sql.exec<{ seq: number }>(
      'SELECT seq FROM work_entries WHERE work_id=? AND seq=? AND report_id IS NOT NULL', current.id, supplied,
    ).toArray().length) return workError('INVALID_REPORT_SEQUENCE', 'The handled sequence must identify a report from this work.');
    return supplied;
  }

  private preserveOwnedResources(previous: readonly WorkLink[], next: readonly WorkLink[]): void {
    for (const link of previous) {
      if (!link.owned || !['codex', 'watch', 'schedule'].includes(link.type)
        || link.stop_state === 'stopped' || link.type === 'codex' && link.stop_state === 'completed') continue;
      const replacement = next.find(item => item.type === link.type && item.ref === link.ref);
      if (!replacement?.owned) workError('RESOURCE_STOP_UNCONFIRMED', 'Confirm an owned resource is stopped before removing its link or ownership.');
    }
  }
}

export type WorkReport = z.infer<typeof workReportSchema>;
export type WorkCheckpoint = z.infer<typeof workCheckpointSchema>;
export type WorkCreate = z.infer<typeof workCreateSchema>;
export type { WorkFields };
