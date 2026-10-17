/** Native sync's bounded page through the actual owner handler and service binding. */
import { expect, it } from 'vitest';
import { SyncTasksRequest_Mode } from '@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb';
import {
  COLD_ISOLATES,
  connectCpuMeter,
  CPU_TEST_TIMEOUT_MS,
  FREE_CPU_MS,
  measureInIsolates,
} from '../../../../tools/workerd-cpu/workerd-cpu.mts';
import { NATIVE_SYNC_PAGE } from '../../src/native-tasks.ts';
import { startHarness } from './harness.ts';

const page = JSON.stringify({
  changes: Array.from({ length: NATIVE_SYNC_PAGE }, (_, n) => ({
    cursor: String(n + 1),
    name: `tasks/synthetic-${String(n)}`,
    task: {
      id: `synthetic-${String(n)}`,
      name: `tasks/synthetic-${String(n)}`,
      title: `Synthetic task ${String(n)} for a realistic planning page`,
      description_preview: 'Synthetic task notes. '.repeat(10),
      project_id: 'work',
      label_ids: ['deep'],
      priority: 2,
      duration_minutes: 30,
      due_date: '2026-10-17',
      create_time: '2026-10-17T10:00:00Z',
    },
  })),
  next_page_token: String(NATIVE_SYNC_PAGE),
  has_more: false,
});
const catalog = JSON.stringify({
  projects: [{ id: 'work', name: 'projects/work', title: 'Work', color: '#246fe0' }],
  labels: [{ id: 'deep', name: 'labels/deep', title: 'deep' }],
});

it('keeps a 100-task native page within Workers Free CPU without a Todoist key', { timeout: CPU_TEST_TIMEOUT_MS }, async () => {
  const { reference } = await measureInIsolates(
    COLD_ISOLATES,
    async () => {
      const h = await startHarness({
        inspectorPort: 0,
        tasks: (request) =>
          Promise.resolve(
            new Response(new URL(request.url).pathname.endsWith('/catalog') ? catalog : page, {
              headers: { 'content-type': 'application/json' },
            }),
          ),
      });
      const meter = await connectCpuMeter(h.mf, 'flowday');
      return {
        h,
        meter,
        async dispose() {
          meter.close();
          await h.dispose();
        },
      };
    },
    async ({ h, meter }) => {
      // Fetch CSRF before measuring the sync handler.
      await h.api.updateFlow({ flow: { name: 'flows/2026-10-17', taskIds: [] }, updateMask: { paths: ['task_ids'] } });
      return [
        await meter.measure('Native Tasks sync (100 tasks)', async () => {
          await h.sql("DELETE FROM settings WHERE key IN ('sync_claimed_at','tasks_sync_cursor','tasks_sync_catalog')");
          await h.api.syncTasks({ mode: SyncTasksRequest_Mode.MANUAL });
        }),
      ];
    },
  );
  const measured = reference.get('Native Tasks sync (100 tasks)');
  expect(measured?.first).toBeLessThan(FREE_CPU_MS);
  expect(measured?.median).toBeLessThan(FREE_CPU_MS);
});
