import type { HttpSend } from "@ziyixi/proto/http-client";
import { createPlanningActions, type KnownTaskStore } from "../src/api";

/**
 * The planning actions over one fake fetch, at the paths Tasks' same-origin proxy uses: Plus at
 * `/api/plus/v1/…` and FlowDay under `/api/plus/flowday`.
 */
export function fakeActions(
  fetcher: (input: URL, init: RequestInit) => Promise<Response>,
  provider: "todoist" | "tasks" = "tasks",
  knownStore?: KnownTaskStore,
) {
  const transport =
    (prefix: string): HttpSend =>
    (call) =>
      fetcher(new URL(prefix + call.url, "https://tasks.example.test"), {
        method: call.httpMethod,
        body: call.body,
      });
  return createPlanningActions(
    { plus: transport(""), flowday: transport("/api/plus/flowday") },
    knownStore,
    provider,
  );
}
