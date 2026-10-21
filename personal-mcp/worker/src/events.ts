import { MailReadyItemSchema } from '@ziyixi/proto/todofy/ui/v1/mail_ready_pb';
import { toWire } from '@ziyixi/proto/wire-json';
import { createReadinessClient, readHomeSnapshot, type ContentToolEnv } from './content.ts';
import { createTasksClient, type TaskToolEnv } from './tasks.ts';

export const SOURCE_NAMES = ['task.changed', 'task.must_start', 'mail.ready', 'service.attention'] as const;
export type SourceName = typeof SOURCE_NAMES[number];
export type SourceState =
  | { name: 'task.changed'; cursor: string }
  | { name: 'task.must_start'; ids: readonly string[]; revision: number }
  | { name: 'mail.ready'; cursor: string }
  | { name: 'service.attention'; seq: number };
export interface SourceEvent { id: string; name: SourceName; data: Record<string, unknown> }
export type SourceEnv = TaskToolEnv & Pick<ContentToolEnv, 'TODOFY_MAIL' | 'HOME'>;

/** The same 2,000-task completeness bound as Tasks' planning read. No partial scan becomes a baseline. */
async function mustStartIds(env: TaskToolEnv): Promise<string[]> {
  const tasks = createTasksClient(env);
  const ids = new Set<string>();
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const result = await tasks.listTasks({ view: 'all', pageSize: 100, pageToken });
    for (const task of result.tasks) if (task.mustStart) ids.add(task.id);
    pageToken = result.nextPageToken;
    if (!pageToken) return [...ids].sort();
  }
  throw new Error('MUST_START_TASK_LIST_INCOMPLETE');
}

/** Starting the first subscription observes current state without backfilling existing business events. */
export async function baselineSource(name: SourceName, env: SourceEnv, previous?: SourceState): Promise<SourceState> {
  if (previous && previous.name !== name) throw new Error('EVENT_SOURCE_STATE_MISMATCH');
  switch (name) {
    case 'task.changed': {
      const result = await createTasksClient(env).listChanges({ baseline: true });
      if (!result.nextPageToken) throw new Error('TASK_CHANGE_CURSOR_MISSING');
      return { name, cursor: result.nextPageToken };
    }
    case 'task.must_start':
      return { name, ids: await mustStartIds(env), revision: previous?.name === name ? previous.revision : 0 };
    case 'mail.ready': {
      const result = await createReadinessClient(env).pollMailReady({ baseline: true });
      if (!result.cursor) throw new Error('MAIL_READY_CURSOR_MISSING');
      return { name, cursor: result.cursor };
    }
    case 'service.attention': {
      const result = await readHomeSnapshot(env);
      return { name, seq: result.head_seq };
    }
  }
}

/** The caller persists this state with the frozen deliveries in one SQLite transaction. */
export async function pollSource(
  name: SourceName,
  state: SourceState,
  env: SourceEnv,
  readOwnChanges: () => ReadonlyMap<string, string>,
): Promise<{ state: SourceState; events: SourceEvent[] }> {
  if (state.name !== name) throw new Error('EVENT_SOURCE_STATE_MISMATCH');
  switch (state.name) {
    case 'task.changed': {
      const result = await createTasksClient(env).listChanges({ pageToken: state.cursor, pageSize: 100 });
      if (!result.nextPageToken) throw new Error('TASK_CHANGE_CURSOR_MISSING');
      const latest = new Map<string, { id: string; etag: string; deleted: boolean }>();
      for (const change of result.changes) {
        if (!change.name.startsWith('tasks/')) continue;
        const id = change.name.slice('tasks/'.length);
        latest.set(id, { id, etag: change.task?.etag ?? '', deleted: change.deleted });
      }
      const ownChanges = readOwnChanges();
      const changes = [...latest.values()].filter(change => change.deleted || ownChanges.get(change.id) !== change.etag);
      return { state: { name: state.name, cursor: result.nextPageToken },
        events: changes.length ? [{ id: `task_changed_${result.nextPageToken}`, name, data: { changes } }] : [] };
    }
    case 'task.must_start': {
      const ids = await mustStartIds(env);
      const previous = new Set(state.ids);
      const added = ids.filter(id => !previous.has(id));
      const revision = state.revision + (added.length ? 1 : 0);
      return { state: { name: state.name, ids, revision }, events: added.length
        ? [{ id: `must_start_${String(revision)}`, name, data: { task_ids: added } }] : [] };
    }
    case 'mail.ready': {
      const result = await createReadinessClient(env).pollMailReady({ cursor: state.cursor });
      if (!result.cursor) throw new Error('MAIL_READY_CURSOR_MISSING');
      const events = new Map<string, SourceEvent>();
      for (const item of result.mailItems) {
        const readyTime = toWire(MailReadyItemSchema, item)['ready_time'];
        if (!item.eventId || typeof readyTime !== 'string') throw new Error('MAIL_READY_ITEM_INVALID');
        const id = `mail_${item.eventId}`;
        events.set(id, { id, name, data: { event_id: item.eventId, ready_time: readyTime } });
      }
      return { state: { name: state.name, cursor: result.cursor }, events: [...events.values()] };
    }
    case 'service.attention': {
      const result = await readHomeSnapshot(env, state.seq);
      const events = result.attention
        .filter(({ occurrence_seq, item }) => occurrence_seq > state.seq && item.source !== 'personal-mcp'
          && item.target.entry !== 'personal-mcp' && item.target.script !== 'personal-mcp')
        .map(({ occurrence_seq, item }): SourceEvent => ({ id: `attention_${String(occurrence_seq)}`, name,
          data: { occurrence_seq, source: item.source, code: item.code } }));
      return { state: { name: state.name, seq: result.head_seq }, events };
    }
  }
}
