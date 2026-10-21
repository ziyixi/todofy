/**
 * Mail in Tasks (proto/tasks/ui/v1/mail.proto): the owner's mail category shortcuts and turning a mail into a task.
 * The mail is Todofy's, read and marked on its private Mail entry (todofy.mail.v1 MailService) through the `MAIL`
 * binding; Todofy keeps the summaries and the mail inbox, and makes no task.
 *
 * A conversion reads the mail, makes the task in Tasks' own D1 and then marks the mail converted. The task's ID is
 * derived from the mail (the ID Todofy derived before Tasks converted mail itself), so a retry with any request_id,
 * after any failure between the two writes, finishes the same conversion without a second task. A mail an older
 * Todofy linked to a task moves that task to the Inbox instead, while it is open.
 */
import { createHttpClient, RpcStatusError } from '@ziyixi/proto/http-client';
import { create } from '@ziyixi/proto/protobuf';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { MailCategoriesSchema, type MailCategories } from '@ziyixi/proto/tasks/ui/v1/mail_pb';
import { TaskSchema, type Task } from '@ziyixi/proto/tasks/ui/v1/task_pb';
import {
  CreateTaskRequestSchema,
  UpdateTaskRequestSchema,
  type ConvertMailItemRequest,
  type GetMailCategoriesRequest,
  type UpdateMailCategoriesRequest,
} from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { MailService, type MailItem } from '@ziyixi/proto/todofy/mail/v1/mail_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { localDate } from '@ziyixi/task-dates';
import type { Env } from './env.ts';
import { conflict, invalid, missing, precondition, storage } from './errors.ts';
import { checkedId, taskMessage, type TaskRow } from './model.ts';
import { commit, fingerprint, replay } from './receipts.ts';
import { getTask } from './task-read.ts';
import { createTask, updateTask } from './task-write.ts';

/** At most this many categories, each a label and a priority (1 is P1). */
export const MAX_MAIL_CATEGORIES = 4;
const MAIL_ID = /^[A-Za-z0-9_-]{1,100}$/;
/** In UTF-16 code units, as Tasks validates them. */
const MAX_TITLE = 500;
const MAX_DESCRIPTION = 16000;
const NO_SUBJECT = '(No subject)';
/** The footer Todofy wrote on every mail task, which the owner's searches find. */
const FOOTER_PREFIX = 'Mail Hero event: ';
const CUT_NOTICE = '\n\n（任务描述已截断；完整摘要保留在 Mail 中。）';

interface StoredCategory {
  id: number;
  label_id: string;
  priority: number;
}
interface Settings {
  categories: StoredCategory[];
  next_category_id: number;
  revision: number;
}

// ---- Todofy's Mail entry ---------------------------------------------------------------------------------------

/** MailService over the `MAIL` binding. Todofy's answers are untrusted text; they are read leniently. */
export function mailClient(env: Env) {
  const binding = env.MAIL;
  return createHttpClient(MailService, (call) => {
    if (!binding) throw new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', 'Mail is not connected');
    return binding.fetch(
      new Request(`https://mail.internal${call.url}`, {
        method: call.httpMethod,
        ...(call.body === undefined ? {} : { body: call.body, headers: { 'content-type': 'application/json' } }),
        redirect: 'manual',
      }),
    );
  });
}
/** A MailService call; Todofy's refusals become Tasks' own, and anything else is UNAVAILABLE. */
async function mail<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const reason = error instanceof RpcStatusError ? error.status.reason : undefined;
    if (reason === 'NOT_FOUND') missing();
    if (reason === 'ETAG_MISMATCH') conflict();
    if (reason === 'NOT_PENDING') precondition('This mail no longer awaits a decision; refresh Mail');
    throw new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', 'Mail is temporarily unavailable; try again');
  }
}

// ---- IDs and task text -----------------------------------------------------------------------------------------

/** RFC 4122 name-based UUID (version 5) in the URL namespace: Python's uuid.uuid5(uuid.NAMESPACE_URL, name). */
export async function uuid5(name: string): Promise<string> {
  const namespace = '6ba7b8119dad11d180b400c04fd430c8';
  const input = new Uint8Array(16 + new TextEncoder().encode(name).length);
  for (let i = 0; i < 16; i++) input[i] = parseInt(namespace.slice(2 * i, 2 * i + 2), 16);
  input.set(new TextEncoder().encode(name), 16);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', input)).slice(0, 16);
  // The version (5) and the RFC 4122 variant.
  const hex = Array.from(bytes, (byte, index) =>
    (index === 6 ? (byte & 0x0f) | 0x50 : index === 8 ? (byte & 0x3f) | 0x80 : byte).toString(16).padStart(2, '0'),
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** The task a mail becomes, and its create's request ID: frozen, Todofy derived both before Tasks converted mail. */
export function mailTaskIds(eventId: string): Promise<[taskId: string, requestId: string]> {
  return Promise.all([uuid5(`todofy-plus:mail-task:${eventId}:0`), uuid5(`todofy-plus:mail-create:${eventId}:0`)]);
}
/** At most `units` UTF-16 code units, without half of a surrogate pair. */
function cut(text: string, units: number): string {
  if (text.length <= units) return text;
  const code = text.charCodeAt(units - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? units - 1 : units);
}
/** The task's title and description: the subject, the summary (cut to fit, saying so), a link back and the footer. */
export function mailTaskText(item: MailItem, origin: string): { title: string; description: string } {
  const footer = `\n\n[查看完整邮件摘要](${origin}/?mail=${item.id}#/mail)\n\n${FOOTER_PREFIX}${item.id}`;
  const available = MAX_DESCRIPTION - footer.length;
  const notice = cut(item.summary, available) === item.summary ? '' : CUT_NOTICE;
  return {
    title: cut(item.title.trim() ? item.title : NO_SUBJECT, MAX_TITLE),
    description: cut(item.summary, available - notice.length) + notice + footer,
  };
}

// ---- categories ------------------------------------------------------------------------------------------------

async function readSettings(db: D1Database): Promise<Settings> {
  const row = await storage(() =>
    db
      .prepare("SELECT categories,next_category_id,revision FROM mail_settings WHERE id='mail'")
      .first<{ categories: string; next_category_id: number; revision: number }>(),
  );
  if (!row) throw new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', 'Task storage is temporarily unavailable');
  return { ...row, categories: JSON.parse(row.categories) as StoredCategory[] };
}
function categoriesMessage(settings: Pick<Settings, 'categories' | 'revision'>): MailCategories {
  return create(MailCategoriesSchema, {
    name: 'mailCategories',
    categories: settings.categories.map((category) => ({
      id: String(category.id),
      labelId: category.label_id,
      priority: category.priority,
    })),
    etag: String(settings.revision),
  });
}
export async function getMailCategories(db: D1Database, input: GetMailCategoriesRequest): Promise<MailCategories> {
  if (input.name !== 'mailCategories') invalid();
  return categoriesMessage(await readSettings(db));
}
/** Every label is live: one read of the labels the categories name. */
async function labelsLive(db: D1Database, labelIds: readonly string[]): Promise<boolean> {
  const ids = [...new Set(labelIds)];
  if (!ids.length) return true;
  const live = await storage(() =>
    db
      .prepare('SELECT count(*) AS n FROM labels WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(ids))
      .first<{ n: number }>(),
  );
  return live?.n === ids.length;
}
/**
 * Replaces the categories by etag; the saved set sent again answers it. A requested label and priority a saved
 * category has keeps that one's ID; each other one takes the next ID, never reused.
 */
export async function updateMailCategories(
  db: D1Database,
  input: UpdateMailCategoriesRequest,
  now: number,
): Promise<MailCategories> {
  const resource = input.mailCategories;
  if (!resource || resource.name !== 'mailCategories') invalid();
  const paths = input.updateMask?.paths ?? [];
  if (paths.some((path) => path !== 'categories' && path !== '*')) invalid('Only the categories can change');
  const requested = resource.categories.map((category) => ({
    label_id: checkedId(category.labelId),
    priority: category.priority,
  }));
  const pairs = new Set(requested.map((category) => `${category.label_id} ${String(category.priority)}`));
  if (
    requested.length > MAX_MAIL_CATEGORIES ||
    pairs.size !== requested.length ||
    requested.some((category) => !Number.isInteger(category.priority) || category.priority < 1 || category.priority > 4)
  )
    invalid('Choose at most four different label and priority pairs');
  const saved = await readSettings(db);
  const same = (a: { label_id: string; priority: number }, b: { label_id: string; priority: number }) =>
    a.label_id === b.label_id && a.priority === b.priority;
  if (
    saved.categories.length === requested.length &&
    requested.every((category, index) => {
      const kept = saved.categories[index];
      return kept !== undefined && same(kept, category);
    })
  )
    return categoriesMessage(saved);
  if (!input.etag) invalid('An etag is required');
  if (input.etag !== String(saved.revision)) conflict();
  if (!(await labelsLive(db, requested.map((category) => category.label_id))))
    precondition('A category label no longer exists');
  let next = saved.next_category_id;
  const categories = requested.map((category) => ({
    id: saved.categories.find((kept) => same(kept, category))?.id ?? next++,
    ...category,
  }));
  const written = await storage(() =>
    db
      .prepare(
        `UPDATE mail_settings SET categories=?,next_category_id=?,revision=revision+1,
        created_at=CASE WHEN created_at=0 THEN ? ELSE created_at END,updated_at=? WHERE id='mail' AND revision=?`,
      )
      .bind(JSON.stringify(categories), next, now, now, saved.revision)
      .run(),
  );
  if (written.meta.changes !== 1) conflict();
  return categoriesMessage({ categories, revision: saved.revision + 1 });
}
/** The label and priority of the category a conversion takes, checked against the categories' etag. */
async function chosenCategory(db: D1Database, input: ConvertMailItemRequest): Promise<StoredCategory | undefined> {
  if (!input.categoryId) return undefined;
  const settings = await readSettings(db);
  if (input.categoriesEtag !== String(settings.revision)) conflict();
  const category = settings.categories.find((saved) => String(saved.id) === input.categoryId);
  if (!category) invalid('Unknown mail category');
  if (!(await labelsLive(db, [category.label_id]))) precondition('A category label no longer exists');
  return category;
}

// ---- conversion ------------------------------------------------------------------------------------------------

async function liveTask(db: D1Database, id: string): Promise<boolean> {
  const row = await storage(() => db.prepare('SELECT 1 FROM tasks WHERE id=? AND deleted_at IS NULL').bind(id).first());
  return row !== null;
}
/** The open root task an older Todofy linked to the mail; undefined once it was deleted or completed. */
async function openLinkedTask(db: D1Database, taskId: string): Promise<TaskRow | undefined> {
  let task: TaskRow;
  try {
    task = await getTask(db, taskId);
  } catch (error) {
    if (error instanceof RpcError && error.code === Code.NOT_FOUND) return undefined;
    throw error;
  }
  if (task.completed) return undefined;
  if (task.parent_id) precondition("This mail's task is a subtask now; move it out first");
  return task;
}
/** The linked task moves to the Inbox and takes the category; a retry moves it again, which changes nothing. */
function moveLinkedTask(db: D1Database, task: TaskRow, category: StoredCategory | undefined, now: number, zone: string) {
  const labels = JSON.parse(task.label_ids) as string[];
  return updateTask(
    db,
    create(UpdateTaskRequestSchema, {
      requestId: crypto.randomUUID(),
      etag: String(task.revision),
      task: {
        name: `tasks/${task.id}`,
        projectId: '',
        sectionId: '',
        ...(category ? { labelIds: [...new Set([...labels, category.label_id])], priority: category.priority } : {}),
      },
      updateMask: { paths: ['project_id', 'section_id', ...(category ? ['label_ids', 'priority'] : [])] },
    }),
    now,
    zone,
  );
}
/** The task the mail becomes, in the Inbox; one a retry already made stands. */
async function mailTask(
  env: Env,
  item: MailItem,
  category: StoredCategory | undefined,
  now: number,
  zone: string,
): Promise<Task> {
  const [taskId, requestId] = await mailTaskIds(item.id);
  const made = await storage(() =>
    env.DB.prepare('SELECT deleted_at FROM tasks WHERE id=?').bind(taskId).first<{ deleted_at: number | null }>(),
  );
  if (made && made.deleted_at !== null) precondition('The task made from this mail was deleted; delete the mail');
  if (made) return taskMessage(await getTask(env.DB, taskId), localDate(now, zone));
  const text = mailTaskText(item, `https://${env.PUBLIC_HOST}`);
  return createTask(
    env.DB,
    create(CreateTaskRequestSchema, {
      requestId,
      taskId,
      task: { ...text, ...(category ? { labelIds: [category.label_id], priority: category.priority } : {}) },
    }),
    now,
    zone,
  );
}
/** Marks the mail converted to `task`; Todofy answers a repeat for the same task as done. */
function markConverted(env: Env, input: ConvertMailItemRequest, task: Task) {
  return mail(() =>
    mailClient(env).markMailConverted({
      name: `mailItems/${input.eventId}`,
      etag: input.etag,
      taskId: task.id,
      categoryId: input.categoryId,
    }),
  );
}
/**
 * ConvertMailItem: the owner's request_id answers its first answer again, after making sure the mail is marked. A
 * mail that is no longer pending answers its task while Tasks has it, so a second tab's conversion sees the first's.
 */
export async function convertMailItem(env: Env, input: ConvertMailItemRequest, now: number, zone: string): Promise<Task> {
  if (!MAIL_ID.test(input.eventId) || input.eventId.startsWith('tmp-') || !input.etag) invalid();
  if (Boolean(input.categoryId) !== Boolean(input.categoriesEtag)) invalid('A category needs the categories etag');
  const hash = await fingerprint('convertMailItem', input);
  const previous = await replay(env.DB, input.requestId, hash);
  if (previous !== null) {
    const task = fromWire(TaskSchema, JSON.parse(previous)).message;
    await markConverted(env, input, task);
    return task;
  }
  const item = await mail(() => mailClient(env).getMailItem({ name: `mailItems/${input.eventId}` }));
  if (!item.pending) {
    if (!item.taskId || !(await liveTask(env.DB, item.taskId)))
      precondition('This mail no longer awaits a decision; refresh Mail');
    return taskMessage(await getTask(env.DB, item.taskId), localDate(now, zone));
  }
  if (item.etag !== input.etag) conflict();
  const category = await chosenCategory(env.DB, input);
  const linked = item.taskId ? await openLinkedTask(env.DB, item.taskId) : undefined;
  const task = linked
    ? await moveLinkedTask(env.DB, linked, category, now, zone)
    : await mailTask(env, item, category, now, zone);
  // The answer for this request_id, while the task exists; then the mail leaves Todofy's inbox.
  const response = JSON.stringify(toWire(TaskSchema, task));
  await commit(env.DB, { requestId: input.requestId, hash, table: 'tasks', id: task.id, revision: 'live', response, now }, []);
  await markConverted(env, input, task);
  return task;
}
