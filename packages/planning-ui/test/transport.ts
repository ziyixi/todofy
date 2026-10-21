import type { HttpSend } from "@ziyixi/proto/http-client";
import { createPlanningActions } from "../src/api";

/** The planning actions over one fake fetch, at the paths Tasks serves them on its own origin (`/api/tasks/v1/…`). */
export function fakeActions(
  fetcher: (input: URL, init: RequestInit) => Promise<Response>,
) {
  const transport: HttpSend = (call) =>
    fetcher(new URL(call.url, "https://tasks.example.test"), {
      method: call.httpMethod,
      body: call.body,
    });
  return createPlanningActions({ tasks: transport });
}
