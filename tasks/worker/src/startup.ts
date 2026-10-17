import { localDate } from '@ziyixi/task-dates';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { TaskSchema } from '@ziyixi/proto/tasks/ui/v1/task_pb';
import { ListTasksResponseSchema } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { toWire } from '@ziyixi/proto/wire-json';

// workerd measured ~12ms for first Intl initialization alone. Initialize the locale and the list codec
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
