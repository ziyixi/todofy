import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import {
  GtdReportSchema,
  GtdTaskProgressSchema,
} from "@ziyixi/proto/tasks/ui/v1/gtd_pb";
import type { GtdReport } from "@ziyixi/proto/tasks/ui/v1/gtd_pb";
import { api } from "./api";
import GtdPage from "./GtdPage";
import { dateRangeLabel, reportRange } from "./gtd/model";

const props = {
  selectedTab: "overview",
  timeZone: "America/Los_Angeles",
  refreshRevision: 0,
  onOpenTask: vi.fn(),
  onOpenDay: vi.fn(),
};
function report(
  startDay = "2026-10-25",
  endDay = "2026-10-31",
  area = "",
): GtdReport {
  return create(GtdReportSchema, {
    name: "gtdReport",
    startDay,
    endDay,
    today: "2026-10-25",
    timeZone: "America/Los_Angeles",
    area,
    taskCompletionCount: 5,
    stepCompletionCount: 18,
    plannedTaskCount: 8,
    completedPlannedTaskCount: 5,
    taskPlanHistoryComplete: true,
    plannedStepCount: 24,
    completedPlannedStepCount: 18,
    recordedSeconds: 3600,
    workSeconds: 2700,
    personalSeconds: 900,
    tasks: [
      create(GtdTaskProgressSchema, {
        taskId: "parent",
        title: "Synthetic weekly outcome",
        kind: "task",
        area: "work",
        planned: true,
        stepCount: 3,
        completedStepCount: 1,
      }),
      create(GtdTaskProgressSchema, {
        taskId: "step",
        title: "Synthetic concrete next step",
        kind: "step",
        parentId: "parent",
        parentTitle: "Synthetic weekly outcome",
        planned: true,
      }),
      create(GtdTaskProgressSchema, {
        taskId: "routine",
        title: "Synthetic routine",
        kind: "task",
        routine: true,
        completionCount: 2,
        completed: true,
      }),
    ],
    routineCompletionCount: 2,
  });
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-25T19:00:00Z"));
  vi.spyOn(api, "getGtdReport").mockImplementation(async (input) =>
    report(input.startDay, input.endDay, input.area),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("keeps one period read while tabs change, with Routine separate and no mail cleanup or re-planning", async () => {
  const view = render(<GtdPage {...props} />);
  await screen.findByText("Synthetic weekly outcome");
  expect(api.getGtdReport).toHaveBeenCalledTimes(1);
  expect(
    screen
      .getByRole("progressbar", { name: "Committed Tasks completion" })
      ?.getAttribute("value"),
  ).toBe("5");
  expect(screen.getByText("Synthetic routine").closest("details")?.open).toBe(
    false,
  );
  expect(
    screen.queryByText(
      /Inbox open|Decide again|Review in Plan|Oldest in Inbox/,
    ),
  ).toBeNull();
  view.rerender(<GtdPage {...props} selectedTab="completion" />);
  expect(
    screen
      .getByRole("tab", { name: "Completion" })
      ?.getAttribute("aria-selected"),
  ).toBe("true");
  expect(
    screen.getByText("Synthetic concrete next step").closest("details")?.open,
  ).toBe(false);
  const details = view.container.querySelector(".gtd-progress-details")!;
  fireEvent.click(details.querySelector("summary")!);
  expect(
    screen.getByText("Synthetic concrete next step").closest("details")?.open,
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Synthetic concrete next step" }),
  );
  expect(props.onOpenTask).toHaveBeenCalledWith("step");
  view.rerender(<GtdPage {...props} selectedTab="time" />);
  expect(
    screen.getByRole("tab", { name: "Time" })?.getAttribute("aria-selected"),
  ).toBe("true");
  expect(api.getGtdReport).toHaveBeenCalledTimes(1);
});

it("uses server-filtered period totals and keeps date and area when switching tabs", async () => {
  const view = render(<GtdPage {...props} />);
  await screen.findByText("Synthetic weekly outcome");
  fireEvent.click(screen.getByRole("button", { name: "Month" }));
  await waitFor(() =>
    expect(api.getGtdReport).toHaveBeenLastCalledWith({
      name: "gtdReport",
      startDay: "2026-10-01",
      endDay: "2026-10-31",
      area: "",
    }),
  );
  fireEvent.change(screen.getByRole("combobox", { name: "GTD area" }), {
    target: { value: "personal" },
  });
  await waitFor(() =>
    expect(api.getGtdReport).toHaveBeenLastCalledWith({
      name: "gtdReport",
      startDay: "2026-10-01",
      endDay: "2026-10-31",
      area: "personal",
    }),
  );
  await waitFor(() =>
    expect(
      view.container.querySelector(".gtd-panel")?.getAttribute("aria-busy"),
    ).toBe("false"),
  );
  const calls = vi.mocked(api.getGtdReport).mock.calls.length;
  view.rerender(<GtdPage {...props} selectedTab="completion" />);
  expect(
    screen.getByRole("button", { name: "Month" })?.getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    (screen.getByRole("combobox", { name: "GTD area" }) as HTMLSelectElement)
      .value,
  ).toBe("personal");
  expect(api.getGtdReport).toHaveBeenCalledTimes(calls);
});

it("keeps the rendered task node during refresh and never replaces a newer range with a late answer", async () => {
  const view = render(<GtdPage {...props} />);
  const task = await screen.findByRole("button", {
    name: "Synthetic weekly outcome",
  });
  let finish: (value: GtdReport) => void = () => undefined;
  vi.mocked(api.getGtdReport).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh GTD" }));
  expect(screen.getByRole("button", { name: "Synthetic weekly outcome" })).toBe(
    task,
  );
  fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
  await waitFor(() =>
    expect(
      view.container.querySelector(".gtd-panel")?.getAttribute("aria-busy"),
    ).toBe("false"),
  );
  await act(async () => finish(report()));
  expect(
    screen.getByRole("navigation", { name: "GTD date range" }).textContent,
  ).toContain("Oct 18 – 24, 2026");
  expect(screen.getByRole("button", { name: "Synthetic weekly outcome" })).toBe(
    task,
  );
});

it("does not fabricate a commitment rate for an old period with missing plan history", async () => {
  vi.mocked(api.getGtdReport).mockResolvedValue(
    create(GtdReportSchema, {
      ...report(),
      plannedTaskCount: undefined,
      completedPlannedTaskCount: undefined,
      taskPlanHistoryComplete: false,
    }),
  );
  render(<GtdPage {...props} />);
  await screen.findByText("Plan history is not available for this period");
  expect(
    screen.queryByRole("progressbar", { name: "Committed Tasks completion" }),
  ).toBeNull();
  expect(screen.getByText("Tasks completed")).toBeTruthy();
});

it("does not show a previous area's totals under a new area's toolbar when the read fails", async () => {
  render(<GtdPage {...props} />);
  await screen.findByRole("button", { name: "Synthetic weekly outcome" });
  vi.mocked(api.getGtdReport).mockRejectedValueOnce(new Error("offline"));
  fireEvent.change(screen.getByRole("combobox", { name: "GTD area" }), {
    target: { value: "personal" },
  });
  await screen.findByRole("alert");
  expect(
    screen.queryByRole("button", { name: "Synthetic weekly outcome" }),
  ).toBeNull();
  expect(screen.queryByText("Recorded time")).toBeNull();
});

it("keeps a Step's parent context without inventing the parent's completion status", async () => {
  const partial = report();
  partial.tasks = partial.tasks.filter((task) => task.kind === "step");
  vi.mocked(api.getGtdReport).mockResolvedValue(partial);
  const view = render(<GtdPage {...props} selectedTab="completion" />);
  await screen.findByRole("button", { name: "Synthetic weekly outcome" });
  const parentRow = view.container.querySelector(
    ".gtd-progress-details > summary",
  )!;
  expect(parentRow.querySelector(".gtd-completion-mark")).toBeNull();
  expect(parentRow.querySelector(".gtd-completed-date")).toBeNull();
  expect(parentRow.querySelector(".gtd-parent-context")).toBeTruthy();
});

it("keeps empty, failed and retry states useful without a misleading zero completion rate", async () => {
  vi.mocked(api.getGtdReport).mockRejectedValueOnce(new Error("offline"));
  render(<GtdPage {...props} />);
  await screen.findByRole("alert");
  vi.mocked(api.getGtdReport).mockResolvedValue(
    create(GtdReportSchema, {
      name: "gtdReport",
      startDay: "2026-10-25",
      endDay: "2026-10-31",
      today: "2026-10-25",
      timeZone: "America/Los_Angeles",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("No planned or completed work in this period.");
  expect(
    screen.queryByRole("progressbar", { name: "Scheduled Steps completion" }),
  ).toBeNull();
  expect(screen.queryByText("0% complete")).toBeNull();
});

it("navigates calendar ranges across month/year boundaries without changing the anchor week", () => {
  expect(reportRange("week", "2026-01-01")).toEqual([
    "2025-12-28",
    "2026-01-03",
  ]);
  expect(reportRange("month", "2028-02-15")).toEqual([
    "2028-02-01",
    "2028-02-29",
  ]);
  expect(dateRangeLabel("2025-12-29", "2026-01-04", "week")).toBe(
    "Dec 29, 2025 – Jan 4, 2026",
  );
});
