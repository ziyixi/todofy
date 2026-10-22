import { useState } from "react";
import { planningDraft, type PlanningDraft } from "./task-planning";
import type { Task } from "./api";
import type { ExecutionMode } from "@ziyixi/planning-ui/ExecutionFields";

/** The dialog's planning draft, from the task as GetTask answered it; it is saved with the task. */
export function useTaskPlanning(task?: Task) {
  const [draft, setDraft] = useState<PlanningDraft>(() => planningDraft(task));
  function patch<K extends keyof PlanningDraft>(
    field: K,
    value: PlanningDraft[K],
  ) {
    setDraft((current) => ({
      ...current,
      [field]: value,
      ...(field === "quick" && value === true ? { singleAction: true } : {}),
      ...((field === "stage" && value !== "none") ||
      (field === "active" && value === true)
        ? { parked: false }
        : {}),
      ...(field === "parked" && value === true
        ? { stage: "none", active: false }
        : {}),
    }));
  }
  function setExecution(mode: ExecutionMode) {
    setDraft((current) => ({
      ...current,
      singleAction: mode !== "steps",
      quick: mode === "quick",
    }));
  }
  return { draft, setDraft, patch, setExecution };
}
