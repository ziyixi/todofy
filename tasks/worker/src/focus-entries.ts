/**
 * Focus time records (proto/tasks/ui/v1/focus.proto): time added by hand, a record's minutes changed, a record
 * deleted. Timer sessions write their own records (focus-timer.ts). A record is whole minutes, 1 to 1440, and is
 * never removed from D1: a delete keeps it as deleted.
 */
import { create } from '@ziyixi/proto/protobuf';
import { EmptySchema } from '@ziyixi/proto/protobuf/wkt';
import { FocusEntrySchema } from '@ziyixi/proto/tasks/ui/v1/focus_pb';
import type {
  CreateFocusEntryRequest,
  DeleteFocusEntryRequest,
  UpdateFocusEntryRequest,
} from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { localDate } from '@ziyixi/task-dates';
import { conflict, invalid, missing, storage } from './errors.ts';
import { DAY_ENTRIES, checkedArea, checkedDay, commitChecked, entryMessage, type EntryRow } from './focus.ts';
import { checkedId } from './model.ts';
import { commit, fingerprint, replay } from './receipts.ts';

const IMMUTABLE = { task_id: 'taskId', day: 'day', area: 'area' } as const;

function entryResult(text: string) {
  return fromWire(FocusEntrySchema, JSON.parse(text)).message;
}
function serialize(row: EntryRow): string {
  return JSON.stringify(toWire(FocusEntrySchema, entryMessage(row)));
}
function checkedSeconds(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86_400 || seconds % 60 !== 0)
    invalid('A record is 1 to 1440 whole minutes');
  return seconds;
}
function entryId(name: string): string {
  if (!name.startsWith('focusEntries/')) invalid();
  return checkedId(name.slice('focusEntries/'.length));
}
async function liveEntry(db: D1Database, id: string, etag: string): Promise<EntryRow> {
  if (!etag) invalid('An etag is required');
  const row = await storage(() =>
    db
      .prepare(
        'SELECT id,task_id,day,seconds,started_at,source,area,revision FROM focus_entries WHERE id=? AND deleted_at IS NULL',
      )
      .bind(id)
      .first<EntryRow>(),
  );
  if (!row) missing();
  if (String(row.revision) !== etag) conflict();
  return row;
}

/** Time added by hand on today or an earlier day, for a task that exists. */
export async function createFocusEntry(db: D1Database, input: CreateFocusEntryRequest, now: number, zone: string) {
  const hash = await fingerprint('createFocusEntry', input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return entryResult(previous);
  const entry = input.focusEntry;
  if (!entry) invalid();
  const day = checkedDay(entry.day, 'day');
  if (day > localDate(now, zone)) invalid('Time can be added to today or an earlier day');
  const row: EntryRow = {
    id: crypto.randomUUID(),
    task_id: checkedId(entry.taskId),
    day,
    seconds: checkedSeconds(entry.seconds),
    started_at: null,
    source: 'manual',
    area: checkedArea(entry.area),
    revision: 1,
  };
  return entryResult(
    await commitChecked(
      db,
      {
        requestId: input.requestId,
        hash,
        table: 'tasks',
        id: row.task_id,
        revision: 'live',
        response: serialize(row),
        now,
      },
      [
        db
          .prepare(
            `INSERT INTO focus_entries(id,task_id,day,seconds,source,area,created_at,updated_at)
            VALUES(?,?,?,?,'manual',?,?,?)`,
          )
          .bind(row.id, row.task_id, day, row.seconds, row.area, now, now),
      ],
      [
        {
          // A running or paused session holds a place on its day, so its record always fits.
          sql: `(SELECT count(*) FROM focus_entries WHERE day=? AND deleted_at IS NULL)
            +(SELECT count(*) FROM focus_timer WHERE id='timer' AND state<>'idle' AND day=?)<${String(DAY_ENTRIES)}`,
          values: [day, day],
          message: `This day already has ${String(DAY_ENTRIES)} time records.`,
        },
      ],
    ),
  );
}

/** Only `seconds` changes; the immutable fields may be named only with their stored values. */
export async function updateFocusEntry(db: D1Database, input: UpdateFocusEntryRequest, now: number) {
  const hash = await fingerprint('updateFocusEntry', input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return entryResult(previous);
  const entry = input.focusEntry;
  if (!entry) invalid();
  const old = await liveEntry(db, entryId(entry.name), input.etag);
  const paths = [...new Set(input.updateMask?.paths ?? [])];
  if (!paths.length || paths.includes('*')) invalid('An explicit update_mask is required');
  for (const path of paths) {
    if (path === 'seconds') continue;
    if (!Object.hasOwn(IMMUTABLE, path)) invalid('Unsupported update field');
    const field = IMMUTABLE[path as keyof typeof IMMUTABLE];
    if (entry[field] !== old[path as keyof typeof IMMUTABLE]) invalid('Only seconds can change');
  }
  const row = {
    ...old,
    seconds: paths.includes('seconds') ? checkedSeconds(entry.seconds) : old.seconds,
    revision: old.revision + 1,
  };
  return entryResult(
    await commit(
      db,
      {
        requestId: input.requestId,
        hash,
        table: 'focus_entries',
        id: old.id,
        revision: old.revision,
        response: serialize(row),
        now,
      },
      [
        db
          .prepare('UPDATE focus_entries SET seconds=?,revision=revision+1,updated_at=? WHERE id=?')
          .bind(row.seconds, now, old.id),
      ],
    ),
  );
}

export async function deleteFocusEntry(db: D1Database, input: DeleteFocusEntryRequest, now: number) {
  const hash = await fingerprint('deleteFocusEntry', input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return create(EmptySchema);
  const old = await liveEntry(db, entryId(input.name), input.etag);
  await commit(
    db,
    {
      requestId: input.requestId,
      hash,
      table: 'focus_entries',
      id: old.id,
      revision: old.revision,
      response: '{}',
      now,
    },
    [
      db
        .prepare('UPDATE focus_entries SET deleted_at=?,revision=revision+1,updated_at=? WHERE id=?')
        .bind(now, now, old.id),
    ],
  );
  return create(EmptySchema);
}
