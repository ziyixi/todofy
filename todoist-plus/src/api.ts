import {
  createPlanningActions,
  type KnownTaskStore,
} from "@ziyixi/planning-ui/api";
import type { HttpSend } from "@ziyixi/proto/http-client";
export { planningTask, publicError } from "@ziyixi/planning-ui/api";
export type { KnownTaskStore } from "@ziyixi/planning-ui/api";

export interface Connection {
  apiOrigin: string;
  token: string;
}
export function validOrigin(input: string): string {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  )
    throw new Error("Enter an HTTPS origin, without a path.");
  return url.origin;
}

export function createApi(
  connection: Connection,
  fetcher: typeof fetch = fetch,
  knownStore?: KnownTaskStore,
) {
  const transport =
    (prefix: string): HttpSend =>
    async (call) => {
      const url = new URL(prefix + call.url, connection.apiOrigin);
      if (url.origin !== validOrigin(connection.apiOrigin))
        throw new Error("Invalid API origin");
      return fetcher(url, {
        method: call.httpMethod,
        body: call.body,
        credentials: "omit",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${connection.token}`,
          ...(call.body ? { "Content-Type": "application/json" } : {}),
        },
      });
    };
  return createPlanningActions(
    { plus: transport(""), flowday: transport("/api/plus/flowday") },
    knownStore,
  );
}
