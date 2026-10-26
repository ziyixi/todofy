import { type ComponentProps, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import { api, type Catalog, type Task } from "../api";
import { TaskDialog } from "./TaskDialog";

// jsdom has no native showModal; browser regressions exercise the real Dialog.
vi.mock("./Dialog", () => ({
  Dialog: ({ title, children }: { title: string; children: ReactNode }) => (
    <section role="dialog" aria-label={title}>
      {children}
    </section>
  ),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const catalog: Catalog = {
  projects: [],
  sections: [],
  labels: [],
  filters: [],
  timeZone: "America/Los_Angeles",
};
const original = create(TaskSchema, {
  id: "synthetic-editor",
  name: "tasks/synthetic-editor",
  etag: "1",
  title: "Synthetic editor task",
  description: "Read [the guide](https://example.org/guide).",
  priority: 4,
  kind: "task",
});
type SaveTask = ComponentProps<typeof TaskDialog>["onSave"];

function editor(
  onSave: SaveTask,
  task = original,
  onDelete: ComponentProps<typeof TaskDialog>["onDelete"] = async () => {},
) {
  const onClose = vi.fn();
  return {
    onClose,
    ...render(
      <TaskDialog
        task={task}
        catalog={catalog}
        onSave={onSave}
        onClose={onClose}
        onDelete={onDelete}
        onComplete={async () => undefined}
        onOpen={() => {}}
        onChildAdded={() => {}}
      />,
    ),
  };
}

const description = () =>
  within(screen.getByRole("region", { name: "Task description" }));

it("renders saved Markdown on the first render without a raw-source fallback", () => {
  editor(async () => original);
  expect(
    description().getByRole("link", { name: "the guide" }).getAttribute("href"),
  ).toBe("https://example.org/guide");
  expect(screen.queryByText(/\[the guide\]/)).toBeNull();
});

it("focuses task deletion confirmation and Escape returns to its trigger without saving or closing", () => {
  const save = vi.fn<SaveTask>().mockResolvedValue(original);
  const remove = vi.fn().mockResolvedValue(undefined);
  const { onClose } = editor(save, original, remove);
  const trigger = screen.getByRole("button", { name: "Delete" });
  trigger.focus();
  fireEvent.click(trigger);
  const confirm = screen.getByRole("button", { name: "Delete task" });
  expect(document.activeElement).toBe(confirm);
  fireEvent.keyDown(confirm, { key: "Escape" });
  expect(screen.queryByRole("button", { name: "Delete task" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(save).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it("ignores held and composing Enter in deletion and sends one pending delete without saving", async () => {
  const save = vi.fn<SaveTask>().mockResolvedValue(original);
  let finishDelete!: () => void;
  const remove = vi.fn(
    () => new Promise<void>((resolve) => { finishDelete = resolve; }),
  );
  const { onClose } = editor(save, original, remove);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  const confirm = screen.getByRole("button", { name: "Delete task" });
  expect(fireEvent.keyDown(confirm, { key: "Enter", repeat: true })).toBe(false);
  expect(
    fireEvent.keyDown(confirm, { key: "Enter", isComposing: true }),
  ).toBe(false);
  fireEvent.keyDown(confirm, { key: "Escape", isComposing: true });
  expect(screen.getByRole("button", { name: "Delete task" })).toBe(confirm);
  expect(remove).not.toHaveBeenCalled();
  // jsdom does not synthesize button activation from Enter; Chromium covers that native default.
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(remove).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  await act(async () => finishDelete());
  expect(onClose).toHaveBeenCalledOnce();
});

it("closes an existing task only after explicit Save succeeds", async () => {
  let confirmSave!: (task: Task) => void;
  const save = vi.fn<SaveTask>(
    () =>
      new Promise((resolve) => {
        confirmSave = resolve;
      }),
  );
  const { onClose } = editor(save);
  fireEvent.change(screen.getByRole("textbox", { name: "Task name" }), {
    target: { value: "Synthetic changed task" },
  });
  const button = screen.getByRole("button", { name: "Save changes" });
  fireEvent.click(button);
  expect(save).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(save).toHaveBeenCalledOnce();
  await act(async () =>
    confirmSave(
      create(TaskSchema, {
        ...original,
        title: "Synthetic changed task",
        etag: "2",
      }),
    ),
  );
  expect(onClose).toHaveBeenCalledOnce();
});

it("keeps an existing draft open when explicit Save fails", async () => {
  const save = vi
    .fn<SaveTask>()
    .mockRejectedValue(new Error("synthetic failure"));
  const { onClose } = editor(save);
  fireEvent.change(screen.getByRole("textbox", { name: "Task name" }), {
    target: { value: "Synthetic unsaved task" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Could not confirm"),
  );
  expect(
    (screen.getByRole("textbox", { name: "Task name" }) as HTMLTextAreaElement)
      .value,
  ).toBe("Synthetic unsaved task");
  expect(onClose).not.toHaveBeenCalled();
});

it("explicit Save after a successful Done closes without another save callback", async () => {
  const save = vi.fn<SaveTask>().mockResolvedValue(original);
  const { onClose } = editor(save);
  fireEvent.click(
    description().getByRole("button", { name: "Edit description" }),
  );
  fireEvent.click(description().getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Saved"),
  );
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledOnce();
});

it("Done waits for the save, then shows the saved Markdown and uses its returned etag", async () => {
  let confirmSave!: (task: Task) => void;
  const save = vi
    .fn<SaveTask>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirmSave = resolve;
        }),
    )
    .mockImplementation(async (draft, task) =>
      create(TaskSchema, {
        ...(task ?? original),
        ...draft,
        etag: "3",
      }),
    );
  const { onClose, unmount } = editor(save);
  fireEvent.click(
    description().getByRole("button", { name: "Edit description" }),
  );
  const input = description().getByRole("textbox", { name: "Description" });
  const markdown =
    "## Reading\n\n**Saved text** with [a link](https://example.org/saved).\n\n- Saved item";
  fireEvent.change(input, { target: { value: markdown } });
  fireEvent.change(screen.getByRole("combobox", { name: "Planning stage" }), {
    target: { value: "weekly" },
  });
  fireEvent.click(description().getByRole("button", { name: "Done" }));
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0]?.[0].description).toBe(markdown);
  expect(save.mock.calls[0]?.[3]?.paths).toContain("stage");
  expect((input as HTMLTextAreaElement).disabled).toBe(true);
  expect(
    (screen.getByRole("textbox", { name: "Task name" }) as HTMLTextAreaElement)
      .disabled,
  ).toBe(true);
  expect(
    (description().getByRole("button", { name: "Done" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.queryByText("Saved", { exact: true })).toBeNull();
  const saved = create(TaskSchema, {
    ...original,
    description: markdown,
    etag: "2",
    stage: "weekly",
  });
  await act(async () => confirmSave(saved));
  expect(description().queryByRole("textbox")).toBeNull();
  expect(description().getByRole("heading", { name: "Reading" })).toBeTruthy();
  expect(
    description().getByRole("link", { name: "a link" }).getAttribute("href"),
  ).toBe("https://example.org/saved");
  expect(description().getByRole("listitem").textContent).toBe("Saved item");
  expect(screen.getByRole("status").textContent).toBe("Saved");
  expect(onClose).not.toHaveBeenCalled();
  expect(
    (screen.getByRole("textbox", { name: "Task name" }) as HTMLTextAreaElement)
      .disabled,
  ).toBe(false);
  fireEvent.change(screen.getByRole("textbox", { name: "Task name" }), {
    target: { value: "Synthetic second edit" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1]?.[1]?.etag).toBe("2");
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  unmount();
  editor(async () => saved, saved);
  expect(description().getByRole("heading", { name: "Reading" })).toBeTruthy();
  expect(description().queryByRole("textbox")).toBeNull();
});

it("keeps the description draft editable on a failed Done and reports no success", async () => {
  const save = vi
    .fn<SaveTask>()
    .mockRejectedValue(new Error("synthetic failure"));
  const { onClose } = editor(save);
  fireEvent.click(
    description().getByRole("button", { name: "Edit description" }),
  );
  fireEvent.change(
    description().getByRole("textbox", { name: "Description" }),
    {
      target: { value: "**Draft to keep**" },
    },
  );
  fireEvent.click(description().getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "Could not confirm",
    ),
  );
  const input = description().getByRole("textbox", {
    name: "Description",
  }) as HTMLTextAreaElement;
  expect(input.value).toBe("**Draft to keep**");
  expect(input.disabled).toBe(false);
  expect(screen.getByRole("status").textContent).toBe("");
  expect(onClose).not.toHaveBeenCalled();
});

it("keeps Done feedback on unchanged interaction and clears it when a field changes", async () => {
  const save = vi.fn<SaveTask>().mockResolvedValue(original);
  editor(save);
  const saveButton = screen.getByRole("button", { name: "Save changes" });
  fireEvent.click(
    description().getByRole("button", { name: "Edit description" }),
  );
  fireEvent.click(description().getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Saved"),
  );
  expect(saveButton.textContent).toBe("Saved");
  fireEvent.click(screen.getByRole("textbox", { name: "Task name" }));
  expect(screen.getByRole("status").textContent).toBe("Saved");
  fireEvent.click(
    description().getByRole("button", { name: "Edit description" }),
  );
  expect(screen.getByRole("status").textContent).toBe("Saved");
  fireEvent.change(
    description().getByRole("textbox", { name: "Description" }),
    {
      target: { value: "Changed draft" },
    },
  );
  expect(screen.getByRole("status").textContent).toBe("");
  expect(saveButton.textContent).toBe("Save changes");
});

it("disables both new-task text fields until its pending create is confirmed", async () => {
  let confirmSave!: (task: Task) => void;
  const save = vi.fn<SaveTask>(
    () =>
      new Promise((resolve) => {
        confirmSave = resolve;
      }),
  );
  const onClose = vi.fn();
  render(
    <TaskDialog
      catalog={catalog}
      onSave={save}
      onClose={onClose}
      onDelete={async () => {}}
      onComplete={async () => undefined}
      onOpen={() => {}}
      onChildAdded={() => {}}
    />,
  );
  const title = screen.getByRole("textbox", {
    name: "Task name",
  }) as HTMLTextAreaElement;
  const input = screen.getByRole("textbox", {
    name: "Description",
  }) as HTMLTextAreaElement;
  fireEvent.change(title, { target: { value: "Synthetic pending create" } });
  fireEvent.change(input, {
    target: { value: "Description sent with the create." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add task" }));
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    title: "Synthetic pending create",
    description: "Description sent with the create.",
  });
  expect(save.mock.calls[0]?.[1]).toBeUndefined();
  expect(title.disabled).toBe(true);
  expect(input.disabled).toBe(true);
  expect(screen.getByRole("dialog", { name: "Add task" })).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  await act(async () =>
    confirmSave(
      create(TaskSchema, {
        ...original,
        title: "Synthetic pending create",
        description: "Description sent with the create.",
      }),
    ),
  );
  expect(onClose).toHaveBeenCalledOnce();
});

it("maps each Execution choice atomically while Routine and hidden saved flags stay intact", async () => {
  const task = create(TaskSchema, {
    ...original,
    stage: "committed",
    planningFlags: ["active", "waiting", "onhold", "routine"],
  });
  const save = vi
    .fn<SaveTask>()
    .mockImplementation(async (draft, current, _id, planning) =>
      create(TaskSchema, {
        ...(current || original),
        ...draft,
        ...planning?.values,
        etag: String(Number(current?.etag || 0) + 1),
      }),
    );
  const { onClose } = editor(save, task);
  for (const name of ["In progress", "Waiting", "On hold", "Parked"])
    expect(screen.queryByRole("checkbox", { name })).toBeNull();
  expect(
    (
      screen.getByRole("radio", {
        name: "Steps",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  expect(
    screen.queryByRole("spinbutton", { name: "Duration (minutes)" }),
  ).toBeNull();

  for (const [index, mode] of ["Quick", "Standalone", "Steps"].entries()) {
    fireEvent.click(screen.getByRole("radio", { name: mode }));
    expect(
      (
        screen.getByRole("switch", {
          name: "Routine",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      screen
        .getAllByRole("radio")
        .filter((radio) => (radio as HTMLInputElement).checked),
    ).toHaveLength(1);
    expect(
      Boolean(screen.queryByRole("spinbutton", { name: "Duration (minutes)" })),
    ).toBe(mode !== "Steps");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(index + 1));
    const flags = save.mock.calls[index]?.[3]?.values.planningFlags || [];
    expect(flags).toEqual([
      ...(mode !== "Steps" ? ["task"] : []),
      ...(mode === "Quick" ? ["quick"] : []),
      "active",
      "waiting",
      "onhold",
      "routine",
    ]);
    expect(save.mock.calls[index]?.[3]?.paths).toContain("planning_flags");
    expect(save.mock.calls[index]?.[1]?.etag).toBe(String(index + 1));
  }
  expect(onClose).toHaveBeenCalledTimes(3);
});

it("preserves a legacy Quick's no-op mask and only changes Routine when toggled", async () => {
  const task = create(TaskSchema, {
    ...original,
    planningFlags: ["quick", "waiting"],
  });
  const save = vi
    .fn<SaveTask>()
    .mockImplementation(async (draft, current, _id, planning) =>
      create(TaskSchema, {
        ...(current || original),
        ...draft,
        ...planning?.values,
        etag: "2",
      }),
    );
  const { onClose } = editor(save, task);
  expect(
    (
      screen.getByRole("radio", {
        name: "Quick",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]?.[3]?.paths).toEqual([]);
  fireEvent.click(screen.getByRole("switch", { name: "Routine" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1]?.[3]?.values.planningFlags).toEqual([
    "task",
    "quick",
    "waiting",
    "routine",
  ]);
});

it("keeps an imported parked flag on an unrelated edit and clears it only when choosing a stage", async () => {
  const task = create(TaskSchema, { ...original, planningFlags: ["parked"] });
  const save = vi
    .fn<SaveTask>()
    .mockImplementation(async (draft, current, _id, planning) =>
      create(TaskSchema, {
        ...(current || original),
        ...draft,
        ...planning?.values,
        etag: String(Number(current?.etag || 0) + 1),
      }),
    );
  const { onClose } = editor(save, task);
  fireEvent.change(screen.getByRole("textbox", { name: "Task name" }), {
    target: { value: "Synthetic renamed task" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]?.[3]?.paths).toEqual([]);
  expect(save.mock.calls[0]?.[3]?.values.planningFlags).toEqual(["parked"]);
  fireEvent.change(screen.getByRole("combobox", { name: "Planning stage" }), {
    target: { value: "committed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1]?.[3]?.values.planningFlags).toEqual([]);
});

it("leaves an actual Step executable without offering an Execution mode", () => {
  editor(
    async () => original,
    create(TaskSchema, {
      ...original,
      kind: "step",
      parentId: "synthetic-parent",
    }),
  );
  expect(screen.queryByRole("radiogroup", { name: "Execution" })).toBeNull();
  expect(
    screen.getByRole("spinbutton", { name: "Duration (minutes)" }),
  ).toBeTruthy();
});

it.each(["step", "standalone", "quick"] as const)(
  "saves and reopens a %s estimate in native details without changing its execution or clock",
  async (execution) => {
    const task = create(TaskSchema, {
      ...original,
      kind: execution === "step" ? "step" : "task",
      planningFlags:
        execution === "step"
          ? []
          : execution === "quick"
            ? ["quick"]
            : ["task"],
      dueDate: "2026-10-26",
      dueDatetime: "2026-10-26T04:25:00Z",
      dueTimezone: "Asia/Tokyo",
    });
    const save = vi
      .fn<SaveTask>()
      .mockImplementation(async (draft, current) =>
        create(TaskSchema, { ...current!, ...draft, etag: "2" }),
      );
    const view = editor(save, task);
    const duration = screen.getByRole<HTMLInputElement>("spinbutton", {
      name: "Duration (minutes)",
    });
    fireEvent.change(duration, { target: { value: "47" } });
    expect(duration.checkValidity()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]?.[3]?.paths).toEqual([]);
    const saved = await save.mock.results[0]!.value;
    expect(saved.durationMinutes).toBe(47);
    for (const field of [
      "kind",
      "parentId",
      "planningFlags",
      "dueDate",
      "dueDatetime",
      "dueTimezone",
    ] as const)
      expect(saved[field]).toEqual(task[field]);
    view.unmount();
    editor(save, saved);
    expect(
      (
        screen.getByRole("spinbutton", {
          name: "Duration (minutes)",
        }) as HTMLInputElement
      ).value,
    ).toBe("47");
  },
);

it("keeps the direct goal on description, planning and date edits without loading the catalog", async () => {
  const catalogRead = vi.spyOn(api, "getGoalCatalog");
  const task = create(TaskSchema, {
    ...original,
    keyResultId: "synthetic-result",
    effectiveKeyResultId: "synthetic-result",
    keyResultTitle: "Synthetic annual result",
  });
  const save = vi
    .fn<SaveTask>()
    .mockImplementation(async (draft, current) =>
      create(TaskSchema, { ...current!, ...draft, etag: "2" }),
    );
  editor(save, task);
  expect(
    screen.getByRole("button", { name: "Associated goal" }).textContent,
  ).toContain("Synthetic annual result");
  expect(catalogRead).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("combobox", { name: "Planning stage" }), {
    target: { value: "weekly" },
  });
  fireEvent.click(
    description().getByRole("button", { name: "Edit description" }),
  );
  fireEvent.change(
    description().getByRole("textbox", { name: "Description" }),
    { target: { value: "Updated description" } },
  );
  fireEvent.click(description().getByRole("button", { name: "Done" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]?.[0].keyResultId).toBe("synthetic-result");
  expect(save.mock.calls[0]?.[3]?.paths).toContain("stage");
  expect(catalogRead).not.toHaveBeenCalled();
});

it("shows a Step's inherited goal without offering a direct assignment", async () => {
  const read = vi.spyOn(api, "getGoalCatalog");
  const task = create(TaskSchema, {
    ...original,
    kind: "step",
    parentId: "synthetic-parent",
    effectiveKeyResultId: "synthetic-result",
    keyResultTitle: "Synthetic inherited result",
  });
  const save = vi.fn<SaveTask>().mockResolvedValue(task);
  editor(save, task);
  expect(
    screen
      .getByRole("link", { name: "Synthetic inherited result" })
      .getAttribute("href"),
  ).toBe("#/goals/synthetic-result");
  expect(screen.queryByRole("button", { name: "Associated goal" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Task name" }), {
    target: { value: "Updated synthetic Step" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]?.[0]).not.toHaveProperty("keyResultId");
  expect(read).not.toHaveBeenCalled();
});
