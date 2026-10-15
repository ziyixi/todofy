import type { Connection } from "./api";
import type { PlusActions } from "./model";
export const PLANNING_PROTOCOL = 3;
export type ActionName = keyof PlusActions;
export type ActionMessage = {
  [Key in ActionName]: {
    kind: "action";
    protocol: typeof PLANNING_PROTOCOL;
    method: Key;
    args: Parameters<PlusActions[Key]>;
  };
}[ActionName];
export type BackgroundMessage =
  | ActionMessage
  | { kind: "connect"; connection: Connection }
  | { kind: "connection" }
  | { kind: "disconnect" }
  | { kind: "options" };
export type Result<T = unknown> =
  { ok: true; value: T } | { ok: false; error: string };
