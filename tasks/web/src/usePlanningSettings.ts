import { useCallback, useEffect, useState } from "react";
import { createHttpClient } from "@ziyixi/proto/http-client";
import {
  PlusService,
  PlanView,
  type Plan,
} from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";
import { describeError, send } from "./api";

const planningApi = createHttpClient(PlusService, send);
/** Read planning metadata when its settings page opens, and on an explicit refresh. */
export function usePlanningSettings() {
  const [plan, setPlan] = useState<Plan>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await planningApi.readPlan({ view: PlanView.BASIC });
      setPlan(result.plan);
    } catch (reason) {
      setPlan(undefined);
      setError(describeError(reason));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { plan, loading, error, load };
}
