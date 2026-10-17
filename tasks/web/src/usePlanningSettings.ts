import { useCallback, useEffect, useState } from "react";
import { createHttpClient } from "@ziyixi/proto/http-client";
import { create } from "@ziyixi/proto/protobuf";
import type { PlanState } from "@ziyixi/planning-ui";
import {
  PlusService,
  PlanView,
  PlanSchema,
  type Plan,
} from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";
import { describeError, send } from "./api";

export const planningApi = createHttpClient(PlusService, send);
/** One bounded native-source read per session, then explicit configuration refreshes. */
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
  const accept = useCallback((value?: PlanState) => {
    if (!value) return;
    setError("");
    setPlan((current) => {
      if (current?.etag === value.etag && current.enabled === value.configured)
        return current;
      return create(PlanSchema, {
        etag: value.etag,
        enabled: value.configured,
        timezone: value.timezone,
        weekStart: value.week,
        labels: value.managedLabels,
        availableLabels: value.availableLabels,
        hiddenFilterIds: value.hiddenFilterIds,
        missingLabels: value.configured ? [] : current?.missingLabels,
        today: current?.today,
      });
    });
  }, []);
  return { plan, setPlan, loading, error, load, accept };
}
