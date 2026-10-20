/**
 * The fullest week Focus can hold (src/focus.ts): 7 days of 20 queued steps and 30 records, on 350 different tasks
 * with 500-character titles under parents with 500-character titles. Synthetic rows, written directly.
 */
export const WEEK_STEPS = 7 * 20;
export const WEEK_ENTRIES = 7 * 30;

function title(prefix: string, index: number): string {
  return `${prefix} ${String(index)} ${'Synthetic focus title words '.repeat(20)}`.slice(0, 500);
}
function day(start: string, offset: number): string {
  return new Date(Date.parse(`${start}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

export async function seedWorstWeek(db: D1Database, start: string, prefix = 'week'): Promise<void> {
  const parents = Array.from({ length: 7 }, (_, index) => ({
    id: `${prefix}-parent-${String(index)}`,
    title: title('Outcome', index),
  }));
  const steps = Array.from({ length: WEEK_STEPS + WEEK_ENTRIES }, (_, index) => ({
    id: `${prefix}-step-${String(index)}`,
    title: title('Step', index),
    parent: parents[index % 7]?.id,
    order: index,
  }));
  const queued = steps.slice(0, WEEK_STEPS).map((step, index) => ({
    day: day(start, Math.floor(index / 20)),
    id: step.id,
    position: (index % 20) + 1,
  }));
  const recorded = steps.slice(WEEK_STEPS).map((step, index) => ({
    id: `${prefix}-entry-${String(index)}`,
    task: step.id,
    day: day(start, Math.floor(index / 30)),
    started: 1_700_000_000_000 + index * 60_000,
    area: ['work', 'personal', ''][index % 3],
  }));
  await db.batch([
    db
      .prepare(
        `INSERT INTO tasks(id,title,sort_order,created_at,updated_at) SELECT value->>'id',value->>'title',1,1,1 FROM json_each(?)`,
      )
      .bind(JSON.stringify(parents)),
    db
      .prepare(
        `INSERT INTO tasks(id,title,parent_id,kind,duration_minutes,sort_order,created_at,updated_at)
        SELECT value->>'id',value->>'title',value->>'parent','step',30,value->>'order',1,1 FROM json_each(?)`,
      )
      .bind(JSON.stringify(steps)),
    db
      .prepare(
        `INSERT INTO day_steps(day,task_id,position,created_at,updated_at)
        SELECT value->>'day',value->>'id',value->>'position',1,1 FROM json_each(?)`,
      )
      .bind(JSON.stringify(queued)),
    db
      .prepare(
        `INSERT INTO focus_entries(id,task_id,day,seconds,started_at,source,area,created_at,updated_at)
        SELECT value->>'id',value->>'task',value->>'day',1500,value->>'started','timer',value->>'area',1,1 FROM json_each(?)`,
      )
      .bind(JSON.stringify(recorded)),
  ]);
}
