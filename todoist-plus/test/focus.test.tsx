import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createPrototype } from "../design/fixture";
import { FocusView } from "../src/FocusView";

afterEach(cleanup);

it("shows cleaned parent context and local records with execution controls only", async () => {
  const { plan, focus } = await createPrototype().load();
  const parent = plan.tasks.find((task) => task.id === "release")!;
  parent.title = "[TASK] Synthetic outcome <k:synthetic.root>";
  plan.tasks.push({
    ...parent,
    id: "phase",
    parentId: parent.id,
    title: "[TASK] Synthetic phase <k:synthetic.phase>",
    stage: "none",
  });
  const child = plan.tasks.find((task) => task.id === "copy")!;
  child.parentId = "phase";
  child.title = "[TASK] Synthetic leaf <k:synthetic.leaf>";
  focus.taskIds.push("local-note");
  focus.flowTasks["local-note"] = {
    title: "Synthetic local note",
    local: true,
    estimatedMinutes: 15,
  };
  const onTimer = vi.fn();
  const complete = vi.fn();
  render(
    <FocusView
      plan={plan}
      focus={focus}
      language="en"
      busy={false}
      editTask={vi.fn()}
      complete={complete}
      onOpenPlan={vi.fn()}
      onTimer={onTimer}
    />,
  );
  expect(
    screen.getByText("Synthetic outcome › Synthetic phase", { exact: true }),
  ).toBeTruthy();
  expect(screen.getByText("Synthetic leaf", { exact: true })).toBeTruthy();
  expect(screen.queryByText(/\[TASK\]|<k:/)).toBeNull();
  expect(
    screen.getByText("Synthetic local note", { exact: true }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", {
      name: "Complete task: Synthetic local note",
    }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", {
      name: /Choose tasks|Drag step|Remove from day|Move up|Move down/,
    }),
  ).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Start: Synthetic leaf" }),
  );
  expect(onTimer).toHaveBeenCalledWith("start", "copy");
  expect(complete).not.toHaveBeenCalled();
});

it("sends an empty today queue back to Plan instead of presenting another task picker", async () => {
  const { plan, focus } = await createPrototype().load();
  focus.taskIds = [];
  const onOpenPlan = vi.fn();
  render(
    <FocusView
      plan={plan}
      focus={focus}
      language="en"
      busy={false}
      editTask={vi.fn()}
      complete={vi.fn()}
      onOpenPlan={onOpenPlan}
      onTimer={vi.fn()}
    />,
  );
  expect(screen.getByText("No steps planned for today.")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Adjust plan" }),
  );
  expect(onOpenPlan).toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Choose tasks" })).toBeNull();
});
