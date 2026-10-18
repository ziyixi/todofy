import { useEffect, useMemo, useState } from "react";
import {
  PlanningApp,
  createPlanningActions,
  type PlusSnapshot,
} from "@ziyixi/planning-ui";
import "@ziyixi/planning-ui/styles.css";
import { api, send } from "./api";
import { removeQueryParameter } from "./routes";
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
        refreshRevision={mutationRevision}
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
