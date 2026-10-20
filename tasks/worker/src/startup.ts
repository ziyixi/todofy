import { localDate } from '@ziyixi/task-dates';
import { create } from '@ziyixi/proto/protobuf';
import { ListFocusDaysResponseSchema, ListTasksResponseSchema } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { toWire } from '@ziyixi/proto/wire-json';
import { focusDaysAnswer } from './focus.ts';
import { taskMessage } from './model.ts';
import { MAX_DEPENDENCIES } from './planning.ts';

// workerd measured ~12ms for first Intl initialization alone. Initialize the locale and the list codecs
// once at module startup, under the platform's startup budget, before any owner's request CPU is charged.
// No clock, network, bindings, user data or repeated compilation loops are involved.
localDate(0, 'UTC');
// A task page is the answer an isolate most often writes first: its mapping (the planning rules and each row's
// dependencies) and codec run here over synthetic rows with every planning field and the most dependencies a task
// has, enough of them for V8 to optimize both.
const STARTUP_ROWS = 100;
const dependencies = JSON.stringify(
  Array.from({ length: MAX_DEPENDENCIES }, (_, index) => ({
    prerequisite_id: `startup-${String(index)}`,
    title: 'Startup',
    done: index % 2,
  })),
);
toWire(
  ListTasksResponseSchema,
  create(ListTasksResponseSchema, {
    tasks: Array.from({ length: STARTUP_ROWS }, (_, index) =>
      taskMessage(
        {
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
        },
        '2000-01-04',
      ),
    ),
  }),
);
// Focus's week read is the largest answer an isolate may write first (proto/README.md, "Large lists"): its
// mapping and codec run here over synthetic rows, enough of them for V8 to optimize both. Measured 2026-10-19,
// this takes an isolate's first read of the fullest week from 10.1 to 8.5-8.9 reference ms.
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
