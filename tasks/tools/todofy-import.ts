/**
 * The one-time copy of what Todofy kept for Tasks into Tasks (docs/backup.md "One-time Todofy import"), run by
 * .github/workflows/tasks-todofy-import.yml right after the release in which Tasks took over mail conversion, GTD and
 * the weekly review (migrations/0008_mail_gtd_inbox.sql). From that release on, nothing writes these Todofy tables;
 * the next release drops them. It copies:
 * - every GTD day (gtd_daily) and weekly review (gtd_reviews) Tasks lacks, with Todofy's values; times become
 *   milliseconds, and a review Todofy left 'sending' is 'unknown', as Todofy read it. A row Tasks wrote wins;
 * - the Mail categories (plan_categories of scheme 'mail' with their labels in plan_settings 'todoist.mail'), in
 *   their order with their IDs, for the labels live in Tasks, and the next ID. They are copied once: the statement
 *   needs mail_settings.created_at 0 and records when it ran, so a set saved in Tasks first is never replaced;
 * - the projects the daily reminder (mail_reminders) and the review last went to, as the routes of `home` and
 *   `review`, while the project is live in Tasks and the source has no route.
 * Every statement repeats its guard, so applying the SQL again changes nothing, and the next dry run counts nothing
 * pending.
 *
 * The inputs are `wrangler d1 execute --json` answers to the read-only EXPORTS. Only checked IDs, days, weeks, fixed
 * words and numbers are quoted into the SQL; the categories go in as hex-encoded JSON of IDs and numbers. Counts name
 * no task, label, project or mail.
 */
export class TodofyImportError extends Error {}

/** One read-only SELECT per answer, against the D1 of `app`; each answer is saved as `<name>.json`. */
export const EXPORTS = [
  {
    app: 'todofy',
    name: 'todofy.gtd_daily',
    sql:
      'SELECT day, scope, open, age_0_7, age_8_14, age_15_30, age_31_plus, oldest_days, overdue, undated, created_7d, ' +
      'completed_7d, closed_1d, mail_open, complete, computed_at FROM gtd_daily',
  },
  { app: 'todofy', name: 'todofy.gtd_reviews', sql: 'SELECT week, state, task_id, created_at, completed_at FROM gtd_reviews' },
  {
    app: 'todofy',
    name: 'todofy.mail_categories',
    sql: "SELECT id, priority, sort_order FROM plan_categories WHERE scheme='mail' AND archived_at IS NULL",
  },
  { app: 'todofy', name: 'todofy.mail_labels', sql: "SELECT value FROM plan_settings WHERE key='todoist.mail'" },
  { app: 'todofy', name: 'todofy.next_category', sql: 'SELECT coalesce(max(id),0)+1 AS id FROM plan_categories' },
  {
    app: 'todofy',
    name: 'todofy.routes',
    sql:
      "SELECT (SELECT project_id FROM mail_reminders WHERE state='created' AND project_id<>'' ORDER BY day DESC LIMIT 1) " +
      "AS home, (SELECT project_id FROM gtd_reviews WHERE state='created' AND project_id<>'' ORDER BY week DESC LIMIT 1) " +
      'AS review',
  },
  { app: 'tasks', name: 'tasks.gtd_days', sql: 'SELECT day, scope FROM gtd_days' },
  { app: 'tasks', name: 'tasks.weekly_reviews', sql: 'SELECT week FROM weekly_reviews' },
  { app: 'tasks', name: 'tasks.mail_settings', sql: "SELECT revision, created_at FROM mail_settings WHERE id='mail'" },
  { app: 'tasks', name: 'tasks.labels', sql: 'SELECT id FROM labels WHERE deleted_at IS NULL' },
  { app: 'tasks', name: 'tasks.projects', sql: 'SELECT id FROM projects WHERE deleted_at IS NULL AND archived = 0' },
  { app: 'tasks', name: 'tasks.routes', sql: 'SELECT source FROM task_inbox_routes' },
] as const;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DAY = /^\d{4}-\d\d-\d\d$/;
const WEEK = /^\d{4}-W\d\d$/;
const SCOPES = ['all', 'inbox'];
const REVIEW_STATES: Record<string, string> = { created: 'created', unknown: 'unknown', failed: 'failed', sending: 'unknown' };
/** gtd_days' count columns, in order; the four after `undated` may be NULL. */
const COUNTS = ['open', 'age_0_7', 'age_8_14', 'age_15_30', 'age_31_plus', 'oldest_days', 'overdue', 'undated'];
const OPTIONAL_COUNTS = ['created_7d', 'completed_7d', 'closed_1d', 'mail_open'];
const MAX_CATEGORIES = 4;

export interface Day {
  day: string;
  scope: string;
  counts: number[];
  optional: (number | null)[];
  complete: number;
  /** Milliseconds. */
  computedAt: number;
}
export interface Review {
  week: string;
  state: string;
  taskId: string;
  /** Milliseconds. */
  createdAt: number;
  completedAt: number | null;
}
export interface Category {
  id: number;
  label_id: string;
  priority: number;
}
export interface Count {
  all: number;
  pending: number;
  /** Tasks has it already: copied, or written in Tasks. */
  present: number;
  /** Its label or project is not live in Tasks. */
  skipped: number;
}
export interface TodofyImport {
  days: Day[];
  reviews: Review[];
  /** The categories to copy with the next ID; none when Tasks keeps its own set, where the SQL changes nothing. */
  categories: { items: Category[]; next: number };
  routes: { source: 'home' | 'review'; projectId: string }[];
  counts: { days: Count; reviews: Count; categories: Count; routes: Count; pending: number };
}

type Row = Record<string, unknown>;

/** The rows of a `wrangler d1 execute --json` answer: `[{results: [...]}, ...]`. */
function rows(answers: Record<string, unknown>, name: string): Row[] {
  const answer = answers[name];
  if (!Array.isArray(answer)) throw new TodofyImportError(`EXPORT_INVALID: ${name}`);
  return answer.flatMap((statement: unknown) => {
    const results = (statement as { results?: unknown } | null)?.results;
    if (!Array.isArray(results)) throw new TodofyImportError(`EXPORT_INVALID: ${name}`);
    return results.map((row: unknown) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TodofyImportError(`EXPORT_INVALID: ${name}`);
      return row as Row;
    });
  });
}
function check(ok: boolean, name: string): void {
  if (!ok) throw new TodofyImportError(`EXPORT_INVALID: ${name}`);
}
function count(value: unknown, name: string): number {
  check(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, name);
  return value as number;
}
function optional(value: unknown, name: string): number | null {
  return value === null ? null : count(value, name);
}
function matching(value: unknown, pattern: RegExp, name: string): string {
  check(typeof value === 'string' && pattern.test(value), name);
  return value as string;
}
const empty = (): Count => ({ all: 0, pending: 0, present: 0, skipped: 0 });

export function prepareTodofyImport(answers: Record<string, unknown>): TodofyImport {
  const days = new Set(
    rows(answers, 'tasks.gtd_days').map(
      (row) => `${matching(row.day, DAY, 'tasks.gtd_days')} ${matching(row.scope, /^(all|inbox)$/, 'tasks.gtd_days')}`,
    ),
  );
  const weeks = new Set(rows(answers, 'tasks.weekly_reviews').map((row) => matching(row.week, WEEK, 'tasks.weekly_reviews')));
  const labels = new Set(rows(answers, 'tasks.labels').map((row) => matching(row.id, ID, 'tasks.labels')));
  const projects = new Set(rows(answers, 'tasks.projects').map((row) => matching(row.id, ID, 'tasks.projects')));
  const routed = new Set(rows(answers, 'tasks.routes').map((row) => matching(row.source, /^(home|review)$/, 'tasks.routes')));
  const settings = rows(answers, 'tasks.mail_settings');
  check(settings.length === 1, 'tasks.mail_settings');
  count(settings[0]?.revision, 'tasks.mail_settings');
  // When Tasks first saved or copied its categories, 0 until then.
  const kept = count(settings[0]?.created_at, 'tasks.mail_settings') > 0;

  const plan: TodofyImport = {
    days: [],
    reviews: [],
    categories: { items: [], next: 1 },
    routes: [],
    counts: { days: empty(), reviews: empty(), categories: empty(), routes: empty(), pending: 0 },
  };
  const { counts } = plan;

  for (const row of rows(answers, 'todofy.gtd_daily')) {
    const name = 'todofy.gtd_daily';
    const day: Day = {
      day: matching(row.day, DAY, name),
      scope: matching(row.scope, /^(all|inbox)$/, name),
      counts: COUNTS.map((column) => count(row[column], name)),
      optional: OPTIONAL_COUNTS.map((column) => optional(row[column], name)),
      complete: count(row.complete, name),
      computedAt: count(row.computed_at, name) * 1000,
    };
    check(day.complete <= 1 && SCOPES.includes(day.scope), name);
    counts.days.all++;
    if (days.has(`${day.day} ${day.scope}`)) counts.days.present++;
    else plan.days.push(day);
  }

  for (const row of rows(answers, 'todofy.gtd_reviews')) {
    const name = 'todofy.gtd_reviews';
    const state = REVIEW_STATES[String(row.state)];
    check(state !== undefined, name);
    const taskId = row.task_id === '' ? '' : matching(row.task_id, ID, name);
    const review: Review = {
      week: matching(row.week, WEEK, name),
      state: state ?? '',
      taskId,
      createdAt: count(row.created_at, name) * 1000,
      completedAt: row.completed_at === null ? null : count(row.completed_at, name) * 1000,
    };
    counts.reviews.all++;
    if (weeks.has(review.week)) counts.reviews.present++;
    else plan.reviews.push(review);
  }

  // The categories' labels: {"categories": [{"id", "label_id", "label"}], ...}, read for the IDs only.
  const documents = rows(answers, 'todofy.mail_labels');
  check(documents.length <= 1, 'todofy.mail_labels');
  const bound = new Map<number, string>();
  if (documents[0]) {
    let document: unknown;
    try {
      document = JSON.parse(String(documents[0].value));
    } catch {
      check(false, 'todofy.mail_labels');
    }
    const entries = (document as { categories?: unknown } | null)?.categories;
    check(Array.isArray(entries), 'todofy.mail_labels');
    for (const entry of entries as Row[])
      bound.set(count(entry.id, 'todofy.mail_labels'), matching(entry.label_id, ID, 'todofy.mail_labels'));
  }
  const active = rows(answers, 'todofy.mail_categories')
    .map((row) => ({
      id: count(row.id, 'todofy.mail_categories'),
      priority: count(row.priority, 'todofy.mail_categories'),
      order: count(row.sort_order, 'todofy.mail_categories'),
    }))
    .sort((a, b) => a.order - b.order || a.id - b.id);
  check(
    active.length <= MAX_CATEGORIES && active.every((category) => category.priority >= 1 && category.priority <= 4),
    'todofy.mail_categories',
  );
  const next = rows(answers, 'todofy.next_category');
  check(next.length === 1, 'todofy.next_category');
  const nextId = count(next[0]?.id, 'todofy.next_category');
  const items: Category[] = [];
  for (const category of active) {
    // A category is saved with its label in one batch; one without is not shown, so it is not copied either.
    const label = bound.get(category.id);
    counts.categories.all++;
    if (kept) counts.categories.present++;
    else if (!label || !labels.has(label)) counts.categories.skipped++;
    else items.push({ id: category.id, label_id: label, priority: category.priority });
  }
  check(items.every((category) => category.id < nextId), 'todofy.next_category');
  plan.categories = { items, next: Math.max(nextId, 1) };

  const routes = rows(answers, 'todofy.routes');
  check(routes.length === 1, 'todofy.routes');
  for (const source of ['home', 'review'] as const) {
    const value = routes[0]?.[source];
    if (value === null || value === undefined) continue;
    const projectId = matching(value, ID, 'todofy.routes');
    counts.routes.all++;
    if (routed.has(source)) counts.routes.present++;
    else if (!projects.has(projectId)) counts.routes.skipped++;
    else plan.routes.push({ source, projectId });
  }

  counts.days.pending = plan.days.length;
  counts.reviews.pending = plan.reviews.length;
  counts.categories.pending = items.length;
  counts.routes.pending = plan.routes.length;
  counts.pending = counts.days.pending + counts.reviews.pending + counts.categories.pending + counts.routes.pending;
  return plan;
}

const whole = (value: number | null) => value === null || (Number.isSafeInteger(value) && value >= 0);

/** Whether every value the SQL quotes is one prepareTodofyImport could have made. */
function quotable({ days, reviews, categories, routes }: TodofyImport): boolean {
  return (
    days.every(
      (row) =>
        DAY.test(row.day) &&
        SCOPES.includes(row.scope) &&
        row.counts.length === COUNTS.length &&
        row.counts.every(whole) &&
        row.optional.length === OPTIONAL_COUNTS.length &&
        row.optional.every(whole) &&
        (row.complete === 0 || row.complete === 1) &&
        whole(row.computedAt),
    ) &&
    reviews.every(
      (row) =>
        WEEK.test(row.week) &&
        ['created', 'unknown', 'failed'].includes(row.state) &&
        (row.taskId === '' || ID.test(row.taskId)) &&
        whole(row.createdAt) &&
        whole(row.completedAt),
    ) &&
    whole(categories.next) &&
    categories.items.every(
      (item) => whole(item.id) && ID.test(item.label_id) && item.priority >= 1 && item.priority <= 4,
    ) &&
    routes.every((route) => ['home', 'review'].includes(route.source) && ID.test(route.projectId))
  );
}
const sqlNumber = (value: number | null) => (value === null ? 'NULL' : String(value));

/**
 * One guarded statement per row, for `wrangler d1 execute --file`, and the categories' copy, which also records that
 * the import ran (mail_settings.created_at), so the file is never empty.
 */
export function todofyImportSql(plan: TodofyImport): string {
  if (!quotable(plan)) throw new TodofyImportError('PLAN_INVALID');
  const { items, next } = plan.categories;
  const statements = [
    ...plan.days.map(
      (row) =>
        `INSERT INTO gtd_days(day,scope,${[...COUNTS, ...OPTIONAL_COUNTS].join(',')},complete,computed_at) ` +
        `VALUES('${row.day}','${row.scope}',${[...row.counts, ...row.optional].map(sqlNumber).join(',')},` +
        `${String(row.complete)},${String(row.computedAt)}) ON CONFLICT DO NOTHING;`,
    ),
    ...plan.reviews.map(
      (row) =>
        'INSERT INTO weekly_reviews(week,state,task_id,created_at,completed_at) ' +
        `VALUES('${row.week}','${row.state}','${row.taskId}',${String(row.createdAt)},${sqlNumber(row.completedAt)}) ` +
        'ON CONFLICT DO NOTHING;',
    ),
    `UPDATE mail_settings SET categories=CAST(X'${Buffer.from(JSON.stringify(items), 'utf8').toString('hex')}' AS TEXT),` +
      `next_category_id=MAX(next_category_id,${String(next)}),revision=revision+1,` +
      "created_at=unixepoch()*1000,updated_at=unixepoch()*1000 WHERE id='mail' AND created_at=0;",
    ...plan.routes.map(
      (route) =>
        'INSERT INTO task_inbox_routes(source,project_id,updated_at) ' +
        `SELECT '${route.source}','${route.projectId}',unixepoch()*1000 WHERE EXISTS(SELECT 1 FROM projects ` +
        `WHERE id='${route.projectId}' AND deleted_at IS NULL AND archived=0) ON CONFLICT DO NOTHING;`,
    ),
  ];
  return `${statements.join('\n')}\n`;
}
