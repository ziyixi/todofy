import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createPrototype } from "../design/fixture";
import { FocusView } from "../src/FocusView";

afterEach(cleanup);

it("shows the cleaned full parent path and preserves local records without a Todoist completion control", async () => {
  const actions = createPrototype();
  const { plan, focus } = await actions.load();
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
  render(
    <FocusView
      plan={plan}
      focus={focus}
      days={[focus]}
      today={focus.date}
      onDateChange={vi.fn()}
      language="en"
      busy={false}
      run={vi.fn()}
      actions={actions}
      editTask={vi.fn()}
      addFocus={vi.fn()}
      complete={vi.fn()}
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
    screen.getByRole("button", {
      name: "Remove from day: Synthetic local note",
    }),
  ).toBeTruthy();
});
