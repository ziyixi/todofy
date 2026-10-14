import { expect, it } from "vitest";
import { planningFixture } from "../design/planning-fixture";
import {
  moveOutcome,
  moveStep,
  shiftWeek,
  weekDates,
} from "../design/planning-model";

it("moving an outcome lane preserves its steps, deadline and existing day queues", () => {
  const data = planningFixture();
  const before = structuredClone(data);
  const result = moveOutcome(data, "website", "month");
  expect(result.outcomes.find((outcome) => outcome.id === "website")).toEqual({
    ...before.outcomes.find((outcome) => outcome.id === "website"),
    lane: "month",
  });
  expect(result.outcomes.filter((outcome) => outcome.id !== "website")).toEqual(
    before.outcomes.filter((outcome) => outcome.id !== "website"),
  );
  expect(result.queues).toEqual(before.queues);
  expect(result.weeklyGoals).toEqual(before.weeklyGoals);
  expect(data).toEqual(before);
});

it("moving and reordering steps preserves outcome lanes and deadlines", () => {
  const data = planningFixture();
  const before = structuredClone(data);
  const moved = moveStep(
    data,
    "website-1",
    "2026-10-14",
    "2026-10-13",
    "website-2",
  );
  expect(moved.queues["2026-10-13"]).toEqual(["research-1", "desk-1"]);
  expect(moved.queues["2026-10-14"]).toEqual([
    "notes-1",
    "website-1",
    "website-2",
  ]);
  const reordered = moveStep(
    moved,
    "website-2",
    "2026-10-14",
    "2026-10-14",
    "website-1",
  );
  expect(reordered.queues["2026-10-14"]).toEqual([
    "notes-1",
    "website-2",
    "website-1",
  ]);
  expect(reordered.outcomes).toEqual(before.outcomes);
  expect(reordered.weeklyGoals).toEqual(before.weeklyGoals);
  expect(reordered.queues["2026-10-12"]).toEqual(before.queues["2026-10-12"]);
  expect(reordered.queues["2026-10-17"]).toEqual(before.queues["2026-10-17"]);
  expect(data).toEqual(before);
});

it("repeated drops and a drop onto itself do not duplicate a queued step", () => {
  const data = planningFixture();
  const first = moveStep(
    data,
    "website-1",
    "2026-10-14",
    "2026-10-13",
    "website-2",
  );
  const repeated = moveStep(
    first,
    "website-1",
    "2026-10-14",
    "2026-10-13",
    "website-2",
  );
  expect(repeated).toEqual(first);
  expect(
    repeated.queues["2026-10-14"]!.filter((id) => id === "website-1"),
  ).toHaveLength(1);
  expect(
    moveStep(repeated, "website-1", "2026-10-14", "2026-10-14", "website-1"),
  ).toEqual(repeated);
});

it("week shifts produce seven consecutive dates across a year boundary", () => {
  expect(weekDates("2026-12-28")).toEqual([
    "2026-12-28",
    "2026-12-29",
    "2026-12-30",
    "2026-12-31",
    "2027-01-01",
    "2027-01-02",
    "2027-01-03",
  ]);
  expect(shiftWeek("2026-12-28", 1)).toBe("2027-01-04");
  expect(shiftWeek(shiftWeek("2026-12-28", -1), 1)).toBe("2026-12-28");
});
