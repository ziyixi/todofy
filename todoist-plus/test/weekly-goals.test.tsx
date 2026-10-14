import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createPrototype } from "../design/fixture";
import { WeeklyGoals } from "../src/WeeklyGoals";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
});
afterEach(cleanup);

it("replaces an existing weekly goal using only Bet marks and preserves task stages and dates", async () => {
  const actions = createPrototype();
  const { plan } = await actions.load();
  const oldGoal = plan.tasks.find((task) => task.id === "release")!;
  const nextGoal = plan.tasks.find((task) => task.id === "research")!;
  const writes = vi.spyOn(actions, "updateTask");
  render(
    <WeeklyGoals
      plan={plan}
      language="en"
      busy={false}
      actions={actions}
      run={async (operation) => {
        await operation();
        return true;
      }}
      editTask={vi.fn()}
    />,
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Change goal" })[0]!);
  expect(
    screen
      .getByRole("button", { name: "Use as weekly goal" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(
    screen.getByRole("searchbox", { name: "Search goal tasks" }),
    { target: { value: "research" } },
  );
  fireEvent.change(screen.getByRole("listbox", { name: "Goal task" }), {
    target: { value: nextGoal.id },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use as weekly goal" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const refreshed = (await actions.load()).plan;
  expect(refreshed.tasks.find((task) => task.id === oldGoal.id)).toEqual({
    ...oldGoal,
    bet: false,
  });
  expect(refreshed.tasks.find((task) => task.id === nextGoal.id)).toEqual({
    ...nextGoal,
    bet: true,
  });
  expect(writes.mock.calls.map(([, update]) => update)).toEqual([
    { bet: false },
    { bet: true },
  ]);
});

it("keeps all marked and unassigned goals visible without automatically cleaning them", async () => {
  const actions = createPrototype();
  const { plan } = await actions.load();
  const other = plan.tasks.find((task) => task.id === "research")!;
  other.bet = true;
  plan.tasks.push({
    ...other,
    id: "unassigned-goal",
    title: "Synthetic unassigned goal",
    parentId: "",
    area: "unassigned",
  });
  const writes = vi.spyOn(actions, "updateTask");
  render(
    <WeeklyGoals
      plan={plan}
      language="en"
      busy={false}
      actions={actions}
      run={async (operation) => {
        await operation();
        return true;
      }}
      editTask={vi.fn()}
    />,
  );
  expect(
    screen.getByText("More than one goal is marked. Adjust them individually."),
  ).toBeTruthy();
  expect(screen.getByText("Synthetic unassigned goal")).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Unassigned goals" }),
  ).toBeTruthy();
  expect(
    screen.getAllByRole("button", { name: /Remove weekly goal:/ }),
  ).toHaveLength(4);
  expect(writes).not.toHaveBeenCalled();
});
