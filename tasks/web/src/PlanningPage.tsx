import { useMemo, useState } from "react";
import {
  PlanningApp,
  createPlanningActions,
  type PlusSnapshot,
  type PlanState,
} from "@ziyixi/planning-ui";
import "@ziyixi/planning-ui/styles.css";
import { send } from "./api";
import { usePlanView } from "./usePlanView";

export default function PlanningPage({
  page,
  mutationRevision,
  onOpenTask,
  onSettings,
  onReady,
}: {
  page: "plan" | "focus" | "mail";
  mutationRevision: number;
  onOpenTask: (id: string) => void;
  onSettings: () => void;
  onReady: (plan?: PlanState) => void;
}) {
  const actions = useMemo(
    () =>
      createPlanningActions(
        {
          plus: send,
          flowday: (call) =>
            send({ ...call, url: `/api/plus/flowday${call.url}` }),
        },
        undefined,
        "tasks",
      ),
    [],
  );
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
        view={page === "mail" ? "mailbox" : page}
        language="en"
        onOpenTask={onOpenTask}
        onSettings={onSettings}
        onReady={onReady}
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
