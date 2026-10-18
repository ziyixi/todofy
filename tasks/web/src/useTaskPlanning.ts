import { useEffect, useState } from "react";
import {
  planningDraft,
  readTaskPlanning,
  saveTaskPlanning,
  type PlanningDraft,
} from "./task-planning";
import { describeError, type Task } from "./api";

export function useTaskPlanning(task?: Task) {
  const [draft, setDraft] = useState<PlanningDraft>(planningDraft);
  const [base, setBase] = useState<PlanningDraft>();
  const [loading, setLoading] = useState(Boolean(task && !task.completed));
  const [error, setError] = useState("");
  const [readAttempt, setReadAttempt] = useState(0);
  useEffect(() => {
    if (!task || task.completed) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    void readTaskPlanning(task.id)
      .then((value) => {
        if (!active) return;
        if (!value) throw new Error("This task is not available in planning.");
        const next = planningDraft(value);
        setDraft(next);
        setBase(next);
      })
      .catch((reason: unknown) => {
        if (active) setError(describeError(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [task?.id, task?.completed, readAttempt]);
  function patch<K extends keyof PlanningDraft>(
    field: K,
    value: PlanningDraft[K],
  ) {
    setDraft((current) => ({
      ...current,
      [field]: value,
      ...((field === "stage" && value !== "none") ||
      (field === "active" && value === true)
        ? { parked: false }
        : {}),
      ...(field === "parked" && value === true
        ? { stage: "none", active: false }
        : {}),
    }));
  }
  async function save(id: string, deadline: string) {
    if (loading) throw new Error("Planning is still loading.");
    if (error) {
      const unchanged =
        JSON.stringify(draft) === JSON.stringify(planningDraft());
      if (unchanged) return;
      throw new Error(
        "Planning is unavailable. Your task was saved; retry planning when the connection is restored.",
      );
    }
    await saveTaskPlanning(id, deadline, draft, base);
    setBase(draft);
  }
  return {
    draft,
    patch,
    loading,
    error,
    save,
    retry: () => setReadAttempt((value) => value + 1),
  };
}
