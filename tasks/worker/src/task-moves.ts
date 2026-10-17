import { precondition, storage } from './errors.ts';

const taskFamily = `WITH RECURSIVE family(id,depth) AS (
  SELECT id,0 FROM tasks WHERE id=? AND deleted_at IS NULL
  UNION ALL SELECT t.id,f.depth+1 FROM tasks t JOIN family f ON t.parent_id=f.id
  WHERE t.deleted_at IS NULL AND f.depth<31
)`;
const sectionFamilies = `WITH RECURSIVE family(id,depth) AS (
  SELECT id,0 FROM tasks WHERE section_id=? AND parent_id='' AND deleted_at IS NULL
  UNION ALL SELECT t.id,f.depth+1 FROM tasks t JOIN family f ON t.parent_id=f.id
  WHERE t.deleted_at IS NULL AND f.depth<31
)`;

export async function moveTaskDescendants(
  db: D1Database,
  taskId: string,
  projectId: string,
  now: number,
): Promise<D1PreparedStatement[]> {
  const family = await storage(() =>
    db.prepare(`${taskFamily} SELECT MAX(depth) AS depth FROM family`).bind(taskId).first<{ depth: number }>(),
  );
  const writes: D1PreparedStatement[] = [];
  // Each depth runs after its parents, regardless of the tasks' insertion order.
  for (let depth = 1; depth <= (family?.depth ?? 0); depth++) {
    writes.push(
      db.prepare(`${taskFamily} UPDATE tasks SET project_id=?,section_id='',revision=revision+1,updated_at=?
        WHERE id IN (SELECT id FROM family WHERE depth=?)`).bind(taskId, projectId, now, depth),
    );
  }
  // A child added after the depth read must abort the batch instead of being left behind.
  writes.push(
    db.prepare(`${taskFamily} UPDATE tasks SET parent_id=parent_id
      WHERE id IN (SELECT id FROM family) AND project_id<>?`).bind(taskId, projectId),
  );
  return writes;
}

export async function moveSectionTasks(
  db: D1Database,
  sectionId: string,
  projectId: string,
  now: number,
): Promise<D1PreparedStatement[]> {
  const family = await storage(() =>
    db.prepare(`${sectionFamilies} SELECT MAX(depth) AS depth,
      EXISTS(SELECT 1 FROM tasks WHERE section_id=? AND deleted_at IS NULL
        AND id NOT IN (SELECT id FROM family)) AS outside_parent FROM family`)
      .bind(sectionId, sectionId).first<{ depth: number | null; outside_parent: number }>(),
  );
  if (family?.outside_parent)
    precondition('Move the outside parent into this section before moving the section');
  const writes: D1PreparedStatement[] = [];
  for (let depth = 0; depth <= (family?.depth ?? -1); depth++) {
    writes.push(
      db.prepare(`${sectionFamilies} UPDATE tasks SET project_id=?,
        section_id=CASE WHEN section_id=? THEN ? ELSE '' END,revision=revision+1,updated_at=?
        WHERE id IN (SELECT id FROM family WHERE depth=?)`)
        .bind(sectionId, projectId, sectionId, sectionId, now, depth),
    );
  }
  // Existing reference triggers validate any concurrent additions before the batch commits.
  writes.push(
    db.prepare(`${sectionFamilies} UPDATE tasks SET section_id=section_id
      WHERE project_id<>? AND deleted_at IS NULL AND (section_id=? OR id IN (SELECT id FROM family))`)
      .bind(sectionId, projectId, sectionId),
  );
  return writes;
}
