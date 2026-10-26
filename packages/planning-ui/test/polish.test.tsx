import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createPrototype } from "./fixture";
import { FocusView } from "../src/FocusView";
import { PlanView, type PlanViewProps } from "../src/PlanView";
import { readableDate, weekLabel } from "../src/PlanningCalendar";
import { OutcomeCard } from "../src/ReviewBoard";
import type { Language, PlanningTask } from "../src/model";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function planProps(language: Language): Promise<PlanViewProps> {
  const actions = createPrototype();
  const { plan, focus, days } = await actions.load();
  return {
    plan,
    days,
    focusTasks: focus.tasks,
    currentDate: focus.date,
    language,
    busy: false,
    actions,
    run: vi.fn(),
    editTask: vi.fn(),
    onWeekChange: vi.fn(),
    completeTask: vi.fn(),
    completeReview: vi.fn(),
  };
}

it("shows dates as people read them, with the ISO week number", () => {
  expect(readableDate("2026-10-12", "en")).toBe("Mon, Oct 12");
  expect(readableDate("2026-10-12", "zh")).toBe("10月12日周一");
  expect(readableDate("2040-04-22", "en")).toContain("2040");
  expect(readableDate("2040-04-22", "zh")).toContain("2040年");
  expect(weekLabel("2026-10-12", "en")).toBe("Week 42 · from Oct 12");
  expect(weekLabel("2026-10-12", "zh")).toBe("第 42 周 · 10月12日起");
  // The week belongs to the year of its Thursday.
  expect(weekLabel("2025-12-29", "en")).toBe("Week 1 · from Dec 29, 2025");
});

it("counts steps in natural English and Chinese", async () => {
  const { plan } = await createPrototype().load();
  const parent: PlanningTask = {
    ...plan.tasks[0]!,
    id: "outcome",
    parentId: "",
    stage: "committed",
  };
  const step = (id: string): PlanningTask => ({
    ...parent,
    id,
    parentId: "outcome",
    stage: "none",
  });
  const card = (language: Language, tasks: PlanningTask[]) =>
    render(
      <OutcomeCard
        task={parent}
        tasks={[parent, ...tasks]}
        scheduledIds={new Set(["one"])}
        today="2026-10-13"
        language={language}
        onClick={vi.fn()}
      />,
    );
  card("en", [step("one")]);
  expect(screen.getByText("1 step · 1 planned")).toBeTruthy();
  cleanup();
  card("en", [step("one"), step("two")]);
  expect(screen.getByText("2 steps · 1 planned")).toBeTruthy();
  cleanup();
  card("zh", [step("one"), step("two"), step("three")]);
  expect(screen.getByText("3 个步骤 · 已安排 1")).toBeTruthy();
});

it("keeps an outcome card to a title and one left-aligned line, the deadline first in a two-part status", async () => {
  // Untouched days count from the clock.
  vi.useFakeTimers({
    now: Date.parse("2026-10-13T12:00:00Z"),
    toFake: ["Date"],
  });
  const { plan } = await createPrototype().load();
  const venue: PlanningTask = {
    ...plan.tasks.find((task) => task.id === "venue")!,
    deadline: "2026-10-22",
  };
  const blocker: PlanningTask = {
    ...plan.tasks[0]!,
    id: "book",
    title: "Book the room",
  };
  const card = (language: Language, waitsFor?: PlanningTask[]) =>
    render(
      <OutcomeCard
        task={venue}
        tasks={[...plan.tasks, blocker]}
        scheduledIds={new Set()}
        today="2026-10-13"
        language={language}
        waitsFor={waitsFor}
        onClick={vi.fn()}
      />,
    );
  const parts = () =>
    [...document.querySelectorAll(".planning-outcome-status > span")].map(
      (part) => part.textContent,
    );
  card("zh");
  const button = screen.getByRole("button");
  // The area is in the name and the edge colour, no longer a word on the card.
  expect(button.getAttribute("aria-label")).toMatch(
    /^Hear back about the venue quote, 工作, 未设优先级, /u,
  );
  expect(button.querySelector(".planning-outcome-context")).toBeNull();
  expect(
    button.querySelector(".planning-outcome-title")!.hasAttribute("title"),
  ).toBe(false);
  expect(button.querySelectorAll(".planning-outcome-status")).toHaveLength(1);
  expect(button.querySelector(".is-row")).toBeNull();
  // The status is the one meta line, deadline first, so it is the part never cut.
  expect(button.querySelector(".planning-outcome-meta")!.children).toHaveLength(
    1,
  );
  expect(parts()).toEqual(["10月22日截止", " · 11 天未变动"]);
  cleanup();
  card("en", [blocker]);
  expect(parts()).toEqual([
    "Deadline Oct 22",
    " · Waiting for “Book the room”",
  ]);
  // The deadline's full date stays the status's tooltip; screen readers hear the whole line.
  expect(
    document.querySelector(".planning-outcome-status")!.getAttribute("title"),
  ).toBe("Deadline: Thu, Oct 22");
  expect(screen.getByRole("button").getAttribute("aria-label")).toContain(
    "Waiting for “Book the room” · Deadline Oct 22",
  );
});

it("names a paused timer as a state, colours checkboxes by priority and keeps unlisted rows aligned", async () => {
  const { plan, focus } = await createPrototype().load();
  focus.timer = {
    taskId: "copy",
    day: focus.date,
    area: "work",
    status: "paused",
    elapsedSeconds: 85,
    startedAt: "",
    etag: "synthetic-timer",
  };
  focus.taskIds.push("unlisted");
  focus.tasks["unlisted"] = {
    title: "Synthetic unlisted step",
    parentId: "",
    parentTitle: "",
    completed: false,
  };
  const props = {
    plan,
    focus,
    busy: false,
    editTask: vi.fn(),
    complete: vi.fn(),
    onOpenPlan: vi.fn(),
    onTimer: vi.fn(),
    actions: createPrototype(),
    run: vi.fn(),
    onOpenTask: vi.fn(),
  };
  const { rerender, container } = render(
    <FocusView {...props} language="en" />,
  );
  const slot = (id: string) =>
    container.querySelector(`[data-task-id="${id}"]`)!;
  expect(slot("copy").querySelector(".plus-focus-status")!.textContent).toBe(
    "Paused",
  );
  // The button keeps the verb.
  expect(
    screen.getByRole("button", { name: "Resume: Write the introduction" })
      .textContent,
  ).toBe("Resume");
  const copy = plan.tasks.find((task) => task.id === "copy")!;
  expect(
    slot("copy").querySelector(".plus-checkbox")!.getAttribute("data-priority"),
  ).toBe(String(copy.priority));
  expect(
    slot("unlisted")
      .querySelector(".plus-checkbox-slot")!
      .getAttribute("aria-hidden"),
  ).toBe("true");
  rerender(<FocusView {...props} language="zh" />);
  expect(slot("copy").querySelector(".plus-focus-status")!.textContent).toBe(
    "已暂停",
  );
});

it("names Parked and Waiting in both languages, in words only", async () => {
  // With one task in its start window.
  const props = async (language: Language) => {
    const result = await planProps(language);
    result.plan.tasks.push({
      ...result.plan.tasks[0]!,
      id: "claim",
      title: "Submit the expense claim",
      stage: "none",
      deadline: "2026-10-14",
      leadDays: 3,
      mustStart: true,
    });
    return result;
  };
  const { rerender } = render(<PlanView {...await props("en")} />);
  expect(screen.getByRole("region", { name: "Parked" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Waiting" })).toBeTruthy();
  // No new icons: a card that should start says so in its status, without the old calendar clock.
  expect(
    document.querySelector(".review-board svg.lucide-calendar-clock"),
  ).toBe(null);
  rerender(<PlanView {...await props("zh")} />);
  expect(screen.getByRole("region", { name: "搁置" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "等待中" })).toBeTruthy();
  expect(
    screen.getByRole("button", {
      name: "Submit the expense claim, 工作, 未设优先级, 明天截止，10月14日周三",
    }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "开始: Submit the expense claim" }),
  ).toBeTruthy();
});

it("leaves the drop zone under a planned day blank and dates the weekly review", async () => {
  const props = await planProps("en");
  render(<PlanView {...props} reviewing={1} />);
  expect(
    within(screen.getByRole("region", { name: "Weekly review" })).getByText(
      "Week 42 · from Oct 12",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: /^Week$/u }));
  const ends = [...document.querySelectorAll(".planning-day-end")].map(
    (end) => end.textContent,
  );
  expect(ends).toContain("Drop a step");
  expect(ends).toContain("");
  expect(ends).not.toContain("+");
});

it("folds Committed with a chevron button named in words, in both languages", async () => {
  const props = await planProps("zh");
  // No personal commitment, so the Personal filter leaves none selected.
  props.plan.tasks = props.plan.tasks.map((task) =>
    task.id === "desk" ? { ...task, area: "work" } : task,
  );
  const { rerender } = render(<PlanView {...props} />);
  fireEvent.click(screen.getByRole("tab", { name: "一周安排" }));
  const toggle = screen.getByRole("button", { name: "本周承诺" });
  expect(toggle.closest("h2")).toBeTruthy();
  expect(toggle.querySelector("svg.lucide-chevron-down")).toBeTruthy();
  fireEvent.click(
    within(screen.getByRole("tablist", { name: "承诺范围" })).getByRole("tab", {
      name: "生活",
    }),
  );
  fireEvent.click(toggle);
  expect(toggle.querySelector("svg.lucide-chevron-right")).toBeTruthy();
  expect(screen.getByText("展开“本周承诺”，选择一个事项。")).toBeTruthy();
  expect(toggle.closest("div")!.textContent).toBe(
    "本周承诺4 项2 项承诺这 7 天还没有安排",
  );
  rerender(<PlanView {...await planProps("en")} />);
  expect(
    screen
      .getByRole("button", { name: "Committed" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
});
