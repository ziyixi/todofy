import { useEffect, useState } from "react";
import {
  planningDraft,
  peekTaskPlanning,
  readCachedTaskPlanning,
  saveTaskPlanning,
  type PlanningDraft,
} from "./task-planning";
import { describeError, type Task } from "./api";
import { clearDetailReadCache } from "./detail-read-cache";

export function useTaskPlanning(task?: Task) {
  const known = task && !task.completed ? peekTaskPlanning(task) : undefined;
  const [draft, setDraft] = useState<PlanningDraft>(() => planningDraft(known));
  const [base, setBase] = useState<PlanningDraft | undefined>(() =>
    known ? planningDraft(known) : undefined,
  );
  const [loading, setLoading] = useState(
    Boolean(task && !task.completed && !known),
  );
  const [error, setError] = useState("");
  const [readAttempt, setReadAttempt] = useState(0);
  useEffect(() => {
    if (!task || task.completed) {
      setLoading(false);
      return;
    }
    let active = true;
    const cached = peekTaskPlanning(task);
    setLoading(!cached);
    setError("");
    if (cached) {
      const next = planningDraft(cached);
      setDraft(next);
      setBase(next);
      return;
    }
    void readCachedTaskPlanning(task)
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
  }, [task?.id, task?.etag, task?.completed, readAttempt]);
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
    const dirty =
      JSON.stringify(draft) !== JSON.stringify(base || planningDraft());
    if (error) {
      if (!dirty) return false;
      throw new Error(
        "Planning is unavailable. Your task was saved; retry planning when the connection is restored.",
      );
    }
    await saveTaskPlanning(id, deadline, draft, base);
    setBase(draft);
    return dirty;
  }
  return {
    draft,
    patch,
    loading,
    error,
    save,
    retry: () => {
      clearDetailReadCache();
      setReadAttempt((value) => value + 1);
    },
  };
}
