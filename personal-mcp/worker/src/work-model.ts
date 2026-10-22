import { ProtocolError } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const workIdSchema = z.uuid();
export const workStateSchema = z.enum(['active', 'waiting', 'done', 'cancelled']);
export const workLinkTypeSchema = z.enum(['task', 'codex', 'watch', 'recall', 'schedule', 'artifact']);
const timestamp = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const pageSize = z.number().int().min(1).max(50).default(20);
const pageToken = z.string().max(2048).default('');

export const workLinkSchema = z.strictObject({
  type: workLinkTypeSchema,
  ref: z.string().min(1).max(1000),
  label: z.string().max(200).default(''),
  owned: z.boolean().default(false),
  stop_state: z.enum(['unconfirmed', 'stopped', 'completed']).default('unconfirmed'),
  observed_at: timestamp.nullable().default(null),
  observation: z.string().max(1000).default(''),
}).refine(link => link.stop_state === 'unconfirmed' || link.observed_at !== null && link.observation.trim().length > 0,
  'A confirmed resource outcome requires observed_at and an observation.');

const fields = {
  title: z.string().trim().min(1).max(300),
  goal: z.string().trim().min(1).max(2000),
  scope: z.string().trim().min(1).max(2000),
  completion_criteria: z.string().trim().min(1).max(2000),
  state: workStateSchema,
  checkpoint: z.string().max(4000),
  next_action: z.string().max(2000),
  waiting_for: z.string().max(2000),
  review_at: timestamp.nullable(),
  result: z.string().max(4000),
  links: z.array(workLinkSchema).max(32),
};

export const workNoteSchema = z.strictObject({
  kind: z.enum(['fact', 'decision', 'progress', 'watch_review']),
  summary: z.string().trim().min(1).max(2000),
  evidence_ref: z.string().max(1000).default(''),
  review: z.strictObject({
    change_ref: z.string().min(1).max(1000),
    verdict: z.enum(['relevant', 'irrelevant', 'uncertain']),
    reason: z.string().trim().min(1).max(2000),
  }).optional(),
}).refine(entry => (entry.kind === 'watch_review') === (entry.review !== undefined),
  'watch_review requires a structured review, and other entry kinds omit it.');

export const workCreateSchema = z.strictObject({
  request_id: z.uuid(),
  ...fields,
  state: workStateSchema.default('active'),
  checkpoint: fields.checkpoint.default(''),
  next_action: fields.next_action.default(''),
  waiting_for: fields.waiting_for.default(''),
  review_at: fields.review_at.default(null),
  result: fields.result.default(''),
  links: fields.links.default([]),
});

export const workCheckpointSchema = z.strictObject({
  work_id: workIdSchema,
  request_id: z.uuid(),
  etag: z.string().regex(/^[1-9][0-9]{0,15}$/),
  changes: z.strictObject(fields).partial().default({}),
  entry: workNoteSchema.optional(),
  handled_through_report_seq: z.number().int().nonnegative().optional(),
}).refine(input => Object.keys(input.changes).length > 0 || input.entry !== undefined
  || input.handled_through_report_seq !== undefined, 'Supply a checkpoint change, entry or handled report sequence.');

export const workReportSchema = z.strictObject({
  work_id: workIdSchema,
  report_id: z.string().min(1).max(200),
  kind: z.enum(['progress', 'question', 'blocked', 'result']),
  summary: z.string().trim().min(1).max(2000),
  source: z.strictObject({ type: workLinkTypeSchema, ref: z.string().min(1).max(1000) }),
  observed_at: timestamp.optional(),
  evidence_ref: z.string().max(1000).default(''),
});

export const workContextSchema = z.strictObject({ page_size: pageSize, page_token: pageToken });
export const workListSchema = z.strictObject({
  state: z.enum(['open', 'all', ...workStateSchema.options]).default('open'),
  link_type: workLinkTypeSchema.optional(),
  link_ref: z.string().min(1).max(1000).optional(),
  page_size: pageSize,
  page_token: pageToken,
}).refine(input => input.link_ref === undefined || input.link_type !== undefined, 'link_ref requires link_type.');
export const workGetSchema = z.strictObject({
  work_id: workIdSchema,
  entry_page_size: pageSize,
  entry_page_token: pageToken,
  report_page_size: pageSize,
  report_page_token: pageToken,
});
export const workExportSchema = z.strictObject({
  work_id: workIdSchema.optional(),
  page_size: pageSize,
  page_token: pageToken,
});

export type WorkState = z.infer<typeof workStateSchema>;
export type WorkLink = z.infer<typeof workLinkSchema>;
export type WorkLinkType = z.infer<typeof workLinkTypeSchema>;
export type WorkCreateInput = z.input<typeof workCreateSchema>;
export type WorkCheckpointInput = z.input<typeof workCheckpointSchema>;
export type WorkReportInput = z.input<typeof workReportSchema>;
export type WorkFields = z.infer<z.ZodObject<typeof fields>>;
export type Work = WorkFields & {
  id: string;
  etag: string;
  created_at: string;
  updated_at: string;
  last_report_seq: number;
  handled_through_report_seq: number;
};
export type WorkEntry = {
  seq: number;
  work_id: string;
  kind: 'created' | 'checkpoint' | 'fact' | 'decision' | 'progress' | 'question' | 'blocked' | 'result' | 'watch_review';
  summary: string;
  created_at: string;
  observed_at: string | null;
  evidence_ref: string;
  report_id: string | null;
  source: { type: WorkLinkType; ref: string } | null;
  review: z.infer<typeof workNoteSchema>['review'] | null;
};
export type WorkAttention = {
  event_id: string;
  work_id: string;
  report_seq: number;
  kind: z.infer<typeof workReportSchema>['kind'];
  source: z.infer<typeof workReportSchema>['source'];
  timestamp: string;
};

export function workError(reason: string, message: string): never {
  throw new ProtocolError(-32602, message, { reason });
}

export function canonicalInput(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalInput).join(',')}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalInput(item)}`).join(',')}}`;
}

export function validateWork(work: WorkFields): void {
  const keys = work.links.map(link => `${link.type}:${link.ref}`);
  if (new Set(keys).size !== keys.length) workError('DUPLICATE_LINK', 'Link type and ref must be unique within a work record.');
  if (work.state === 'active' && !work.next_action.trim()) workError('NEXT_ACTION_REQUIRED', 'Active work requires a next_action.');
  if (work.state === 'waiting' && !work.waiting_for.trim()) workError('WAITING_FOR_REQUIRED', 'Waiting work requires waiting_for.');
  if (!['done', 'cancelled'].includes(work.state)) return;
  if (!work.result.trim()) workError('RESULT_REQUIRED', 'Finished work requires a result describing the confirmed outcome.');
  if (work.links.some(link => link.owned && ['watch', 'schedule', 'codex'].includes(link.type)
    && !(link.stop_state === 'stopped' || link.type === 'codex' && link.stop_state === 'completed')))
    workError('RESOURCE_STOP_UNCONFIRMED', 'Keep the work open until its owned Watch, schedule and Codex resources are confirmed stopped or completed.');
}
