import { dependencyIndex, isWaiting } from "./dependencies";
import { taskAncestors } from "./domain";
import type { PlanState, PlanningTask } from "./model";

interface PlanVisibility {
  tasks: PlanningTask[];
  hidden: Set<string>;
}
const views = new WeakMap<
  PlanState["dependencies"],
  WeakMap<PlanState["tasks"], PlanVisibility>
>();

/** Plan hides waiting tasks and their descendants; the complete snapshot stays available to Focus. */
export function planVisibility(
  plan: Pick<PlanState, "tasks" | "dependencies">,
): PlanVisibility {
  let byTasks = views.get(plan.dependencies);
  if (!byTasks) {
    byTasks = new WeakMap();
    views.set(plan.dependencies, byTasks);
  }
  const saved = byTasks.get(plan.tasks);
  if (saved) return saved;
  const index = dependencyIndex(plan);
  const waiting = (task: PlanningTask) =>
    isWaiting(task, index) || Boolean(task.planningFlags?.includes("blocked"));
  const hidden = new Set<string>();
  const tasks = plan.tasks.filter((task) => {
    if (waiting(task) || taskAncestors(task, plan.tasks).some(waiting)) {
      hidden.add(task.id);
      return false;
    }
    return true;
  });
  const visible = { tasks, hidden };
  byTasks.set(plan.tasks, visible);
  return visible;
}
