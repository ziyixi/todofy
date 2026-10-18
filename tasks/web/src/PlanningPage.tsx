import { useMemo, useState } from "react";
import {
  PlanningApp,
  createPlanningActions,
  type PlusSnapshot,
} from "@ziyixi/planning-ui";
import "@ziyixi/planning-ui/styles.css";
import { api, send } from "./api";
import { usePlanView } from "./usePlanView";

export default function PlanningPage({
  page,
  mutationRevision,
  onOpenTask,
  onSettings,
}: {
  page: "plan" | "focus";
  mutationRevision: number;
  onOpenTask: (id: string) => void;
  onSettings: () => void;
}) {
  const actions = useMemo(() => {
    const actions = createPlanningActions(
      {
        plus: send,
        flowday: (call) =>
          send({ ...call, url: `/api/plus/flowday${call.url}` }),
      },
      undefined,
      "tasks",
    );
    return {
      ...actions,
      async updateEstimate(id: string, minutes: number) {
        const task = await api.getTask({ name: `tasks/${id}` });
        await api.updateTask({
          requestId: crypto.randomUUID(),
          etag: task.etag,
          task: { name: task.name, durationMinutes: minutes },
          updateMask: { paths: ["duration_minutes"] },
        });
      },
    };
  }, []);
  const [snapshot, setSnapshot] = useState<PlusSnapshot>();
  const [planView, updatePlanView] = usePlanView();
  return (
    <div className="planning-ui">
      <PlanningApp
        actions={actions}
        refreshRevision={mutationRevision}
        review={
          new URLSearchParams(window.location.search).get("review") === "1"
        }
        view={page}
        language="en"
        onOpenTask={onOpenTask}
        onSettings={onSettings}
        onViewChange={(view) => {
          window.location.hash = `/${view === "mailbox" ? "mail" : view}`;
        }}
        destination={{
          name: "Tasks",
          taskHref: (id) =>
            `${window.location.origin}/?task=${encodeURIComponent(id)}`,
          projectHref: (id) => `#/project/${encodeURIComponent(id)}`,
        }}
        snapshot={snapshot}
        onSnapshot={setSnapshot}
        planView={planView}
        onPlanView={updatePlanView}
      />
    </div>
  );
}
