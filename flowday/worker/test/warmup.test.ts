/**
 * The startup warm-up (../src/warmup.ts): its synthetic raw rows must map through each list's real query to the
 * records a request maps (a column added to ../src/schema.ts without the warm-up's row would map to the wrong
 * fields, and the warm-up would then warm a path no request takes), and a whole warm-up must stay a small part of
 * Workers' startup budget (the global scope may use up to 1 s of CPU; this machine is not Cloudflare's, so the bound
 * is loose).
 */
import { describe, expect, it } from 'vitest';
import { warmQueries, warmUp, WARMUP_ROUNDS } from '../src/warmup.ts';

describe('warm-up', () => {
  it("maps each list's synthetic rows to the records a request maps", () => {
    const rows = warmQueries();
    const task = {
      id: 'warmup-task',
      todoistId: 'warmup-task',
      title: 'Warm-up task',
      description: 'Warm-up description',
      projectName: 'Warm-up project',
      projectColor: '#808080',
      priority: 2,
      labels: ['warm', 'up'],
      estimatedMins: 30,
      isCompleted: false,
      completedAt: '2026-01-01T00:00:00.000000Z',
      dueDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00Z',
      deletedAt: '2026-01-01T00:00:00.000Z',
    };
    const entry = {
      id: 'warmup-entry',
      taskId: 'warmup-task',
      flowDate: '2026-01-01',
      startTime: '2026-01-01T09:00:00.000Z',
      endTime: '2026-01-01T09:30:00.000Z',
      durationS: 1800,
      source: 'manual',
      createdAt: '2026-01-01 09:30:00',
    };
    expect(rows.tasks).toHaveLength(5);
    expect(rows.tasks[0]).toEqual(task);
    expect(rows.tasksById[0]).toEqual(task);
    expect(rows.entries[0]).toEqual(entry);
    expect(rows.analyticsEntries[0]).toEqual(entry);
    expect(rows.notes[0]).toEqual({ taskId: 'warmup-task', flowDate: '2026-01-01', content: 'Warm-up note', updatedAt: '2026-01-01T09:30:00.000Z' });
    expect(rows.planned[0]).toEqual({ flowDate: '2026-01-01', taskId: 'warmup-task', sortOrder: 1 });
    expect(rows.completed[0]).toEqual({ flowDate: '2026-01-01', taskId: 'warmup-task', rowid: 2 });
    expect(rows.flowRows[0]).toEqual({ flowDate: '2026-01-01', taskId: 'warmup-task' });
    expect(rows.completedRows[0]).toEqual({ flowDate: '2026-01-01', taskId: 'warmup-task' });
    expect(rows.planningKeys[0]).toBe('planning_completed:2026-01-01');
  });

  it('takes a small part of the startup budget', () => {
    const start = performance.now();
    warmUp(WARMUP_ROUNDS);
    const ms = performance.now() - start;
    console.log(`warm-up: ${String(WARMUP_ROUNDS)} rounds in ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(500);
  });
});
