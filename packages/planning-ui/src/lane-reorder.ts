import { useRef } from "react";
import { MAX_LANE_TASKS } from "./planning-outcomes";
import { moved, pendingTask, predictLaneOrder } from "./plan-updates";
import type { LaneId, PlanningTask, PlusActions, RunOperation } from "./model";

/**
 * A lane reorder, as Review's lanes and Week's Committed row write it. `reorderLane` moves `task`
 * from `from` to `to`, both positions in the whole lane (`laneTasks`, which an area filter never
 * shortens): one ReorderTasks with the lane's new order, at most 100, under the etags Plan holds for
 * the cards. The card shows in its new
 * place at once and waits there until Tasks confirms. It returns true when it queued a
 * write; the caller then puts focus back on the moved card's grip.
 */
export function useLaneReorder(actions: PlusActions, run: RunOperation) {
  // A reorder's request ID, reused when the same reorder is tried again.
  const requests = useRef(new Map<string, string>());
  return function reorderLane(
    task: PlanningTask,
    lane: LaneId,
    laneTasks: readonly PlanningTask[],
    from: number,
    to: number,
  ): boolean {
    let ordered = moved(laneTasks, from, to);
    if (ordered.every((item, index) => item === laneTasks[index])) return false;
    if (ordered.length > MAX_LANE_TASKS) {
      if (ordered.findIndex((item) => item.id === task.id) >= MAX_LANE_TASKS)
        return false;
      ordered = ordered.slice(0, MAX_LANE_TASKS);
    }
    const next = ordered.map((item) => item.id);
    // The etags the request is built with are part of the key: once a task changed elsewhere, so
    // that Tasks refuses the old request, the read that follows makes the next drop a new one.
    const key = [
      lane,
      task.id,
      next.join(","),
      laneTasks.map((item) => item.etag).join(","),
    ].join("|");
    const requestId = requests.current.get(key) ?? crypto.randomUUID();
    requests.current.set(key, requestId);
    void run(
      async () => {
        const result = await actions.reorderTasks(
          ordered,
          task.id,
          lane,
          requestId,
        );
        requests.current.delete(key);
        return result;
      },
      {
        // A reorder changes the siblings' revisions too; their next writes need the returned etags.
        pending: next.map(pendingTask),
        predict: predictLaneOrder(lane, next),
      },
    );
    return true;
  };
}
