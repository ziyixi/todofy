import { useMemo, useState } from "react";
import {
  PlanningApp,
  createPlanningActions,
  type PlusActions,
  type PlusSnapshot,
} from "@ziyixi/planning-ui";
import "@ziyixi/planning-ui/styles.css";
import { api, send } from "./api";
import type { CompletedTask } from "./useTaskActions";
import { usePlanView } from "./usePlanView";

/** Focus' Pause when away, a setting of this device like Plan's view: "on", or absent for off. */
const IDLE_PAUSE_KEY = "tasks.idle-pause";
export function readIdlePause(): boolean {
  try {
    return window.localStorage.getItem(IDLE_PAUSE_KEY) === "on";
  } catch {
    return false;
  }
}

export default function PlanningPage({
  page,
  background = false,
  onSession,
  review,
  refreshRevision,
  onOpenTask,
  onSettings,
  onCompleteTask,
}: {
  page: "plan" | "focus";
  /** Another page shows: only the Focus mini timer, if open, stays, with what keeps it current. */
  background?: boolean;
  /** Whether a Focus session exists; while one does, App keeps this page mounted behind other pages. */
  onSession?: (active: boolean) => void;
  /** Each new positive value opens Plan's weekly review checklist (the review link, App's reviewRequest). */
  review: number;
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
    // Tasks' own planning, Focus and weekly review API, on this origin.
    // Both writes go under the etag Plan holds, with no read first.
    const actions = createPlanningActions({ tasks: send });
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
  const [snapshot, setSnapshot] = useState<PlusSnapshot>();
  const [planView, updatePlanView] = usePlanView();
  const [idlePause, setIdlePause] = useState(readIdlePause);
  function changeIdlePause(on: boolean) {
    setIdlePause(on);
    try {
      if (on) window.localStorage.setItem(IDLE_PAUSE_KEY, "on");
      else window.localStorage.removeItem(IDLE_PAUSE_KEY);
    } catch {
      // A blocked browser store keeps the setting for this visit only.
    }
  }
  return (
    <div className="planning-ui">
      <PlanningApp
        actions={actions}
        refreshRevision={refreshRevision}
        review={review}
        view={page}
        background={background}
        onSession={onSession}
        language="en"
        onOpenTask={onOpenTask}
        onSettings={onSettings}
        onViewChange={(view) => {
          window.location.hash = `/${view}`;
        }}
        onOpenMail={() => {
          window.location.hash = "/mail";
        }}
        onOpenGtd={() => {
          window.location.hash = "/gtd";
        }}
        snapshot={snapshot}
        onSnapshot={setSnapshot}
        planView={planView}
        onPlanView={updatePlanView}
        idlePause={idlePause}
        onIdlePause={changeIdlePause}
      />
    </div>
  );
}
