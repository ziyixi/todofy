import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { createPrototype } from "../design/fixture";
import type { PlusActions, PlusData, View } from "../src/model";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(cleanup);

function mount(actions: PlusActions, view: View = "plan") {
  return render(
    <App
      actions={actions}
      view={view}
      language="en"
      onOpenTask={() => {}}
      onSettings={() => {}}
    />,
  );
}
function scheduled(date: string, id: string) {
  return document.querySelector(
    `.planning-calendar-day[data-date="${date}"] .planning-calendar-step[data-task-id="${id}"]`,
  );
}
function held(actions: PlusActions) {
  const reads: ((data: PlusData) => void)[] = [];
  const original = actions.load;
  actions.load = vi.fn(
    () => new Promise<PlusData>((resolve) => reads.push(resolve)),
  );
  return { reads, original };
}

it("keeps the board usable during a refresh and never shows an older read over a newer write", async () => {
  const actions = createPrototype();
  mount(actions);
  await screen.findByRole("region", { name: "Committed" });
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  const before = await actions.load();
  const { reads, original } = held(actions);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(document.querySelector(".plus-page-header .plus-spin")).toBeTruthy();
  const remove = screen.getByRole("button", {
    name: "Remove from 2026-10-14: Clear out the old development branch",
  }) as HTMLButtonElement;
  expect(remove.disabled).toBe(false);
  fireEvent.click(remove);
  await waitFor(() => expect(scheduled("2026-10-14", "cleanup")).toBeNull());
  actions.load = original;
  // The read began before the write, so it is discarded and read again.
  await act(async () => reads[0]!(before));
  await waitFor(() =>
    expect(document.querySelector(".plus-page-header .plus-spin")).toBeNull(),
  );
  expect(scheduled("2026-10-14", "cleanup")).toBeNull();
  expect(
    (await actions.load()).days.find((day) => day.date === "2026-10-14")
      ?.taskIds,
  ).toEqual([]);
});

it("shows confirmed queue, deadline and goal results without reading the week or plan again", async () => {
  const actions = createPrototype();
  const load = vi.spyOn(actions, "load");
  const loadDays = vi.spyOn(actions, "loadDays");
  mount(actions);
  await screen.findByRole("region", { name: "Committed" });
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  fireEvent.click(
    screen.getByRole("button", {
      name: "Remove from 2026-10-12: Check the layout on a phone",
    }),
  );
  await waitFor(() => expect(scheduled("2026-10-12", "layout")).toBeNull());

  fireEvent.click(screen.getByRole("tab", { name: "Review" }));
  fireEvent.click(
    screen.getByRole("button", {
      name: "Prepare the next research check-in, No priority",
    }),
  );
  const editor = within(screen.getByRole("region", { name: "Steps & timing" }));
  fireEvent.change(editor.getByLabelText("Deadline"), {
    target: { value: "2026-10-30" },
  });
  const save = editor
    .getAllByRole("button", { name: "Save" })
    .find((button) => !(button as HTMLButtonElement).disabled)!;
  fireEvent.click(save);
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(true));
  expect(editor.getByText("Start window: 2026-10-28")).toBeTruthy();
  fireEvent.click(editor.getByRole("button", { name: "Close" }));

  fireEvent.click(screen.getAllByRole("button", { name: "Change goal" })[0]!);
  fireEvent.change(screen.getByRole("listbox", { name: "Goal task" }), {
    target: { value: "notes" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use as weekly goal" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "Weekly goals" })).getByText(
        "Organize the experiment notes",
      ),
    ).toBeTruthy(),
  );
  expect(load).toHaveBeenCalledOnce();
  expect(loadDays).not.toHaveBeenCalled();
});

it("re-reads on returning to the tab only after a minute and without disabling controls", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const actions = createPrototype();
  const load = vi.spyOn(actions, "load");
  mount(actions);
  await screen.findByRole("region", { name: "Committed" });
  const visible = () =>
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  now.mockReturnValue(1_000_000 + 59_000);
  await visible();
  expect(load).toHaveBeenCalledOnce();
  now.mockReturnValue(1_000_000 + 60_000);
  const { reads, original } = held(actions);
  await visible();
  expect(actions.load).toHaveBeenCalledOnce();
  expect(
    (
      screen.getAllByRole("button", {
        name: /^Move outcome:/u,
      })[0] as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  await act(async () => reads[0]!(await original()));
  await waitFor(() =>
    expect(document.querySelector(".plus-page-header .plus-spin")).toBeNull(),
  );
});

it("keeps a confirmed completion visible but pending until the re-read shows the result", async () => {
  const actions = createPrototype();
  mount(actions, "focus");
  const checkbox = (await screen.findByRole("button", {
    name: "Complete task: Write the introduction",
  })) as HTMLButtonElement;
  const { reads, original } = held(actions);
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox.disabled).toBe(true));
  const block = document.querySelector(
    '.plus-focus-slot[data-task-id="copy"]',
  )!;
  expect(block.querySelector("[aria-busy=true]")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Updating…" })).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "Start: Write the introduction",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  // Other steps stay usable while the completion is re-read.
  expect(
    (
      screen.getByRole("button", {
        name: "Complete task: Outline three questions for the check-in",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  await act(async () => reads[0]!(await original()));
  await waitFor(() =>
    expect(screen.queryByText("Write the introduction")).toBeNull(),
  );
});
