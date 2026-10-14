import { createElement, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PrototypeFocus } from "../design/PrototypeFocus";
import { planningFixture } from "../design/planning-fixture";
import { TODAY, type Outcome } from "../design/planning-model";
import {
  formatPrototypeTime,
  usePrototypeTimer,
} from "../design/usePrototypeTimer";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-10-14T00:00:00Z");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("ticks, freezes while paused, resumes accumulated time and clears on stop", () => {
  const { result } = renderHook(usePrototypeTimer);
  act(() => result.current.start("step-a"));
  act(() => vi.advanceTimersByTime(3000));
  expect(result.current.seconds).toBe(3);
  act(() => result.current.pause());
  act(() => vi.advanceTimersByTime(10000));
  expect(result.current.timer?.status).toBe("paused");
  expect(result.current.seconds).toBe(3);
  act(() => result.current.resume());
  act(() => vi.advanceTimersByTime(2000));
  expect(result.current.seconds).toBe(5);
  act(() => result.current.stop());
  expect(result.current.timer).toBeNull();
  expect(result.current.seconds).toBe(0);
  expect(formatPrototypeTime(3661)).toBe("01:01:01");
});

it("keeps one active task and does not reset it on repeated or conflicting starts", () => {
  const { result } = renderHook(usePrototypeTimer);
  act(() => result.current.start("step-a"));
  act(() => vi.advanceTimersByTime(4000));
  act(() => {
    result.current.start("step-a");
    result.current.start("step-b");
  });
  expect(result.current.timer?.taskId).toBe("step-a");
  expect(result.current.seconds).toBe(4);
  act(() => result.current.stop());
  act(() => result.current.start("step-b"));
  expect(result.current.timer?.taskId).toBe("step-b");
  expect(result.current.seconds).toBe(0);
});

function TimerViews() {
  const [data, setData] = useState(planningFixture);
  const [focusVisible, setFocusVisible] = useState(true);
  const stopwatch = usePrototypeTimer();
  function save(outcome: Outcome) {
    setData((current) => ({
      ...current,
      outcomes: current.outcomes.map((item) =>
        item.id === outcome.id ? outcome : item,
      ),
    }));
  }
  return createElement(
    "div",
    {},
    createElement(
      "button",
      { onClick: () => setFocusVisible(!focusVisible) },
      focusVisible ? "Show Plan" : "Show Focus",
    ),
    createElement(
      "button",
      {
        onClick: () =>
          setData((current) => ({
            ...current,
            queues: { ...current.queues, [TODAY]: [] },
          })),
      },
      "Clear today's queue",
    ),
    focusVisible
      ? createElement(PrototypeFocus, {
          outcomes: data.outcomes,
          ids: data.queues[TODAY] ?? [],
          stopwatch,
          onSave: save,
          onEdit: () => {},
          onPlan: () => setFocusVisible(false),
        })
      : createElement("p", {}, "Plan view"),
    createElement(
      "span",
      { "aria-label": "First step state" },
      data.outcomes[0]!.steps[0]!.done ? "done" : "open",
    ),
    createElement(
      "span",
      { "aria-label": "Next step state" },
      data.outcomes[1]!.steps[0]!.done ? "done" : "open",
    ),
  );
}

it("keeps the local stopwatch when Focus unmounts and returns", () => {
  render(createElement(TimerViews));
  fireEvent.click(
    screen.getByRole("button", { name: "Start: Write the introduction" }),
  );
  act(() => vi.advanceTimersByTime(2000));
  expect(
    screen.getByLabelText("Elapsed: Write the introduction").textContent,
  ).toBe("00:00:02");
  fireEvent.click(screen.getByRole("button", { name: "Show Plan" }));
  expect(screen.queryByLabelText("Elapsed: Write the introduction")).toBeNull();
  act(() => vi.advanceTimersByTime(5000));
  fireEvent.click(screen.getByRole("button", { name: "Show Focus" }));
  expect(
    screen.getByLabelText("Elapsed: Write the introduction").textContent,
  ).toBe("00:00:07");
});

it("Stop preserves the task while completing the active task clears its stopwatch", () => {
  render(createElement(TimerViews));
  fireEvent.click(
    screen.getByRole("button", { name: "Start: Write the introduction" }),
  );
  act(() => vi.advanceTimersByTime(4000));
  fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
  expect(screen.getByLabelText("First step state").textContent).toBe("open");
  expect(screen.queryByLabelText("Elapsed: Write the introduction")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Start: Write the introduction" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Complete: Write the introduction" }),
  );
  expect(screen.getByLabelText("First step state").textContent).toBe("done");
  expect(screen.queryByLabelText("Elapsed: Write the introduction")).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Start: Outline three questions" })
      .hasAttribute("disabled"),
  ).toBe(false);
  fireEvent.click(
    screen.getByRole("button", { name: "Start: Outline three questions" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Clear today's queue" }));
  expect(
    screen.getByLabelText("Elapsed: Outline three questions"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
  expect(screen.getByLabelText("Next step state").textContent).toBe("open");
  expect(
    screen.queryByLabelText("Elapsed: Outline three questions"),
  ).toBeNull();
});
