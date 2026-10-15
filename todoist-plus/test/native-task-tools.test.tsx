import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPrototype } from "../design/fixture";
import { NativeTaskTools } from "../src/NativeTaskTools";
import type { PlusActions, PlusData } from "../src/model";

const actions = vi.hoisted(() => ({}) as PlusActions);
vi.mock("../src/client", () => ({ extensionActions: actions }));
beforeEach(() => {
  Object.assign(actions, createPrototype());
  vi.spyOn(actions, "load");
  vi.spyOn(actions, "readPlan");
});
afterEach(cleanup);

function open(snapshot?: { data: PlusData; readAt: number }) {
  const onReady = vi.fn();
  render(
    <NativeTaskTools
      taskId="copy"
      language="en"
      onReady={onReady}
      snapshot={snapshot}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Steps & timing" }));
  return onReady;
}
function stage() {
  return screen.getByRole("combobox", {
    name: "Planning",
  }) as HTMLSelectElement;
}

it("uses recently read tasks with only a ReadPlan request", async () => {
  const data = await createPrototype().load();
  const onReady = open({ data, readAt: Date.now() });
  expect(
    screen.getByRole("heading", { name: "Write the introduction" }),
  ).toBeTruthy();
  expect(stage().disabled).toBe(false);
  await waitFor(() => expect(actions.readPlan).toHaveBeenCalledOnce());
  expect(actions.load).not.toHaveBeenCalled();
  await waitFor(() => expect(onReady).toHaveBeenCalledTimes(2));
});

it("shows older remembered tasks at once but saves only after the complete re-read", async () => {
  const data = await createPrototype().load();
  let finish!: (data: PlusData) => void;
  const original = actions.load;
  actions.load = vi.fn(
    () => new Promise<PlusData>((resolve) => (finish = resolve)),
  );
  open({ data, readAt: 0 });
  expect(
    screen.getByRole("heading", { name: "Write the introduction" }),
  ).toBeTruthy();
  expect(stage().disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toBe("Updating…");
  await act(async () => finish(await original()));
  expect(stage().disabled).toBe(false);
  expect(actions.readPlan).not.toHaveBeenCalled();
});

it("reads the complete plan when this page has no remembered data", async () => {
  open();
  expect(screen.getByText("Loading your plan…")).toBeTruthy();
  await screen.findByRole("heading", { name: "Write the introduction" });
  expect(actions.load).toHaveBeenCalledOnce();
});

it("reads again after a refused save, so a task edited in Todoist can be saved on reopening", async () => {
  let edited = false;
  const load = actions.load;
  actions.load = vi.fn(async (week?: string) => {
    const data = await load(week);
    if (edited)
      data.plan.tasks = data.plan.tasks.map((task) =>
        task.id === "copy" ? { ...task, etag: "native-edit" } : task,
      );
    return data;
  });
  const update = actions.updateTask;
  // Like SetTaskPlan's ETAG_MISMATCH after a rename or label change in native Todoist.
  actions.updateTask = vi.fn(async (task, change) => {
    if (edited && task.etag !== "native-edit")
      throw new Error("Synthetic version mismatch");
    return { ...(await update(task, change)), etag: "native-edit" };
  });
  open();
  await waitFor(() => expect(stage().disabled).toBe(false));
  edited = true;
  const save = () => {
    fireEvent.change(stage(), { target: { value: "weekly" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]!);
  };
  await act(async () => save());
  await screen.findByRole("alert");
  await waitFor(() => expect(actions.load).toHaveBeenCalledTimes(2));
  const toggle = screen.getByRole("button", { name: "Steps & timing" });
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  await waitFor(() => expect(stage().disabled).toBe(false));
  await act(async () => save());
  await waitFor(() => expect(actions.updateTask).toHaveBeenCalledTimes(2));
  expect(
    await (actions.updateTask as ReturnType<typeof vi.fn>).mock.results[1]!
      .value,
  ).toMatchObject({ id: "copy", stage: "weekly" });
});

it("reads the complete plan for a task that recently read data does not include", async () => {
  const data = await createPrototype().load();
  data.plan.tasks = data.plan.tasks.filter((task) => task.id !== "copy");
  open({ data, readAt: Date.now() });
  expect(screen.getByRole("status").textContent).toBe("Updating…");
  await screen.findByRole("heading", { name: "Write the introduction" });
  expect(actions.load).toHaveBeenCalledOnce();
  expect(stage().disabled).toBe(false);
});
