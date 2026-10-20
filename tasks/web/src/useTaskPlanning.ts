import { useState } from "react";
import { planningDraft, type PlanningDraft } from "./task-planning";
import type { Task } from "./api";

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
  return { draft, setDraft, patch };
}
