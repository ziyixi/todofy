/** Mail in Tasks (src/mail.ts, src/mail-proxy.ts) on real D1, against a synthetic Todofy Mail entry. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { mailTaskIds } from '../../src/mail.ts';
import { fakeMail, type FakeMail } from './fake-mail.ts';
import { startHarness, type Harness } from './harness.ts';

let harness: Harness;
let todofy: FakeMail;
let label: { id: string };
beforeAll(async () => {
  todofy = fakeMail();
  harness = await startHarness({ mail: (request) => todofy.handle(request) });
  label = await post('labels', { title: 'Synthetic mail label' });
});
afterAll(async () => {
  await harness.dispose();
});

interface Answer {
  id: string;
  name: string;
  etag: string;
  title: string;
  description: string;
  project_id: string;
  label_ids?: string[];
  priority: number;
}
async function post<T = Answer>(kind: string, body: unknown): Promise<T> {
  const response = await harness.mutate('POST', `/api/tasks/v1/${kind}?request_id=${randomUUID()}`, body);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<T>;
}
async function categories(): Promise<{ categories?: { id: string; label_id: string; priority: number }[]; etag: string }> {
  return (await harness.fetch('/api/tasks/v1/mailCategories')).json();
}
function saveCategories(etag: string, items: { label_id: string; priority: number }[]) {
  return harness.mutate('PATCH', `/api/tasks/v1/mailCategories?update_mask=categories&etag=${etag}`, {
    categories: items,
  });
}
function convert(body: Record<string, unknown>) {
  return harness.mutate('POST', '/api/tasks/v1/mailItems:convert', body);
}
function mailOf(id: string) {
  const found = todofy.mail.find((mail) => mail.id === id);
  if (!found) throw new Error(`no synthetic mail ${id}`);
  return found;
}
/** The first saved category's ID. */
function firstCategory(set: { categories?: { id: string }[] }): string {
  const [first] = set.categories ?? [];
  if (!first) throw new Error('no saved category');
  return first.id;
}
const etagOf = async (id: string) =>
  ((await (await harness.fetch(`/api/mail/v1/mailItems/${id}`)).json()) as { etag: string }).etag;

test('the categories start empty, save by etag with stable IDs, and the saved set again answers it', async () => {
  const empty = await categories();
  expect(empty).toEqual({ name: 'mailCategories', etag: '1' });
  const other = await post('labels', { title: 'Synthetic other label' });
  const first = await saveCategories('1', [
    { label_id: label.id, priority: 1 },
    { label_id: other.id, priority: 4 },
  ]);
  expect(first.status, await first.clone().text()).toBe(200);
  expect(await first.json()).toMatchObject({
    etag: '2',
    categories: [
      { id: '1', label_id: label.id, priority: 1 },
      { id: '2', label_id: other.id, priority: 4 },
    ],
  });
  // The saved set again, even with a stale etag, answers as saved.
  const again = await saveCategories('1', [
    { label_id: label.id, priority: 1 },
    { label_id: other.id, priority: 4 },
  ]);
  expect((await again.json()) as unknown).toMatchObject({ etag: '2' });
  expect((await saveCategories('1', [{ label_id: label.id, priority: 2 }])).status).toBe(409);
  // A kept pair keeps its ID, a new one takes the next, and a removed ID is never reused.
  const reordered = await saveCategories('2', [
    { label_id: other.id, priority: 4 },
    { label_id: label.id, priority: 3 },
  ]);
  expect(await reordered.json()).toMatchObject({
    etag: '3',
    categories: [
      { id: '2', label_id: other.id, priority: 4 },
      { id: '3', label_id: label.id, priority: 3 },
    ],
  });
  const five = [1, 2, 3, 4].map((priority) => ({ label_id: label.id, priority })).concat({ label_id: other.id, priority: 1 });
  expect((await saveCategories('3', five)).status).toBe(400);
  expect((await saveCategories('3', [{ label_id: label.id, priority: 5 }])).status).toBe(400);
  expect((await saveCategories('3', [{ label_id: 'no-such-label', priority: 1 }])).status).toBe(400);
  const stored = await harness.db
    .prepare("SELECT next_category_id,created_at>0 AS saved FROM mail_settings WHERE id='mail'")
    .first();
  expect(stored).toEqual({ next_category_id: 4, saved: 1 });
});

test('a conversion makes the derived task in the Inbox with the category, then marks the mail', async () => {
  const saved = await saveCategories((await categories()).etag, [{ label_id: label.id, priority: 2 }]);
  const set = (await saved.json()) as { etag: string; categories: { id: string }[] };
  todofy.mail.push({ id: 'evt-convert', title: 'Synthetic invoice', summary: 'Pay the synthetic invoice.' });
  const body = {
    event_id: 'evt-convert',
    etag: await etagOf('evt-convert'),
    request_id: randomUUID(),
    category_id: firstCategory(set),
    categories_etag: set.etag,
  };
  const response = await convert(body);
  expect(response.status, await response.clone().text()).toBe(200);
  const task = (await response.json()) as Answer;
  const [taskId] = await mailTaskIds('evt-convert');
  // The wire form leaves the empty project (the Inbox) out.
  expect(task).toMatchObject({ id: taskId, title: 'Synthetic invoice', priority: 2 });
  expect(task.project_id).toBeUndefined();
  expect(task.label_ids).toEqual([label.id]);
  expect(task.description).toBe(
    'Pay the synthetic invoice.\n\n[查看完整邮件摘要](https://tasks.example.test/?mail=evt-convert#/mail)' +
      '\n\nMail Hero event: evt-convert',
  );
  // Todofy learns only the task; the category stays in Tasks, on the task.
  expect(mailOf('evt-convert')).toMatchObject({ pending: false, taskId });
  // The same request again answers the same task; Todofy answers the repeated mark as done.
  const replay = await convert(body);
  expect(replay.status).toBe(200);
  expect(((await replay.json()) as Answer).id).toBe(taskId);
  // Another tab's conversion of the converted mail answers its task too.
  const other = await convert({ ...body, request_id: randomUUID() });
  expect(other.status).toBe(200);
  expect(((await other.json()) as Answer).id).toBe(taskId);
  const count = await harness.db.prepare('SELECT count(*) AS n FROM tasks WHERE id=?').bind(taskId).first();
  expect(count).toEqual({ n: 1 });
  // A request_id used for other input is refused.
  expect((await convert({ ...body, category_id: '', categories_etag: '' })).status).toBe(400);
});

test('a retry after a lost answer, with the same or another request_id, finishes without a second task', async () => {
  todofy.mail.push({ id: 'evt-retry', title: 'Synthetic retry', summary: 'Retry me.' });
  const etag = await etagOf('evt-retry');
  const [taskId] = await mailTaskIds('evt-retry');
  todofy.failures.set('MarkMailConverted', 2);
  const body = { event_id: 'evt-retry', etag, request_id: randomUUID() };
  const lost = await convert(body);
  expect(lost.status).toBe(503);
  expect(mailOf('evt-retry').pending).not.toBe(false);
  // The same request answers its receipt and marks the mail; Todofy is still out once.
  expect((await convert(body)).status).toBe(503);
  const retried = await convert(body);
  expect(retried.status, await retried.clone().text()).toBe(200);
  expect(((await retried.json()) as Answer).id).toBe(taskId);
  expect(mailOf('evt-retry')).toMatchObject({ pending: false, taskId });

  // A conversion Todofy began before the release (the task exists, the mail is pending) is finished too.
  todofy.mail.push({ id: 'evt-begun', title: 'Synthetic begun' });
  const [begun] = await mailTaskIds('evt-begun');
  await harness.db
    .prepare("INSERT INTO tasks(id,title,created_at,updated_at) VALUES(?,'Made by Todofy',1,1)")
    .bind(begun)
    .run();
  const finished = await convert({ event_id: 'evt-begun', etag: await etagOf('evt-begun'), request_id: randomUUID() });
  expect(finished.status).toBe(200);
  expect(await finished.json()).toMatchObject({ id: begun, title: 'Made by Todofy' });
  expect(mailOf('evt-begun')).toMatchObject({ pending: false, taskId: begun });
  const count = await harness.db
    .prepare('SELECT count(*) AS n FROM tasks WHERE id IN (?,?)')
    .bind(taskId, begun)
    .first();
  expect(count).toEqual({ n: 2 });
});

test('a mail an older Todofy linked to an open task moves that task to the Inbox', async () => {
  const project = await post('projects', { title: 'Synthetic mail project' });
  const linked = await post('tasks', { title: 'Linked synthetic', project_id: project.id, label_ids: [] });
  todofy.mail.push({ id: 'evt-linked', title: 'Synthetic linked', taskId: linked.id });
  const set = await categories();
  const response = await convert({
    event_id: 'evt-linked',
    etag: await etagOf('evt-linked'),
    request_id: randomUUID(),
    category_id: firstCategory(set),
    categories_etag: set.etag,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const moved = (await response.json()) as Answer;
  expect(moved).toMatchObject({ id: linked.id, label_ids: [label.id], priority: 2 });
  expect(moved.project_id).toBeUndefined();
  expect(mailOf('evt-linked')).toMatchObject({ pending: false, taskId: linked.id });

  // A linked task the owner completed is not moved back: the mail becomes a new task.
  const done = await post('tasks', { title: 'Done synthetic' });
  const completed = await harness.mutate('POST', `/api/tasks/v1/${done.name}:complete`, {
    etag: done.etag,
    request_id: randomUUID(),
  });
  expect(completed.status).toBe(200);
  todofy.mail.push({ id: 'evt-done-link', title: 'Synthetic done link', taskId: done.id });
  const fresh = await convert({ event_id: 'evt-done-link', etag: await etagOf('evt-done-link'), request_id: randomUUID() });
  expect(((await fresh.json()) as Answer).id).toBe((await mailTaskIds('evt-done-link'))[0]);
});

test('a changed or decided mail, or a changed category set, makes nothing', async () => {
  todofy.mail.push({ id: 'evt-stale', title: 'Synthetic stale' });
  const stale = await convert({ event_id: 'evt-stale', etag: 'old', request_id: randomUUID() });
  expect(stale.status).toBe(409);
  const set = await categories();
  const wrongSet = await convert({
    event_id: 'evt-stale',
    etag: await etagOf('evt-stale'),
    request_id: randomUUID(),
    category_id: firstCategory(set),
    categories_etag: '1',
  });
  expect(wrongSet.status).toBe(409);
  todofy.mail.push({ id: 'evt-decided', title: 'Synthetic decided', pending: false });
  const decided = await convert({ event_id: 'evt-decided', etag: 'x', request_id: randomUUID() });
  expect(decided.status).toBe(400);
  expect((await convert({ event_id: 'evt-missing', etag: 'x', request_id: randomUUID() })).status).toBe(404);
  const [stray] = await mailTaskIds('evt-stale');
  expect(await harness.db.prepare('SELECT count(*) AS n FROM tasks WHERE id=?').bind(stray).first()).toEqual({ n: 0 });
  expect(mailOf('evt-stale').pending).not.toBe(false);
});

test("the owner's Mail reads and deletes reach Todofy without credentials; nothing else does", async () => {
  todofy.mail.push({ id: 'evt-proxy', title: 'Synthetic proxied' });
  const calls = todofy.calls.length;
  const list = await harness.fetch('/api/mail/v1/mailItems?page_size=10');
  expect(list.status).toBe(200);
  expect(((await list.json()) as { mail_items: { id: string }[] }).mail_items.map((item) => item.id)).toContain('evt-proxy');
  const refused = await harness.fetch('/api/mail/v1/mailItems:deleteSummaries', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: harness.url.origin },
    body: JSON.stringify({ event_ids: ['evt-proxy'] }),
  });
  expect(refused.status).toBe(403);
  const deleted = await harness.mutate('POST', '/api/mail/v1/mailItems:deleteSummaries', { event_ids: ['evt-proxy'] });
  expect(await deleted.json()).toEqual({ deleted_event_ids: ['evt-proxy'] });
  // Marking is Tasks' own conversion's; the old Plus routes are gone.
  const mark = await harness.mutate('POST', '/api/mail/v1/mailItems/evt-proxy:markConverted', { etag: 'x', task_id: 'x' });
  expect(mark.status).toBe(404);
  const plus = await harness.fetch('/api/plus/v1/mailItems');
  expect(plus.status).toBe(404);
  expect(((await plus.json()) as { error: { message: string } }).error.message).toMatch(/Unknown API route/);
  expect(todofy.calls.slice(calls)).toEqual(['ListMailItems', 'DeleteMailSummaries']);
});
