import { useEffect, useState } from "react";
import {
  DEFAULT_PLAN_VIEW,
  mergePlanView,
  planViewState,
  type PlanViewPatch,
  type PlanViewState,
} from "@ziyixi/planning-ui/plan-view-state";

const STORAGE_KEY = "tasks.plan-view";

function readPlanView(): PlanViewState {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return (saved && planViewState(JSON.parse(saved))) || DEFAULT_PLAN_VIEW;
  } catch {
    return DEFAULT_PLAN_VIEW;
  }
}

export function usePlanView() {
  const [view, setView] = useState(readPlanView);
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(view));
    } catch {
      // A blocked or full browser store does not prevent planning in this visit.
    }
  }, [view]);
  function updateView(patch: PlanViewPatch) {
    setView((current) => mergePlanView(current, patch));
  }
  return [view, updateView] as const;
}
