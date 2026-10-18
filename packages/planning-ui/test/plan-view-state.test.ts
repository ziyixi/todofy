import { expect, it } from "vitest";
import {
  DEFAULT_PLAN_VIEW,
  mergePlanView,
  planViewPatch,
  planViewState,
  type PlanViewState,
} from "../src/plan-view-state";

const stored: PlanViewState = {
  tab: "week",
  area: "personal",
  review: {
    week: "2026-10-12",
    open: true,
    lines: [1, 6],
    kept: ["task-1", "Task_2"],
  },
  commitment: "outcome-1",
  committedFolded: true,
};

it("accepts the whole view, with or without a commitment, and any part of it as a patch", () => {
  expect(planViewState(stored)).toEqual(stored);
  expect(planViewState(DEFAULT_PLAN_VIEW)).toEqual(DEFAULT_PLAN_VIEW);
  expect(planViewState({ ...stored, commitment: "" })).toBeTruthy();
  expect(planViewPatch({ committedFolded: false })).toEqual({
    committedFolded: false,
  });
  expect(planViewPatch({ tab: "review", commitment: "" })).toBeTruthy();
  expect(planViewPatch({})).toEqual({});
  // A patch is not a whole view.
  expect(planViewState({ committedFolded: false })).toBeUndefined();
});

it("refuses every value outside its bounds and every unknown key", () => {
  const review = stored.review;
  const refused: unknown[] = [
    { tab: "focus" },
    { area: "family" },
    { committedFolded: "yes" },
    { commitment: "has space" },
    { commitment: "x".repeat(101) },
    { commitment: 7 },
    { review: { ...review, week: "2026-W42" } },
    { review: { ...review, open: "true" } },
    { review: { ...review, lines: [0] } },
    { review: { ...review, lines: [7] } },
    { review: { ...review, lines: [1.5] } },
    { review: { ...review, lines: [2, 2] } },
    { review: { ...review, lines: [1, 2, 3, 4, 5, 6, 1] } },
    { review: { ...review, kept: ["a/b"] } },
    { review: { ...review, kept: ["a", "a"] } },
    {
      review: {
        ...review,
        kept: Array.from({ length: 201 }, (_, index) => `t${index}`),
      },
    },
    { review: { ...review, title: "Synthetic task title" } },
    { review: { week: "", open: false, lines: [] } },
    { title: "Synthetic task title" },
    null,
    [],
    "week",
  ];
  for (const value of refused) {
    expect(planViewPatch(value), JSON.stringify(value)).toBeUndefined();
    expect(planViewState(value)).toBeUndefined();
  }
  expect(planViewState({ ...stored, extra: true })).toBeUndefined();
  // The limits themselves are accepted.
  expect(
    planViewPatch({
      review: {
        week: "",
        open: false,
        lines: [1, 2, 3, 4, 5, 6],
        kept: Array.from({ length: 200 }, (_, index) => `t${index}`),
      },
      commitment: "x".repeat(100),
    }),
  ).toBeTruthy();
});

it("merges a patch key by key and ignores an earlier week's review", () => {
  expect(mergePlanView(stored, { tab: "review" })).toEqual({
    ...stored,
    tab: "review",
  });
  const nextWeek = { week: "2026-10-19", open: false, lines: [], kept: [] };
  expect(mergePlanView(stored, { review: nextWeek })).toEqual({
    ...stored,
    review: nextWeek,
  });
  // A tab still showing last week never overwrites this week's ticks; its other fields count.
  expect(
    mergePlanView(stored, {
      review: { week: "2026-10-05", open: true, lines: [2], kept: [] },
      committedFolded: false,
    }),
  ).toEqual({ ...stored, committedFolded: false });
  // The default's empty week is earlier than any.
  expect(
    mergePlanView(DEFAULT_PLAN_VIEW, { review: stored.review }).review,
  ).toEqual(stored.review);
});
