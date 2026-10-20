import { useEffect, useMemo, useState } from "react";
import {
  PlanningApp,
  createPlanningActions,
  type PlusActions,
  type PlusSnapshot,
} from "@ziyixi/planning-ui";
import "@ziyixi/planning-ui/styles.css";
import { api, send } from "./api";
import type { CompletedTask } from "./useTaskActions";
import { removeQueryParameter } from "./routes";
import { usePlanView } from "./usePlanView";

export default function PlanningPage({
  page,
  refreshRevision,
  onOpenTask,
  onSettings,
  onCompleteTask,
}: {
  page: "plan" | "focus";
  /** Changes after each task write Plan did not issue (useTaskActions' planRevision). */
  refreshRevision: number;
  onOpenTask: (id: string) => void;
  onSettings: () => void;
  /** Completes in Tasks, which settles `focusDay`'s Focus queue in the same write. */
  onCompleteTask: (
    task: CompletedTask,
    requestId: string,
    focusDay?: string,
  ) => Promise<string | undefined>;
}) {
  const actions = useMemo<PlusActions>(() => {
    // Tasks' own planning and Focus API, and Todofy's weekly review facts, both on this origin.
    // Both writes go under the etag Plan holds, with no read first.
    const actions = createPlanningActions({ plus: send, tasks: send });
    return {
      ...actions,
      async completeTask(task, requestId, focusDay) {
        const error = await onCompleteTask(
          { id: task.id, name: `tasks/${task.id}`, etag: task.etag },
          requestId,
          focusDay,
        );
        if (error) throw new Error(error);
      },
      // Answers the duration Tasks saved and the task's new etag, which Plan and Focus merge
      // without reading again.
      async updateEstimate(task, minutes) {
        const saved = await api.updateTask({
          requestId: crypto.randomUUID(),
          etag: task.etag,
          task: { name: `tasks/${task.id}`, durationMinutes: minutes },
          updateMask: { paths: ["duration_minutes"] },
        });
        return {
          estimate: { taskId: task.id, minutes: saved.durationMinutes },
          etag: saved.etag,
        };
      },
    };
  }, [onCompleteTask]);
  // The weekly review link opens the checklist once; a reload or a later visit to Plan does not.
  const [review] = useState(
    () => new URLSearchParams(window.location.search).get("review") === "1",
  );
  useEffect(() => removeQueryParameter("review"), []);
  const [snapshot, setSnapshot] = useState<PlusSnapshot>();
  const [planView, updatePlanView] = usePlanView();
  return (
    <div className="planning-ui">
      <PlanningApp
        actions={actions}
        refreshRevision={refreshRevision}
        review={review}
        view={page}
        language="en"
        onOpenTask={onOpenTask}
        onSettings={onSettings}
        onViewChange={(view) => {
          window.location.hash = `/${view}`;
        }}
        onOpenMail={() => {
          window.location.hash = "/mail";
        }}
        snapshot={snapshot}
        onSnapshot={setSnapshot}
        planView={planView}
        onPlanView={updatePlanView}
      />
    </div>
  );
}
