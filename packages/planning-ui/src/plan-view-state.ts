import type { Area } from "./model";

/**
 * What Plan shows, remembered in storage.local through the background (kind "planView") so that
 * it survives leaving Plan, browser Back and a reload. IDs and line numbers only.
 */
export interface PlanViewState {
  tab: "review" | "week";
  /** Review's area filter. */
  area: Area | "all";
  /**
   * The weekly review of one account week (its Monday): open or not, the ticked lines and the
   * someday tasks kept.
   */
  review: { week: string; open: boolean; lines: number[]; kept: string[] };
  /** Week's selected commitment: absent for the first one, "" for none. */
  commitment?: string;
  /** Week › Committed is folded. */
  committedFolded: boolean;
}
export type PlanViewPatch = Partial<PlanViewState>;

export const DEFAULT_PLAN_VIEW: PlanViewState = {
  tab: "review",
  area: "all",
  review: { week: "", open: false, lines: [], kept: [] },
  committedFolded: false,
};

// The review's lines are numbered 1 to 6; kept tasks are Todoist task IDs.
const LINES = 6;
const MAX_KEPT = 200;
const ID = /^[A-Za-z0-9_-]{1,100}$/u;
const WEEK = /^(\d{4}-\d{2}-\d{2})?$/u;
const AREAS: readonly unknown[] = ["all", "work", "personal", "unassigned"];

const isId = (value: unknown) => typeof value === "string" && ID.test(value);
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** At most `max` distinct items, each valid. */
function distinct(
  value: unknown,
  max: number,
  valid: (item: unknown) => boolean,
) {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    new Set(value).size === value.length &&
    value.every(valid)
  );
}
function validReview(value: unknown) {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join() === "kept,lines,open,week" &&
    typeof value.week === "string" &&
    WEEK.test(value.week) &&
    typeof value.open === "boolean" &&
    distinct(
      value.lines,
      LINES,
      (line) =>
        Number.isInteger(line) && 1 <= Number(line) && Number(line) <= LINES,
    ) &&
    distinct(value.kept, MAX_KEPT, isId)
  );
}
const FIELDS: Record<keyof PlanViewState, (value: unknown) => boolean> = {
  tab: (value) => value === "review" || value === "week",
  area: (value) => AREAS.includes(value),
  review: validReview,
  commitment: (value) => value === "" || isId(value),
  committedFolded: (value) => typeof value === "boolean",
};

/** The value if it has exactly this shape within these bounds, else undefined. */
export function planViewState(value: unknown): PlanViewState | undefined {
  const patch = planViewPatch(value);
  return patch &&
    patch.tab !== undefined &&
    patch.area !== undefined &&
    patch.review !== undefined &&
    patch.committedFolded !== undefined
    ? (patch as PlanViewState)
    : undefined;
}

/** The same for a patch: only known keys, each within its bounds. */
export function planViewPatch(value: unknown): PlanViewPatch | undefined {
  if (!isRecord(value)) return undefined;
  const valid = Object.entries(value).every(
    ([key, field]) =>
      Object.hasOwn(FIELDS, key) && FIELDS[key as keyof PlanViewState](field),
  );
  return valid ? (value as PlanViewPatch) : undefined;
}

/**
 * `state` with `patch` applied: each present key replaces the stored one, except a `review` of an
 * earlier week than the stored one, which is ignored (a stale tab never overwrites this week).
 */
export function mergePlanView(
  state: PlanViewState,
  patch: PlanViewPatch,
): PlanViewState {
  const stale =
    patch.review !== undefined && patch.review.week < state.review.week;
  return stale
    ? { ...state, ...patch, review: state.review }
    : { ...state, ...patch };
}
