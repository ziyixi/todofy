/** Where a machine writer's tasks go (task_inbox_routes): TaskInbox's sources and the weekly review. */
import { storage } from './errors.ts';

/**
 * The project a source's tasks go to: its route's project while it is live and neither it nor a parent is archived,
 * else '' (the Inbox). The weekly review routes as 'review'.
 */
export async function routedProject(db: D1Database, source: 'home' | 'watch' | 'review'): Promise<string> {
  const row = await storage(() =>
    db
      .prepare(
        `WITH RECURSIVE chain(id,parent_id,archived) AS (
          SELECT p.id,p.parent_id,p.archived FROM task_inbox_routes r JOIN projects p ON p.id=r.project_id
          WHERE r.source=? AND p.deleted_at IS NULL
          UNION ALL SELECT p.id,p.parent_id,p.archived FROM projects p JOIN chain c ON p.id=c.parent_id
          WHERE p.deleted_at IS NULL)
        SELECT project_id FROM task_inbox_routes WHERE source=? AND EXISTS(SELECT 1 FROM chain)
        AND NOT EXISTS(SELECT 1 FROM chain WHERE archived=1)`,
      )
      .bind(source, source)
      .first<{ project_id: string | null }>(),
  );
  return row?.project_id ?? '';
}
