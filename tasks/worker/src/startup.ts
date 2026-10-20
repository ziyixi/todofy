import { localDate } from '@ziyixi/task-dates';
import { create } from '@ziyixi/proto/protobuf';
import {
  ListFocusDaysResponseSchema,
  ListTasksRequestSchema,
  ListTasksResponseSchema,
} from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { focusDaysAnswer } from './focus.ts';
import type { TaskRow } from './model.ts';
import { MAX_DEPENDENCIES } from './planning.ts';
import { listTasks } from './task-read.ts';

const STARTUP_ROWS = 100;

/**
 * Runs, once per isolate, the work an isolate's first owner requests would otherwise do first: index.ts calls it in
 * the Worker's global scope with the account's zone, under the platform's startup budget, before any owner's request
 * CPU is charged. No clock, network, bindings, user data or repeated compilation loops are involved.
 */
export function warmUp(zone: string): void {
  // workerd measured ~12ms for first Intl initialization alone, and a zone's first formatter about 0.15 ms more.
  localDate(0, zone);
  // Every API request is first read strictly into its message (the transcoder's decode): one read here runs that
  // code before an isolate's first request does.
  fromWire(
    ListTasksRequestSchema,
    { view: 'all', page_size: 100, include_completed: true, task_ids: ['startup'] },
    { strict: true },
  );
  warmTaskPage(zone);
  warmFocusWeek();
}

/**
 * A task page is the answer an isolate most often writes first: listTasks runs here whole, over synthetic rows with
 * every planning field and the most dependencies a task has, enough of them for V8 to optimize its mapping (the
 * planning rules and each row's dependencies) and the codec. A stub D1 answers its query with those rows: nothing is
 * read (the global scope allows no I/O), and its promise settles in the startup's own microtasks. A failure here would
 * only lose the warm-up, so it is logged rather than thrown.
 */
function warmTaskPage(zone: string): void {
  const dependencies = JSON.stringify(
    Array.from({ length: MAX_DEPENDENCIES }, (_, index) => ({
      prerequisite_id: `startup-${String(index)}`,
      title: 'Startup',
      done: index % 2,
    })),
  );
  const rows = Array.from(
    { length: STARTUP_ROWS },
    (_, index): TaskRow => ({
      id: `startup-${String(index)}`,
      title: 'Startup',
      description: '',
      project_id: '',
      section_id: '',
      parent_id: '',
      label_ids: '[]',
      priority: 4,
      sort_order: index,
      due_date: '2000-01-03',
      due_datetime: '',
      due_timezone: '',
      deadline: '2000-01-05',
      duration_minutes: 30,
      recurrence: '',
      kind: 'task',
      effort: '',
      stage: index % 2 ? 'committed' : 'none',
      committed_week: '2000-01-03',
      area: 'work',
      lead_days: index % 3,
      planning_flags: index % 2 ? '["quick","waiting","task"]' : '[]',
      completed: 0,
      completed_at: null,
      revision: 1,
      created_at: 0,
      updated_at: 0,
      deleted_at: null,
      dependencies,
    }),
  );
  const statement = { bind: () => statement, all: () => Promise.resolve({ results: rows }) };
  const stubDb = { prepare: () => statement } as unknown as D1Database;
  listTasks(stubDb, create(ListTasksRequestSchema, { view: 'all', pageSize: STARTUP_ROWS }), zone, 0)
    .then((page) => toWire(ListTasksResponseSchema, page))
    .catch((error: unknown) => {
      console.error('Tasks startup warm-up failed', error);
    });
}

/**
 * Focus's week read is the largest answer an isolate may write first (proto/README.md, "Large lists"): its mapping
 * and codec run here over synthetic rows, enough of them for V8 to optimize both. Measured 2026-10-19, this takes an
 * isolate's first read of the fullest week from 10.1 to 8.5-8.9 reference ms.
 */
function warmFocusWeek(): void {
  toWire(
    ListFocusDaysResponseSchema,
    focusDaysAnswer(
      ['2000-01-01'],
      {
        queue: Array.from({ length: STARTUP_ROWS }, (_, index) => ({
          day: '2000-01-01',
          task_id: `startup-${String(index)}`,
          position: index,
          done_at: index % 2 ? 0 : null,
          completed: 0,
        })),
        entries: Array.from({ length: STARTUP_ROWS }, (_, index) => ({
          id: `startup-${String(index)}`,
          task_id: 'startup',
          day: '2000-01-01',
          seconds: 60,
          started_at: index % 2 ? 0 : null,
          source: index % 2 ? 'timer' : 'manual',
          area: 'work',
          revision: 1,
        })),
        tasks: Array.from({ length: STARTUP_ROWS }, (_, index) => ({
          id: `startup-${String(index)}`,
          title: 'Startup',
          parent_id: 'startup',
          parent_title: 'Startup',
          duration_minutes: 1,
          completed: index % 2,
        })),
      },
      '2000-01-01',
    ),
  );
}
