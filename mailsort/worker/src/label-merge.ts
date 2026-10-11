/** A private, owner-confirmed label consolidation. Gmail IDs and historical predictions remain stable.
 * One alarm advances bounded work; every label swap has a durable intent and a metadata read-back.
 * No bodies, classifiers, arbitrary Gmail operations or separate task infrastructure are involved.
 */
import { GoogleError, isUserLabelId, type GmailClient, type Ownership } from './gmail.ts';
import { newEtag, timeId } from './ids.ts';
import { DESCRIPTION_MAX, EXAMPLES_PER_LABEL_MAX, LABELS_MAX, TRUSTED_DOMAINS_PER_LABEL_MAX } from './limits.ts';
import { ownerPath } from './paths.ts';
import { readSettings } from './settings.ts';
import type { Budget } from './session.ts';
import type { LabelRow, Store } from './store.ts';
export interface MergePlanItem {
  readonly sources: readonly {
    readonly labelId: string;
    readonly etag: string;
  }[];
  readonly targetLabelId: string;
  readonly displayName: string;
  readonly description?: string;
}

interface Source {
  id: string;
  gmailId: string;
  name: string;
  etag: string;
}

interface Group {
  sources: Source[];
  targetLabelId: string;
  displayName: string;
  description: string;
}

export type MergeState = 'running' | 'blocked' | 'succeeded';
export type MergePhase = 'preflight' | 'rename' | 'move' | 'verify' | 'hide' | 'complete';
interface Job extends Record<string, SqlStorageValue> {
  id: string;
  state: MergeState;
  phase: MergePhase;
  plan: string;
  group_index: number;
  source_index: number;
  parents: string;
  error_code: string;
  create_time: number;
  update_time: number;
  etag: string;
}

interface Item extends Record<string, SqlStorageValue> {
  job_id: string;
  message_id: string;
  source_id: string;
  target_id: string;
  source_gmail_id: string;
  target_gmail_id: string;
  state: string;
  before_labels: string | null;
  history_start: string | null;
  history_end: string | null;
}

export interface MergeSummary {
  readonly id: string;
  readonly state: MergeState;
  readonly phase: MergePhase;
  readonly errorCode: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly etag: string;
  readonly processedCount: number;
  readonly groups: readonly {
    readonly targetLabelId: string;
    readonly sourceLabelIds: readonly string[];
    readonly displayName: string;
    readonly state: 'pending' | 'running' | 'succeeded';
    readonly processedCount: number;
  }[];
}

export class MergeError extends Error {
  readonly code: 'MERGE_INVALID_PLAN' | 'MERGE_ETAG_MISMATCH' | 'MERGE_BUSY' | 'MERGE_PENDING_WRITES' | 'MERGE_NOT_FOUND' | 'MERGE_NOT_BLOCKED';
  constructor(code: MergeError['code']) {
    super(code);
    this.code = code;
  }
}

class MergeBlocked extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function latest(store: Store): Job | undefined {
  return store.one<Job>(`SELECT * FROM label_merge_jobs ORDER BY create_time DESC, id DESC LIMIT 1`);
}

function groups(job: Job): Group[] {
  return JSON.parse(job.plan) as Group[];
}

export function migrationActive(store: Store): boolean {
  const job = latest(store);
  return job !== undefined && job.state !== 'succeeded';
}

export function labelMergeSummary(store: Store): MergeSummary | null {
  const job = latest(store);
  if (job === undefined) {
    return null;
  }
  const counts = new Map(store.all<{
    target_id: string;
    n: number;
  }>(`SELECT target_id, count(*) AS n FROM label_merge_items WHERE job_id = ? AND state = 'complete' GROUP BY target_id`, job.id).map((row) => [row.target_id, row.n]));
  return {
    id: job.id,
    state: job.state,
    phase: job.phase,
    errorCode: job.error_code,
    createdAt: job.create_time,
    updatedAt: job.update_time,
    etag: job.etag,
    processedCount: [...counts.values()].reduce((a, b) => a + b, 0),
    groups: groups(job).map((group, index) => {
      let state: 'pending' | 'running' | 'succeeded' = 'pending';
      if (job.state === 'succeeded' || index < job.group_index) state = 'succeeded';
      else if (index === job.group_index && job.phase !== 'preflight') state = 'running';
      return {
        targetLabelId: group.targetLabelId,
        sourceLabelIds: group.sources.map((source) => source.id),
        displayName: group.displayName,
        state,
        processedCount: counts.get(group.targetLabelId) ?? 0,
      };
    })
  };
}

/** Call in the API's transaction with its request-id receipt. All input stays in the private object. */
export function createLabelMerge(store: Store, input: readonly MergePlanItem[], now: number, requestId: string): MergeSummary {
  const existing = store.one<Job>(`SELECT * FROM label_merge_jobs WHERE id = ?`, requestId);
  if (existing !== undefined) {
    if (latest(store)?.id !== existing.id) {
      throw new MergeError('MERGE_BUSY');
    }
    const summary = labelMergeSummary(store);
    if (summary === null) {
      throw new MergeError('MERGE_NOT_FOUND');
    }
    return summary;
  }
  if (migrationActive(store)) {
    throw new MergeError('MERGE_BUSY');
  }
  if (store.one(`SELECT 1 FROM ledger WHERE state IN ('intended', 'undo_intended') LIMIT 1`) !== undefined) {
    throw new MergeError('MERGE_PENDING_WRITES');
  }
  if (input.length === 0 || input.length > LABELS_MAX) {
    throw new MergeError('MERGE_INVALID_PLAN');
  }
  const ids = new Set<string>();
  const gmailIds = new Set<string>();
  const names = new Set<string>();
  const active = store.labels();
  const plan: Group[] = input.map((group) => {
    if (group.sources.length === 0 || group.sources.length > LABELS_MAX || group.targetLabelId !== group.sources[0]?.labelId || ownerPath(group.displayName) !== group.displayName || names.has(group.displayName)) {
      throw new MergeError('MERGE_INVALID_PLAN');
    }
    names.add(group.displayName);
    let target: LabelRow | undefined;
    const sources = group.sources.map((source) => {
      const row = active.find((label) => label.id === source.labelId);
      if (row === undefined || ids.has(row.id) || row.gmail_state !== 'linked' || row.gmail_id === null || !isUserLabelId(row.gmail_id) || gmailIds.has(row.gmail_id)) {
        throw new MergeError('MERGE_INVALID_PLAN');
      }
      if (row.etag !== source.etag) {
        throw new MergeError('MERGE_ETAG_MISMATCH');
      }
      ids.add(row.id);
      gmailIds.add(row.gmail_id);
      target ??= row;
      if (row.trust !== target.trust || row.sensitive !== target.sensitive || row.keep_in_inbox !== target.keep_in_inbox || row.enabled !== target.enabled) {
        throw new MergeError('MERGE_INVALID_PLAN');
      }
      return {
        id: row.id,
        gmailId: row.gmail_id,
        name: row.display_name,
        etag: row.etag
      };
    });
    const domains = new Set(sources.flatMap((source) => store.trustedDomains(source.id)));
    if (domains.size > TRUSTED_DOMAINS_PER_LABEL_MAX) {
      throw new MergeError('MERGE_INVALID_PLAN');
    }
    const description = group.description ?? target?.description ?? '';
    if (description.length > DESCRIPTION_MAX) {
      throw new MergeError('MERGE_INVALID_PLAN');
    }
    return {
      sources,
      targetLabelId: group.targetLabelId,
      displayName: group.displayName,
      description
    };
  });
  for (const group of plan) {
    if (active.some((label) => label.display_name === group.displayName && label.id !== group.targetLabelId)) {
      throw new MergeError('MERGE_INVALID_PLAN');
    }
  }
  store.run(`INSERT INTO label_merge_jobs (id, state, phase, plan, create_time, update_time, etag) VALUES (?, 'running', 'preflight', ?, ?, ?, ?)`, requestId, JSON.stringify(plan), now, now, newEtag(now));
  const summary = labelMergeSummary(store);
  if (summary === null) {
    throw new MergeError('MERGE_NOT_FOUND');
  }
  return summary;
}

export function resumeLabelMerge(store: Store, jobId: string, now: number): MergeSummary {
  const job = latest(store);
  if (job === undefined || job.id !== jobId) {
    throw new MergeError('MERGE_NOT_FOUND');
  }
  if (job.state !== 'blocked') {
    throw new MergeError('MERGE_NOT_BLOCKED');
  }
  store.run(`UPDATE label_merge_jobs SET state = 'running', error_code = '', update_time = ?, etag = ? WHERE id = ?`, now, newEtag(now), job.id);
  const summary = labelMergeSummary(store);
  if (summary === null) {
    throw new MergeError('MERGE_NOT_FOUND');
  }
  return summary;
}

/** The guard can only authorize the frozen plan, durable message intents, and freshly verified empty labels. */
export function mergeOwnership(store: Store): Pick<Ownership, 'mergeListLabel' | 'mergeMessage' | 'mergeSwap' | 'mergeHide' | 'mergeRename'> {
  const running = () => {
    const job = latest(store);
    return job?.state === 'running' ? job : undefined;
  };
  return {
    mergeListLabel: (id) => {
      const job = running();
      return job !== undefined && (groups(job).some((group) => group.sources.some((source) => source.gmailId === id)) || (JSON.parse(job.parents) as string[]).includes(id));
    },
    mergeMessage: (id) => {
      const job = running();
      return job !== undefined && store.one(`SELECT 1 FROM label_merge_items WHERE job_id = ? AND message_id = ? LIMIT 1`, job.id, id) !== undefined;
    },
    mergeSwap: (id, source, target) => {
      const job = running();
      return job !== undefined && store.one(`SELECT 1 FROM label_merge_items WHERE job_id = ? AND message_id = ? AND source_gmail_id = ? AND target_gmail_id = ? AND state = 'pending' AND before_labels IS NOT NULL`, job.id, id, source, target) !== undefined;
    },
    mergeHide: (id) => {
      const job = running();
      return job !== undefined && store.one(`SELECT 1 FROM label_merge_hides WHERE job_id = ? AND gmail_id = ? AND state = 'verified'`, job.id, id) !== undefined;
    },
    mergeRename: (id) => {
      const job = running();
      return job === undefined ? null : groups(job).find((group) => group.sources[0]?.gmailId === id)?.displayName ?? null;
    }
  };
}

export interface MergeContext {
  readonly store: Store;
  readonly gmail: GmailClient;
  readonly budget: Budget;
  readonly now: () => number;
  readonly transact: <T>(fn: () => T) => T;
  readonly canWrite: () => boolean;
}

function advance(ctx: MergeContext, job: Job, phase: MergePhase, groupIndex = job.group_index, sourceIndex = 1): void {
  const now = ctx.now();
  ctx.transact(() => ctx.store.run(`UPDATE label_merge_jobs SET phase = ?, group_index = ?, source_index = ?, update_time = ?, etag = ? WHERE id = ?`, phase, groupIndex, sourceIndex, now, newEtag(now), job.id));
}
async function preflight(ctx: MergeContext, job: Job): Promise<void> {
  const labels = await ctx.gmail.labels();
  const plan = groups(job);
  for (const group of plan) {
    for (const source of group.sources) {
      if (!labels.some((label) => label.id === source.gmailId && label.name === source.name && label.type !== 'system')) {
        throw new MergeBlocked('label_changed');
      }
      if (labels.some((label) => label.name.startsWith(`${source.name}/`))) {
        throw new MergeBlocked('label_has_children');
      }
    }
    if (labels.some((label) => label.name.startsWith(`${group.displayName}/`))) {
      throw new MergeBlocked('label_has_children');
    }
    if (labels.some((label) => label.name === group.displayName && label.id !== group.sources[0]?.gmailId)) {
      throw new MergeBlocked('label_name_taken');
    }
  }
  const ownParents = new Set(ctx.store.all<{
    gmail_id: string;
  }>(`SELECT gmail_id FROM gmail_parents`).map((row) => row.gmail_id));
  const allSources = plan.flatMap((group) => group.sources);
  const parents = labels.filter((label) => ownParents.has(label.id) && allSources.some((source) => source.name.startsWith(`${label.name}/`))).map((label) => label.id);
  ctx.transact(() => {
    ctx.store.run(`UPDATE label_merge_jobs SET parents = ? WHERE id = ?`, JSON.stringify(parents), job.id);
    for (const id of [...allSources.filter((source) => !plan.some((group) => group.targetLabelId === source.id)).map((source) => source.gmailId), ...parents]) {
      ctx.store.run(`INSERT OR IGNORE INTO label_merge_hides (job_id, gmail_id) VALUES (?, ?)`, job.id, id);
    }
    ctx.store.run(`UPDATE label_merge_jobs SET phase = 'rename', update_time = ?, etag = ? WHERE id = ?`, ctx.now(), newEtag(ctx.now()), job.id);
  });
}
async function rename(ctx: MergeContext, job: Job, group: Group): Promise<void> {
  const target = group.sources[0];
  if (target === undefined) {
    throw new MergeBlocked('plan_invalid');
  }
  const labels = await ctx.gmail.labels();
  const actual = labels.find((label) => label.id === target.gmailId);
  if (actual === undefined || (actual.name !== target.name && actual.name !== group.displayName)) {
    throw new MergeBlocked('label_changed');
  }
  if (labels.some((label) => label.name === group.displayName && label.id !== target.gmailId)) {
    throw new MergeBlocked('label_name_taken');
  }
  if (actual.name !== group.displayName) {
    reserveWrite(ctx);
    await ctx.gmail.renameLabel(target.gmailId, group.displayName);
  }
  const verified = (await ctx.gmail.labels()).find((label) => label.id === target.gmailId);
  if (verified?.name !== group.displayName) {
    throw new MergeBlocked('rename_unverified');
  }
  ctx.transact(() => {
    ctx.store.run(`UPDATE labels SET display_name = ?, description = ?, problem = '', desc_version = desc_version + 1 WHERE id = ?`, group.displayName, group.description, target.id);
    ctx.store.touchLabel(target.id, ctx.now());
    ctx.store.run(`UPDATE label_merge_jobs SET phase = 'move', source_index = 1, update_time = ?, etag = ? WHERE id = ?`, ctx.now(), newEtag(ctx.now()), job.id);
  });
}
async function moveItem(ctx: MergeContext, item: Item): Promise<void> {
  let current = await ctx.gmail.mergeMetadata(item.message_id);
  if (item.before_labels === null) {
    if (!current.labels.includes(item.source_gmail_id)) {
      throw new MergeBlocked('message_changed');
    }
    ctx.transact(() => ctx.store.run(`UPDATE label_merge_items SET before_labels = ?, history_start = ? WHERE job_id = ? AND message_id = ? AND source_id = ?`, JSON.stringify(current.labels), current.historyId, item.job_id, item.message_id, item.source_id));
  }
  if (current.labels.includes(item.source_gmail_id)) {
    if (item.before_labels !== null && (JSON.stringify([...current.labels].sort()) !== JSON.stringify((JSON.parse(item.before_labels) as string[]).sort()) || current.historyId !== item.history_start)) {
      throw new MergeBlocked('message_changed');
    }
    if (!ctx.canWrite()) {
      return;
    }
    reserveWrite(ctx);
    await ctx.gmail.swapMergeLabel(item.message_id, item.source_gmail_id, item.target_gmail_id);
    current = await ctx.gmail.mergeMetadata(item.message_id);
  }
  if (current.labels.includes(item.source_gmail_id) || !current.labels.includes(item.target_gmail_id)) {
    throw new MergeBlocked('swap_unverified');
  }
  const persisted = ctx.store.one<{
    before_labels: string;
  }>(`SELECT before_labels FROM label_merge_items WHERE job_id = ? AND message_id = ? AND source_id = ?`, item.job_id, item.message_id, item.source_id);
  const before = JSON.parse(persisted?.before_labels ?? '[]') as string[];
  const expected = [...new Set([...before.filter((id) => id !== item.source_gmail_id), item.target_gmail_id])].sort();
  if (JSON.stringify([...current.labels].sort()) !== JSON.stringify(expected)) {
    throw new MergeBlocked('other_labels_changed');
  }
  ctx.transact(() => {
    ctx.store.run(`UPDATE label_merge_items SET state = 'complete', history_end = ? WHERE job_id = ? AND message_id = ? AND source_id = ?`, current.historyId, item.job_id, item.message_id, item.source_id);
    const decision = ctx.store.decision(item.message_id);
    if (decision !== undefined) {
      const labels = (JSON.parse(decision.current_labels) as string[]).filter((id) => id !== item.source_id);
      ctx.store.run(`UPDATE decisions SET current_labels = ? WHERE message_id = ?`, JSON.stringify([...new Set([...labels, item.target_id])]), item.message_id);
    }
  });
}

function checkGroupIdentity(labels: readonly {
  id: string;
  name: string;
}[], group: Group): void {
  for (const source of group.sources) {
    const expected = source.id === group.targetLabelId ? group.displayName : source.name;
    if (!labels.some((label) => label.id === source.gmailId && label.name === expected)) {
      throw new MergeBlocked('label_changed');
    }
  }
  if (labels.some((label) => label.name.startsWith(`${group.displayName}/`))) {
    throw new MergeBlocked('label_has_children');
  }
}
async function move(ctx: MergeContext, job: Job, group: Group): Promise<void> {
  const source = group.sources[job.source_index];
  if (source === undefined) {
    advance(ctx, job, 'verify');
    return;
  }
  const target = group.sources[0];
  if (target === undefined) {
    throw new MergeBlocked('plan_invalid');
  }
  let pending = ctx.store.one<Item>(`SELECT * FROM label_merge_items WHERE job_id = ? AND source_id = ? AND state = 'pending' ORDER BY message_id LIMIT 1`, job.id, source.id);
  if (pending === undefined) {
    checkGroupIdentity(await ctx.gmail.labels(), group);
    const ids = await ctx.gmail.mergeMessages(source.gmailId);
    if (ids.length === 0) {
      advance(ctx, job, 'move', job.group_index, job.source_index + 1);
      return;
    }
    ctx.transact(() => {
      for (const id of ids) {
        if (ctx.store.one(`SELECT 1 FROM label_merge_items WHERE job_id = ? AND source_id = ? AND message_id = ? AND state = 'complete'`, job.id, source.id, id) !== undefined) {
          throw new MergeBlocked('source_reapplied');
        }
        ctx.store.run(`INSERT OR IGNORE INTO label_merge_items (job_id, message_id, source_id, target_id, source_gmail_id, target_gmail_id) VALUES (?, ?, ?, ?, ?, ?)`, job.id, id, source.id, target.id, source.gmailId, target.gmailId);
      }
    });
    pending = ctx.store.one<Item>(`SELECT * FROM label_merge_items WHERE job_id = ? AND source_id = ? AND state = 'pending' ORDER BY message_id LIMIT 1`, job.id, source.id);
  }
  if (pending !== undefined) {
    await moveItem(ctx, pending);
  }
}
async function verify(ctx: MergeContext, job: Job, group: Group): Promise<void> {
  const source = group.sources[job.source_index];
  if (source !== undefined) {
    if ((await ctx.gmail.mergeMessages(source.gmailId, 1)).length > 0) {
      throw new MergeBlocked('source_not_empty');
    }
    advance(ctx, job, 'verify', job.group_index, job.source_index + 1);
    return;
  }
  const next = job.group_index + 1;
  advance(ctx, job, next < groups(job).length ? 'rename' : 'hide', next);
}
async function hide(ctx: MergeContext, job: Job): Promise<void> {
  const row = ctx.store.one<{
    gmail_id: string;
  }>(`SELECT gmail_id FROM label_merge_hides WHERE job_id = ? AND state != 'complete' ORDER BY gmail_id LIMIT 1`, job.id);
  if (row === undefined) {
    finish(ctx, job);
    return;
  }
  // This proof is refreshed even when a previous hide's response was lost.
  const empty = (await ctx.gmail.mergeMessages(row.gmail_id, 1)).length === 0;
  const labels = await ctx.gmail.labels();
  const label = labels.find((item) => item.id === row.gmail_id);
  if (label === undefined) {
    throw new MergeBlocked('label_changed');
  }
  for (const group of groups(job)) {
    checkGroupIdentity(labels, group);
  }
  const plannedIds = new Set(groups(job).flatMap((group) => group.sources.map((source) => source.gmailId)));
  const parents = new Set(JSON.parse(job.parents) as string[]);
  if (parents.has(row.gmail_id) && !groups(job).some((group) => group.sources.some((source) => source.name.startsWith(`${label.name}/`)))) {
    throw new MergeBlocked('label_changed');
  }
  if (parents.has(row.gmail_id) && (!empty || labels.some((other) => other.name.startsWith(`${label.name}/`) && !plannedIds.has(other.id) && !parents.has(other.id)))) {
    ctx.transact(() => ctx.store.run(`UPDATE label_merge_hides SET state = 'complete' WHERE job_id = ? AND gmail_id = ?`, job.id, row.gmail_id));
    return;
  }
  if (!empty) {
    throw new MergeBlocked('hidden_label_not_empty');
  }
  ctx.transact(() => ctx.store.run(`UPDATE label_merge_hides SET state = 'verified' WHERE job_id = ? AND gmail_id = ?`, job.id, row.gmail_id));
  if (!ctx.canWrite()) {
    return;
  }
  reserveWrite(ctx);
  await ctx.gmail.hideMergeLabel(row.gmail_id);
  const actual = (await ctx.gmail.labels()).find((item) => item.id === row.gmail_id);
  if (actual?.labelListVisibility !== 'labelHide' || actual.messageListVisibility !== 'hide') {
    throw new MergeBlocked('hide_unverified');
  }
  ctx.transact(() => ctx.store.run(`UPDATE label_merge_hides SET state = 'complete' WHERE job_id = ? AND gmail_id = ?`, job.id, row.gmail_id));
}

function finish(ctx: MergeContext, job: Job): void {
  ctx.transact(() => {
    for (const group of groups(job)) {
      for (const source of group.sources.slice(1)) {
        ctx.store.run(`INSERT INTO label_aliases (source_id, target_id) VALUES (?, ?)`, source.id, group.targetLabelId);
        ctx.store.run(`UPDATE label_aliases SET target_id = ? WHERE target_id = ?`, group.targetLabelId, source.id);
        ctx.store.run(`UPDATE examples SET label_id = ? WHERE label_id = ?`, group.targetLabelId, source.id);
        ctx.store.run(`INSERT INTO trusted_domains (label_id, domain, origin, subdomains, create_time)
    SELECT ?, domain, origin, subdomains, create_time FROM trusted_domains WHERE label_id = ?
    ON CONFLICT (label_id, domain) DO UPDATE SET
     origin = CASE WHEN trusted_domains.origin = 'seed' OR excluded.origin = 'seed' THEN 'seed' ELSE 'owner' END,
     subdomains = max(trusted_domains.subdomains, excluded.subdomains), create_time = min(trusted_domains.create_time, excluded.create_time)`, group.targetLabelId, source.id);
        ctx.store.run(`DELETE FROM trusted_domains WHERE label_id = ?`, source.id);
        ctx.store.run(`UPDATE labels SET enabled = 0 WHERE id = ?`, source.id);
        ctx.store.touchLabel(source.id, ctx.now());
      }
    }
    for (const group of groups(job)) {
      const excess = ctx.store.count(`SELECT count(*) AS n FROM examples WHERE label_id = ?`, group.targetLabelId) - EXAMPLES_PER_LABEL_MAX;
      if (excess > 0) {
        ctx.store.run(`DELETE FROM examples WHERE id IN (SELECT id FROM examples WHERE label_id = ? ORDER BY origin = 'weak_accept' DESC, id LIMIT ?)`, group.targetLabelId, excess);
      }
    }
    // invalidate embedded-example cache; vectors and their original timestamps stay unchanged.
    ctx.store.setMeta('examples_version', timeId(ctx.now()));
    const now = ctx.now();
    ctx.store.run(`UPDATE label_merge_jobs SET state = 'succeeded', phase = 'complete', update_time = ?, etag = ? WHERE id = ?`, now, newEtag(now), job.id);
  });
}

/** One daily counter, shared with the existing automatic write cap. */
export function mergeWritesToday(store: Store, day: string): number {
  const value = JSON.parse(store.getMeta('merge_writes') ?? '{}') as {
    day?: string;
    count?: number;
  };
  return value.day === day ? value.count ?? 0 : 0;
}

/** Count a possible write before the request; a lost response cannot escape the existing daily cap. */
function reserveWrite(ctx: MergeContext): void {
  if (!ctx.canWrite()) {
    throw new MergeBlocked('writes_paused');
  }
  const day = new Date(ctx.now()).toISOString().slice(0, 10);
  const used = mergeWritesToday(ctx.store, day);
  if (used + ctx.store.usage(day).applied >= readSettings(ctx.store).dailyWriteLimit) {
    throw new MergeBlocked('daily_write_limit');
  }
  ctx.transact(() => {
    ctx.store.setMeta('merge_writes', JSON.stringify({ day, count: used + 1 }));
  });
}

/** At most eight bounded units and 40 external calls per alarm. Errors hold the same job for explicit resume. */
export async function labelMergeStep(ctx: MergeContext): Promise<void> {
  for (let step = 0; step < Math.min(8, readSettings(ctx.store).runWriteLimit) && ctx.budget.has(5) && ctx.canWrite(); step++) {
    const job = latest(ctx.store);
    if (job === undefined || job.state !== 'running') {
      return;
    }
    try {
      const group = groups(job)[job.group_index];
      if (job.phase === 'preflight') {
        await preflight(ctx, job);
      }
      else if (job.phase === 'hide') {
        await hide(ctx, job);
      }
      else if (group === undefined) {
        throw new MergeBlocked('plan_invalid');
      }
      else if (job.phase === 'rename') {
        await rename(ctx, job, group);
      }
      else if (job.phase === 'move') {
        await move(ctx, job, group);
      }
      else if (job.phase === 'verify') {
        await verify(ctx, job, group);
      }
      else {
        return;
      }
      ctx.transact(() => ctx.store.run(`UPDATE label_merge_jobs SET update_time = ?, etag = ? WHERE id = ?`, ctx.now(), newEtag(ctx.now()), job.id));
    }
    catch (error) {
      const code = error instanceof MergeBlocked || error instanceof GoogleError ? error.code : 'consolidation_failed';
      ctx.transact(() => ctx.store.run(`UPDATE label_merge_jobs SET state = 'blocked', error_code = ?, update_time = ?, etag = ? WHERE id = ?`, code, ctx.now(), newEtag(ctx.now()), job.id));
      return;
    }
  }
}
