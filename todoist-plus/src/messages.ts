import type { Connection } from "./api";
import type { BetNotSaved } from "./bets";
import type { PlusActions } from "./model";
import type { PageStatus } from "./page-status";
import type { PlanViewPatch } from "./plan-view-state";
export const PLANNING_PROTOCOL = 6;
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
  | { kind: "options" }
  | { kind: "planConfig" }
  // Reads Other views' saved open state, or saves it when `open` is given.
  | { kind: "otherViews"; open?: boolean }
  // Reads Plan's remembered view, or merges `patch` into it and answers the merged state.
  | { kind: "planView"; patch?: PlanViewPatch }
  | { kind: "reportPage"; status: PageStatus }
  | { kind: "pageStatus" };
export type Result<T = unknown> =
  { ok: true; value: T } | { ok: false; error: string };
/** setWeeklyBet's answer when Todofy did not save it; the page throws it again as BetNotSaved. */
export type NotSaved = { notSaved: BetNotSaved["reason"] };
