#!/usr/bin/env node
// Explicit, read-only migration export. The output contains private task content; never write it in the repo.
import { open, realpath, readFile } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.todoist.com/api/v1';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DAY = 86_400_000;

export class ExportError extends Error {}

export async function todoistRead(token, path, { fetcher = fetch, body } = {}) {
  if (!token?.trim()) throw new ExportError('TODOIST_TOKEN_REQUIRED');
  const response = await fetcher(API + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${token.trim()}`,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body
      ? {
          body: new URLSearchParams(
            Object.entries(body).map(([key, value]) => [
              key,
              typeof value === 'string' ? value : JSON.stringify(value),
            ]),
          ),
        }
      : {}),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  if (!response.ok) throw new ExportError(`TODOIST_READ_HTTP_${response.status}`);
  return JSON.parse(await response.text(), (key, value, context) => {
    if (key === 'id' && typeof value === 'number' && !Number.isSafeInteger(value) && /^\d+$/.test(context.source))
      return context.source;
    return value;
  });
}

export async function readPages(read, path, parameters = {}, collection = 'results') {
  const items = [];
  const cursors = new Set();
  let cursor = '';
  do {
    const query = new URLSearchParams({ ...parameters, limit: '200', ...(cursor ? { cursor } : {}) });
    const page = await read(`${path}?${query}`);
    if (
      !page ||
      !Array.isArray(page[collection]) ||
      page[collection].some((item) => !item || typeof item !== 'object')
    ) {
      throw new ExportError('TODOIST_PAGE_INVALID');
    }
    items.push(...page[collection]);
    const next = page.next_cursor ?? '';
    if (typeof next !== 'string' || (next && cursors.has(next))) throw new ExportError('TODOIST_CURSOR_INVALID');
    if (next) cursors.add(next);
    if (cursors.size > 10_000) throw new ExportError('TODOIST_PAGINATION_LIMIT');
    cursor = next;
  } while (cursor);
  return items;
}

export async function readArchivedSections(read, projectId) {
  const query = new URLSearchParams({ project_id: projectId, limit: '200' });
  const page = await read(`/sections/archived?${query}`);
  if (!page || !Array.isArray(page.sections) || typeof page.has_more !== 'boolean' ||
    !Number.isSafeInteger(page.total) || page.total < 0 ||
    page.sections.some((row) => !row || typeof row.id !== 'string' || !row.id || row.project_id !== projectId))
    throw new ExportError('TODOIST_ARCHIVED_SECTION_PAGE_INVALID');
  if (page.has_more) throw new ExportError('TODOIST_ARCHIVED_SECTION_PAGINATION_UNVERIFIED');
  if (page.sections.length !== page.total) throw new ExportError('TODOIST_ARCHIVED_SECTION_PAGE_INCOMPLETE');
  return page.sections;
}

export function completionWindows(since, until, days = 28) {
  let start = Date.parse(since);
  const end = Date.parse(until);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || !Number.isInteger(days) || days < 1)
    throw new ExportError('HISTORY_RANGE_INVALID');
  const windows = [];
  while (start < end) {
    const stop = Math.min(start + days * DAY, end);
    windows.push({ since: new Date(start).toISOString(), until: new Date(stop).toISOString() });
    start = stop;
  }
  return windows;
}

function uniqueObjects(items, key) {
  const result = new Map();
  for (const item of items) {
    const id = key(item);
    if (typeof id !== 'string' || !id) throw new ExportError('TODOIST_OBJECT_ID_MISSING');
    result.set(id, item);
  }
  return [...result.values()];
}

function projectContents(value, projectId) {
  if (!value || value.project?.id !== projectId || !Array.isArray(value.tasks) || !Array.isArray(value.sections))
    throw new ExportError('TODOIST_FULL_PROJECT_INVALID');
  for (const row of [...value.tasks, ...value.sections]) {
    if (!row || typeof row.id !== 'string' || !row.id || row.project_id !== projectId)
      throw new ExportError('TODOIST_FULL_PROJECT_INVALID');
  }
  return value;
}

function completionEventId(event) {
  const time = Date.parse(event.event_date);
  if (
    event.object_type !== 'item' || event.event_type !== 'completed' ||
    typeof event.object_id !== 'string' || !event.object_id ||
    !Number.isFinite(time) ||
    (event.id !== null && event.id !== undefined && typeof event.id !== 'string' && !Number.isSafeInteger(event.id))
  ) throw new ExportError('TODOIST_COMPLETION_EVENT_INVALID');
  return event.id === null || event.id === undefined
    ? `${event.object_id}:${event.event_date}`
    : String(event.id);
}

export async function exportSnapshot(read, since, now = new Date()) {
  // No mutation commands are sent. Final migration still requires the controlled pause window.
  const snapshot = await read('/sync', {
    sync_token: '*',
    resource_types: ['items', 'projects', 'sections', 'labels', 'filters', 'user'],
  });
  for (const key of ['items', 'projects', 'sections', 'labels', 'filters']) {
    if (!Array.isArray(snapshot?.[key])) throw new ExportError('TODOIST_SNAPSHOT_INCOMPLETE');
  }
  if (snapshot.full_sync !== true || typeof snapshot.sync_token !== 'string')
    throw new ExportError('TODOIST_SNAPSHOT_INCOMPLETE');
  const archived = await readPages(read, '/projects/archived');
  const projects = [...snapshot.projects, ...archived];
  const sections = [...snapshot.sections];
  const tasks = [...snapshot.items];
  for (const project of uniqueObjects([...snapshot.projects, ...archived], (item) => item.id)) {
    // The official SDK's full-project contract includes tasks and sections, including archived organization.
    const full = projectContents(await read(`/projects/${encodeURIComponent(project.id)}/full`), project.id);
    projects.push(full.project);
    tasks.push(...full.tasks);
    sections.push(...full.sections);
    const archivedSections = await readArchivedSections(read, project.id);
    sections.push(...archivedSections);
    for (const section of archivedSections) {
      const archivedTasks = await readPages(read, '/tasks', { section_id: section.id });
      if (archivedTasks.some((task) => typeof task.id !== 'string' || !task.id || task.project_id !== project.id))
        throw new ExportError('TODOIST_ARCHIVED_SECTION_TASK_INVALID');
      tasks.push(...archivedTasks);
    }
  }
  const completed = [];
  for (const range of completionWindows(since, now.toISOString())) {
    completed.push(...(await readPages(read, '/tasks/completed/by_completion_date', range, 'items')));
  }
  const completionEvents = [];
  const activityStart = new Date(Math.floor(Date.parse(since) / DAY) * DAY).toISOString();
  const activityEnd = new Date(Math.ceil(now.getTime() / DAY) * DAY).toISOString();
  for (const range of completionWindows(activityStart, activityEnd, 7)) {
    completionEvents.push(...await readPages(async (path) => {
      const page = await read(path);
      if (!page || !Object.hasOwn(page, 'next_cursor')) throw new ExportError('TODOIST_ACTIVITY_PAGE_INCOMPLETE');
      return page;
    }, '/activities', {
      object_type: 'item', event_type: 'completed', date_from: range.since.slice(0, 10), date_to: range.until.slice(0, 10),
    }));
  }
  const fullHistory = snapshot.user?.is_premium === true ||
    ['current_personal_plan', 'legacy_personal_plan', 'teams_business_member'].includes(snapshot.user?.premium_status);
  return {
    version: 1,
    source: 'todoist',
    exported_at: now.toISOString(),
    history_since: new Date(since).toISOString(),
    time_zone: snapshot.user?.tz_info?.timezone ?? snapshot.user?.timezone ?? '',
    sync_token: snapshot.sync_token,
    projects: uniqueObjects(projects, (item) => item.id),
    sections: uniqueObjects(sections, (item) => item.id),
    labels: snapshot.labels,
    filters: snapshot.filters,
    tasks: uniqueObjects(tasks, (item) => item.id),
    completed: uniqueObjects(completed, (item) => {
      if (!item.id || !item.completed_at) throw new ExportError('TODOIST_COMPLETION_IDENTITY_MISSING');
      return `${item.id}:${item.completed_at}`;
    }),
    completion_events: uniqueObjects(completionEvents, completionEventId).filter((event) =>
      Date.parse(event.event_date) >= Date.parse(since) && Date.parse(event.event_date) < now.getTime(),
    ),
    archived_contents_verified: true,
    history_access: fullHistory ? 'full' : 'limited_or_unknown',
    recurring_history_verified: fullHistory || Date.parse(since) >= now.getTime() - 7 * DAY,
  };
}

export async function privateText(output, text) {
  const parent = await realpath(dirname(resolve(output)));
  const target = resolve(parent, resolve(output).split('/').at(-1));
  const rel = relative(ROOT, target);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new ExportError('OUTPUT_MUST_BE_OUTSIDE_REPOSITORY');
  const file = await open(target, 'wx', 0o600);
  try {
    await file.writeFile(text);
  } finally {
    await file.close();
  }
}

export async function privateOutput(output, value) {
  return privateText(output, JSON.stringify(value));
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => args[args.indexOf(name) + 1];
  if (!args.includes('--output') || !args.includes('--since')) throw new ExportError('USE_OUTPUT_AND_SINCE');
  const token = args.includes('--token-file')
    ? await readFile(option('--token-file'), 'utf8')
    : process.env.TODOIST_API_TOKEN;
  const read = (path, body) => todoistRead(token, path, { body });
  const snapshot = await exportSnapshot(read, option('--since'));
  await privateOutput(option('--output'), snapshot);
  console.log(
    JSON.stringify({
      event: 'todoist_export_saved',
      tasks: snapshot.tasks.length,
      projects: snapshot.projects.length,
      completed: snapshot.completed.length,
      completion_events: snapshot.completion_events.length,
      recurring_history_verified: snapshot.recurring_history_verified,
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof ExportError ? error.message : 'TODOIST_EXPORT_FAILED');
    process.exitCode = 1;
  });
}
