import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import {
  GtdReportDaySchema,
  GtdReportSchema,
} from "@ziyixi/proto/tasks/ui/v1/gtd_pb";
import { addDays } from "@ziyixi/planning-ui/domain";
import { readableDate } from "@ziyixi/planning-ui/PlanningCalendar";
import { GtdTime } from "./GtdTime";

afterEach(cleanup);

function month() {
  return create(GtdReportSchema, {
    name: "gtdReport",
    startDay: "2026-10-01",
    endDay: "2026-10-31",
    today: "2026-10-25",
    timeZone: "America/Los_Angeles",
    recordedSeconds: 4 * 3600,
    workSeconds: 2 * 3600,
    personalSeconds: 3600,
    unassignedSeconds: 3600,
    routineRecordedSeconds: 1800,
    days: Array.from({ length: 31 }, (_, index) => {
      const day = addDays("2026-10-01", index);
      return {
        day,
        recordedSeconds: index === 0 ? 3600 : index === 11 ? 3 * 3600 : 0,
        workSeconds: index === 0 || index === 11 ? 3600 : 0,
        personalSeconds: index === 11 ? 3600 : 0,
        unassignedSeconds: index === 11 ? 3600 : 0,
      };
    }),
    tasks: [
      {
        taskId: "outcome",
        kind: "task",
        title: "Build the synthetic dashboard",
        area: "personal",
        durationMinutes: 240,
        recordedSeconds: 1800,
      },
      {
        taskId: "step-a",
        kind: "step",
        title: "Synthetic chart",
        parentId: "outcome",
        parentTitle: "Build the synthetic dashboard",
        parentDurationMinutes: 240,
        durationMinutes: 600,
        area: "personal",
        recordedSeconds: 3600,
      },
      {
        taskId: "step-b",
        kind: "step",
        title: "Synthetic navigation",
        parentId: "outcome",
        parentTitle: "Build the synthetic dashboard",
        parentDurationMinutes: 240,
        durationMinutes: 30,
        area: "personal",
        recordedSeconds: 5400,
      },
      {
        taskId: "standalone",
        kind: "task",
        title: "Synthetic exploration",
        area: "work",
        recordedSeconds: 3600,
      },
    ],
  });
}

it("shows month totals from saved areas and opens only this month's elapsed days", () => {
  const report = month();
  const onOpenDay = vi.fn();
  render(
    <GtdTime
      report={report}
      period="month"
      onOpenDay={onOpenDay}
      onOpenTask={vi.fn()}
    />,
  );
  const metrics = screen.getByLabelText("Recorded time totals");
  expect(
    within(metrics)
      .getAllByRole("definition")
      .map((node) => node.textContent),
  ).toEqual(["4h", "Tracked time only.", "2h", "1h", "1h"]);
  // All task metadata now says another area; saved records retain their original split.
  const chart = screen.getByRole("region", { name: "Daily recorded time" });
  const recordedDay = within(chart).getByRole("button", {
    name: `${readableDate("2026-10-12", "en")}: 3h recorded, Work 1h, Personal 1h, Unassigned 1h`,
  });
  expect(within(chart).getAllByRole("button")).toHaveLength(25);
  expect(chart.querySelectorAll(".plus-focus-month-day")).toHaveLength(35);
  expect(
    [...chart.querySelectorAll(".is-outside")].map((cell) => cell.textContent),
  ).toEqual(["28", "29", "30", "1"]);
  expect(
    [...chart.querySelectorAll(".is-future")].map((cell) => cell.textContent),
  ).toEqual(["26", "27", "28", "29", "30", "31"]);
  expect(
    [...chart.querySelectorAll(".is-outside, .is-future")].every(
      (cell) => cell.tagName === "SPAN",
    ),
  ).toBe(true);
  fireEvent.click(recordedDay);
  expect(onOpenDay).toHaveBeenLastCalledWith("2026-10-12");
  fireEvent.click(screen.getByRole("button", { name: "View time records" }));
  expect(onOpenDay).toHaveBeenLastCalledWith("2026-10-25");
});

it("groups Steps with their direct parent and uses the parent's estimate once", () => {
  const onOpenTask = vi.fn();
  render(
    <GtdTime
      report={month()}
      period="month"
      onOpenDay={vi.fn()}
      onOpenTask={onOpenTask}
    />,
  );
  const taskSection = screen.getByRole("region", { name: "Time by task" });
  const rows = within(taskSection).getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(rows[0]!.textContent).toBe("Build the synthetic dashboard3h4h");
  expect(rows[1]!.textContent).toBe("Synthetic exploration1hUnknown");
  expect(within(taskSection).queryByText("Synthetic chart")).toBeNull();
  expect(within(taskSection).queryByText("Synthetic navigation")).toBeNull();
  // 30m + 1h + 1h30m belongs to the one 4h parent, not the sum of its children's estimates.
  expect(
    rows[0]!.querySelector(".gtd-time-task-bar")?.getAttribute("title"),
  ).toBe("3h recorded / 4h current estimate");
  expect(rows[1]!.querySelector(".gtd-time-task-bar")).toBeNull();
  expect(within(taskSection).getByText("30m included above")).toBeTruthy();
  fireEvent.click(within(rows[0]!).getByRole("button"));
  expect(onOpenTask).toHaveBeenCalledWith("outcome");
});

it("keeps an executable Subtask's identity and estimate while only its Step rolls up", () => {
  const report = create(GtdReportSchema, {
    startDay: "2026-10-01",
    endDay: "2026-10-31",
    today: "2026-10-25",
    recordedSeconds: 3 * 3600,
    workSeconds: 3 * 3600,
    tasks: [
      {
        taskId: "parent",
        kind: "task",
        title: "Synthetic parent outcome",
        durationMinutes: 240,
        recordedSeconds: 1800,
      },
      {
        taskId: "quick-subtask",
        kind: "task",
        title: "Synthetic executable Subtask",
        parentId: "parent",
        parentTitle: "Synthetic parent outcome",
        parentDurationMinutes: 240,
        durationMinutes: 90,
        recordedSeconds: 3600,
      },
      {
        taskId: "child-step",
        kind: "step",
        title: "Synthetic child Step",
        parentId: "quick-subtask",
        parentTitle: "Synthetic executable Subtask",
        parentDurationMinutes: 90,
        durationMinutes: 30,
        recordedSeconds: 5400,
      },
    ],
  });
  const onOpenTask = vi.fn();
  render(
    <GtdTime
      report={report}
      period="month"
      onOpenDay={vi.fn()}
      onOpenTask={onOpenTask}
    />,
  );
  const taskSection = screen.getByRole("region", { name: "Time by task" });
  const rows = within(taskSection).getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(rows[0]!.textContent).toBe("Synthetic executable Subtask2h 30m1h 30m");
  expect(rows[1]!.textContent).toBe("Synthetic parent outcome30m4h");
  expect(within(taskSection).queryByText("Synthetic child Step")).toBeNull();
  fireEvent.click(within(rows[0]!).getByRole("button"));
  expect(onOpenTask).toHaveBeenLastCalledWith("quick-subtask");
  fireEvent.click(within(rows[1]!).getByRole("button"));
  expect(onOpenTask).toHaveBeenLastCalledWith("parent");
});

it("shows all seven week's saved-area bars and keeps future days inactive", () => {
  const report = create(GtdReportSchema, {
    ...month(),
    startDay: "2026-10-12",
    endDay: "2026-10-18",
    today: "2026-10-14",
    recordedSeconds: 7200,
    workSeconds: 3600,
    personalSeconds: 1800,
    unassignedSeconds: 1800,
    days: Array.from({ length: 7 }, (_, index) =>
      create(GtdReportDaySchema, {
        day: addDays("2026-10-12", index),
        recordedSeconds: index === 0 ? 5400 : index === 1 ? 1800 : 0,
        workSeconds: index === 0 ? 3600 : 0,
        personalSeconds: index === 0 ? 1800 : 0,
        unassignedSeconds: index === 1 ? 1800 : 0,
      }),
    ),
  });
  const onOpenDay = vi.fn();
  render(
    <GtdTime
      report={report}
      period="week"
      onOpenDay={onOpenDay}
      onOpenTask={vi.fn()}
    />,
  );
  const metrics = screen.getByLabelText("Recorded time totals");
  expect(
    within(metrics)
      .getAllByRole("definition")
      .map((node) => node.textContent),
  ).toEqual(["2h", "Tracked time only.", "1h", "30m", "30m"]);
  const chart = screen.getByRole("region", { name: "Daily recorded time" });
  const bars = within(chart).getAllByRole("button");
  expect(bars).toHaveLength(7);
  const monday = within(chart).getByRole("button", {
    name: `${readableDate("2026-10-12", "en")}: 1h 30m recorded, Work 1h, Personal 30m`,
  });
  expect(
    within(chart).getByRole("button", {
      name: `${readableDate("2026-10-13", "en")}: 30m recorded, Unassigned 30m`,
    }),
  ).toBeTruthy();
  fireEvent.click(monday);
  expect(onOpenDay).toHaveBeenLastCalledWith("2026-10-12");
  expect(
    bars.slice(3).every((bar) => (bar as HTMLButtonElement).disabled),
  ).toBe(true);
  fireEvent.click(bars[6]!);
  expect(onOpenDay).toHaveBeenCalledOnce();
});

it("keeps complete totals visible when task context is truncated and links a past period to its final day", () => {
  const report = month();
  report.tasks = report.tasks.slice(0, 1);
  report.tasksTruncated = true;
  report.today = "2026-11-10";
  const onOpenDay = vi.fn();
  render(
    <GtdTime
      report={report}
      period="month"
      onOpenDay={onOpenDay}
      onOpenTask={vi.fn()}
    />,
  );
  const metrics = screen.getByLabelText("Recorded time totals");
  expect(within(metrics).getByText("4h")).toBeTruthy();
  expect(
    screen.getByText(
      "Task details are limited. Totals include all recorded time.",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "View time records" }));
  expect(onOpenDay).toHaveBeenCalledWith("2026-10-31");
});
