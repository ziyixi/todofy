import { localDate } from '@ziyixi/task-dates';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { TaskSchema } from '@ziyixi/proto/tasks/ui/v1/task_pb';
import { ListFocusDaysResponseSchema, ListTasksResponseSchema } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { toWire } from '@ziyixi/proto/wire-json';
import { focusDaysAnswer } from './focus.ts';

// workerd measured ~12ms for first Intl initialization alone. Initialize the locale and the list codecs
// once at module startup, under the platform's startup budget, before any owner's request CPU is charged.
// No clock, network, bindings, user data or repeated compilation loops are involved.
localDate(0, 'UTC');
toWire(
  ListTasksResponseSchema,
  create(ListTasksResponseSchema, {
    tasks: [
      create(TaskSchema, {
        name: 'tasks/startup',
        title: '',
        createTime: timestampFromMs(0),
        updateTime: timestampFromMs(0),
      }),
    ],
  }),
);
// Focus's week read is the largest answer an isolate may write first (proto/README.md, "Large lists"): its
// mapping and codec run here over synthetic rows, enough of them for V8 to optimize both. Measured 2026-10-19,
// this takes an isolate's first read of the fullest week from 10.1 to 8.5-8.9 reference ms.
const STARTUP_ROWS = 100;
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
