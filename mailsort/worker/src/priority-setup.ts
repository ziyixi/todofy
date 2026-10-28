/** One explicit owner operation replaces topic labels; no mail is fetched or reclassified. */
import type { ApiContext } from './api.ts';
import { GoogleError, isUserLabelId } from './gmail.ts';
import { newEtag } from './ids.ts';
import { PRIORITY_LABELS, prioritySetup, priorityStartedAt, type PrioritySetup } from './priority.ts';
import { sortError } from './reasons.ts';
import { readSettings } from './settings.ts';
import { writeScope } from './session.ts';
import type { LabelRow, Store } from './store.ts';
import { ensureGmailLabel, executeWrites, type WriteContext } from './writes.ts';

function save(store: Store, setup: PrioritySetup): void {
  store.setMeta('priority_setup', JSON.stringify(setup));
}

function prepareLabels(ctx: ApiContext, setup: PrioritySetup): PrioritySetup {
  return ctx.transact(() => {
    const { store } = ctx;
    store.run(`INSERT OR REPLACE INTO retired_labels (id, retire_time) SELECT id, ? FROM labels`, ctx.now);
    store.run(`DELETE FROM labels`);
    store.run(`DELETE FROM label_aliases`);
    store.run(`DELETE FROM gmail_parents`);
    store.run(`DELETE FROM examples`);
    store.run(`DELETE FROM trusted_domains`);
    store.run(`DELETE FROM feedback`);
    store.run(`DELETE FROM review`);
    store.run(`DELETE FROM replay`);
    store.setMeta('examples_version', String(Number(store.getMeta('examples_version') ?? '0') + 1));
    for (const [index, label] of PRIORITY_LABELS.entries()) {
      store.run(
        `INSERT INTO labels (id, seq, display_name, description, enabled, trust, gmail_state, desc_version,
          create_time, update_time, etag, keep_in_inbox, sensitive)
         VALUES (?, ?, ?, ?, 1, 0, 'pending', 1, ?, ?, ?, ?, 0)`,
        label.id, index + 1, label.displayName, label.description, setup.startedAt, ctx.now,
        newEtag(ctx.now), label.keepInInbox ? 1 : 0,
      );
    }
    const prepared = { ...setup, labelsPrepared: true };
    save(store, prepared);
    return prepared;
  });
}

export async function initializePriorities(ctx: ApiContext): Promise<{ completed: boolean; removedLabelCount: number }> {
  const saved = prioritySetup(ctx.store);
  let setup: PrioritySetup;
  if (priorityStartedAt(ctx.store) > 0) return { completed: true, removedLabelCount: saved?.removedLabelCount ?? 0 };
  if (ctx.busy()) {
    throw sortError('CONSOLIDATION_PENDING_WRITES');
  }
  const client = await ctx.gmail();
  if (client === 'not_configured' || client === 'stopped') throw sortError('GMAIL_NOT_AUTHORIZED');
  const allowed = () => writeScope(ctx.store) && readSettings(ctx.store).mode !== 'off' && ctx.ceiling !== 'off';
  if (!allowed()) throw sortError('GMAIL_WRITE_NOT_ALLOWED');
  const write: WriteContext = {
    store: ctx.store, gmail: client, budget: ctx.budget, now: () => ctx.now, transact: ctx.transact,
    gate: () => allowed() ? null : 'mode_changed',
  };

  if (saved === null) {
    // Finish already requested undos before removing their labels. Old automatic intents are superseded below.
    const undos = ctx.store.all<{ id: string }>(`SELECT id FROM ledger WHERE state = 'undo_intended' ORDER BY id LIMIT 5`);
    if (undos.length > 0) await executeWrites(write, undos.map(row => row.id), undos.length);
    if (ctx.store.count(`SELECT count(*) AS n FROM ledger WHERE state = 'undo_intended'`) > 0) throw sortError('CONSOLIDATION_PENDING_WRITES');
    const current = await client.labels();
    const old = ctx.store.all<LabelRow>(`SELECT * FROM labels ORDER BY id`);
    // A priority name owned outside this app is not part of this operation.
    const owned = ctx.store.ownedGmailIds();
    if (current.some(label => PRIORITY_LABELS.some(priority => priority.displayName === label.name) && !owned.has(label.id))) {
      throw sortError('LABEL_EXISTS');
    }
    if (old.some(label => PRIORITY_LABELS.some(priority => priority.id === label.id))) throw sortError('LABEL_EXISTS');
    const parents = ctx.store.all<{ gmail_id: string }>(`SELECT gmail_id FROM gmail_parents`);
    const byId = new Map(current.map(label => [label.id, label]));
    const parentIds = parents.flatMap(parent => {
      const name = byId.get(parent.gmail_id)?.name;
      return name !== undefined && current.every(label => !label.name.startsWith(`${name}/`) || owned.has(label.id)) ? [parent.gmail_id] : [];
    });
    const remaining = [...new Set([...owned, ...parentIds])].filter(id => isUserLabelId(id) && byId.has(id));
    const cursor = ctx.store.getMeta('history_cursor') ?? await client.currentHistoryId();
    setup = ctx.transact(() => {
      if (ctx.busy() || ctx.store.count(`SELECT count(*) AS n FROM ledger WHERE state = 'undo_intended'`) > 0) {
        throw sortError('CONSOLIDATION_PENDING_WRITES');
      }
      if (!allowed()) throw sortError('GMAIL_WRITE_NOT_ALLOWED');
      if (JSON.stringify(old) !== JSON.stringify(ctx.store.all<LabelRow>(`SELECT * FROM labels ORDER BY id`))) throw sortError('ETAG_MISMATCH');
      const frozen: PrioritySetup = { remaining, removedLabelCount: 0, startedAt: ctx.now };
      save(ctx.store, frozen);
      // Keep an established cursor: advancing it here could skip mail arriving during the preflight.
      if (ctx.store.getMeta('history_cursor') === null) ctx.store.setMeta('history_cursor', cursor);
      ctx.store.run(`UPDATE labels SET enabled = 0`);
      ctx.store.run(`UPDATE ledger SET state = 'failed', last_code = 'priority_replaced' WHERE state = 'intended'`);
      return frozen;
    });
  } else setup = saved;

  // Each click uses at most the existing request budget. Retrying a removed ID is harmless (404).
  while (setup.remaining.length > 0 && ctx.budget.has(2)) {
    if (!allowed()) throw sortError('GMAIL_WRITE_NOT_ALLOWED');
    await client.deletePriorityLabel(setup.remaining[0] ?? '');
    const current: PrioritySetup = setup;
    setup = ctx.transact(() => {
      const next: PrioritySetup = { ...current, remaining: current.remaining.slice(1), removedLabelCount: current.removedLabelCount + 1 };
      save(ctx.store, next);
      return next;
    });
  }
  if (setup.remaining.length > 0) return { completed: false, removedLabelCount: setup.removedLabelCount };
  if (setup.labelsPrepared !== true) setup = prepareLabels(ctx, setup);

  for (const label of ctx.store.labels()) {
    if (label.gmail_state === 'linked') continue;
    if (!ctx.budget.has(3)) return { completed: false, removedLabelCount: setup.removedLabelCount };
    if (!allowed()) throw sortError('GMAIL_WRITE_NOT_ALLOWED');
    if (await ensureGmailLabel(write, label) === null) throw new GoogleError('bad_answer', 'priority_label_conflict');
  }
  if (!ctx.budget.has(1)) return { completed: false, removedLabelCount: setup.removedLabelCount };
  const actual = await client.labels();
  if (ctx.store.labels().some(label => !actual.some(remote => remote.id === label.gmail_id && remote.name === label.display_name))) {
    throw new GoogleError('bad_answer', 'priority_labels_unverified');
  }
  // Normal processing starts only after all four Gmail identities exist. Preserve arrivals during setup.
  ctx.transact(() => { ctx.store.setMeta('priority_started_at', String(setup.startedAt)); });
  await ctx.wake();
  return { completed: true, removedLabelCount: setup.removedLabelCount };
}
