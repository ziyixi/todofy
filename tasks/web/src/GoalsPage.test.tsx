import { useEffect, useState, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import {
  GoalCatalogSchema,
  GoalProgressSchema,
  KeyResultSchema,
  KeyResultSummarySchema,
  ObjectiveSchema,
} from "@ziyixi/proto/tasks/ui/v1/goals_pb";
import { PlanSchema } from "@ziyixi/proto/tasks/ui/v1/plan_pb";
import { TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import {
  ListGoalProgressResponseSchema,
  ListTasksResponseSchema,
} from "@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb";
import { api, type Task } from "./api";
import { clearGoalCatalogCache } from "./goals-client";
import GoalsPage from "./GoalsPage";
import { readRoute } from "./routes";

vi.mock("./components/Dialog", () => ({
  Dialog: ({ title, children }: { title: string; children: ReactNode }) => (
    <section role="dialog" aria-label={title}>
      {children}
    </section>
  ),
}));

const objectives = Array.from({ length: 4 }, (_, index) =>
  create(ObjectiveSchema, {
    id: `objective-${index + 1}`,
    name: `objectives/objective-${index + 1}`,
    title: `Direction ${index + 1}`,
    year: 2026,
    etag: "1",
  }),
);
const results = objectives.flatMap((objective, index) =>
  Array.from({ length: 3 }, (_, resultIndex) =>
    create(KeyResultSchema, {
      id: `result-${index + 1}-${resultIndex + 1}`,
      name: `keyResults/result-${index + 1}-${resultIndex + 1}`,
      objectiveId: objective.id,
      year: 2026,
      title: `Result ${index + 1}.${resultIndex + 1}`,
      kind:
        resultIndex === 1
          ? "routine"
          : resultIndex === 2
            ? "exploration"
            : "outcome",
      floorText: "A small weekly practice",
      targetText: "A useful result to share",
      etag: "1",
    }),
  ),
);
function catalog(year = 2026) {
  return create(GoalCatalogSchema, {
    name: "goalCatalog",
    year,
    today: "2026-10-24",
    timeZone: "America/Los_Angeles",
    objectives: year === 2026 ? objectives : [],
    keyResults:
      year === 2026
        ? results.map((result) =>
            create(KeyResultSummarySchema, { ...result, $typeName: undefined }),
          )
        : [],
  });
}
function mount(selectedId = "") {
  window.history.replaceState(
    null,
    "",
    `/#/goals${selectedId ? `/${selectedId}` : ""}`,
  );
  const onOpenTask = vi.fn();
  const onCreateTask = vi.fn();
  const onCompleteTask = vi
    .fn<(task: Task) => Promise<string | undefined>>()
    .mockResolvedValue(undefined);
  function Harness() {
    const [route, setRoute] = useState(readRoute);
    const [revision, setRevision] = useState(0);
    useEffect(() => {
      const changed = () => setRoute(readRoute());
      window.addEventListener("hashchange", changed);
      return () => window.removeEventListener("hashchange", changed);
    }, []);
    return (
      <GoalsPage
        selectedId={route.id}
        refreshRevision={revision}
        onOpenTask={onOpenTask}
        onCreateTask={onCreateTask}
        onCompleteTask={async (task) => {
          const result = await onCompleteTask(task);
          setRevision((current) => current + 1);
          return result;
        }}
      />
    );
  }
  return { ...render(<Harness />), onOpenTask, onCreateTask, onCompleteTask };
}
beforeEach(() => {
  clearGoalCatalogCache();
  vi.spyOn(api, "getGoalCatalog").mockImplementation(async (request) =>
    catalog(request?.year || 2026),
  );
  vi.spyOn(api, "getKeyResult").mockImplementation(
    async (request) => results.find((result) => result.name === request?.name)!,
  );
  vi.spyOn(api, "getPlan").mockResolvedValue(
    create(PlanSchema, {
      name: "plan",
      weekStart: "2026-10-19",
      today: "2026-10-24",
    }),
  );
  vi.spyOn(api, "listGoalProgress").mockResolvedValue(
    create(ListGoalProgressResponseSchema),
  );
  vi.spyOn(api, "listTasks").mockResolvedValue(create(ListTasksResponseSchema));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clearGoalCatalogCache();
});

it("opens imported annual definitions with no invented progress and reads only the selected result", async () => {
  mount();
  await screen.findByRole("heading", { name: "Result 1.1" });
  expect(screen.getAllByRole("tab")).toHaveLength(4);
  expect(screen.getAllByRole("option")).toHaveLength(3);
  expect(await screen.findByText(/No progress recorded yet/)).toBeTruthy();
  expect(screen.getByText("No milestones defined.")).toBeTruthy();
  expect(screen.queryByText(/100%/)).toBeNull();
  expect(api.getKeyResult).toHaveBeenCalledTimes(1);
  expect(api.listGoalProgress).toHaveBeenCalledWith({
    keyResultId: "result-1-1",
    pageSize: 20,
    pageToken: "",
  });
  expect(api.listTasks).toHaveBeenCalledWith(
    expect.objectContaining({ keyResultId: "result-1-1", pageSize: 30 }),
  );
});

it("keeps every result reachable through objective tabs and the concise selector", async () => {
  mount();
  await screen.findByRole("heading", { name: "Result 1.1" });
  for (let direction = 1; direction <= 4; direction++) {
    fireEvent.click(
      screen.getByRole("tab", { name: `Direction ${direction}` }),
    );
    await screen.findByRole("heading", { name: `Result ${direction}.1` });
    for (let result = 1; result <= 3; result++) {
      fireEvent.change(screen.getByRole("combobox", { name: "Key result" }), {
        target: { value: `result-${direction}-${result}` },
      });
      await screen.findByRole("heading", {
        name: `Result ${direction}.${result}`,
      });
    }
  }
  expect(api.getGoalCatalog).toHaveBeenCalledTimes(1);
});

it("keeps outcome confirmations separate from current focus and supports clearing focus", async () => {
  const initial = create(KeyResultSchema, {
    ...results[0]!,
    focusStartMonth: "2026-10",
    focusEndMonth: "2026-12",
    focusText: "Build a repeatable example",
    milestones: [{ id: "scope", title: "Scope confirmed" }],
    $typeName: undefined,
  });
  vi.mocked(api.getKeyResult).mockResolvedValue(initial);
  const update = vi
    .spyOn(api, "updateKeyResult")
    .mockImplementation(async (request) =>
      create(KeyResultSchema, {
        ...initial,
        ...request?.keyResult,
        etag: "2",
        $typeName: undefined,
      }),
    );
  mount(initial.id);
  expect(await screen.findByText("Oct – Dec focus")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm milestone Scope confirmed" }),
  );
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(update.mock.calls[0]?.[0]?.updateMask?.paths).toEqual(["milestones"]);
  expect(update.mock.calls[0]?.[0]?.keyResult?.focusText).toBeUndefined();
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Adjust focus" })
        .hasAttribute("disabled"),
    ).not.toBe(true),
  );
  fireEvent.click(screen.getByRole("button", { name: "Adjust focus" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear focus" }));
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }),
  );
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(update.mock.calls[1]?.[0]?.updateMask?.paths).toEqual([
    "focus_start_month",
    "focus_end_month",
    "focus_text",
  ]);
  expect(update.mock.calls[1]?.[0]?.keyResult?.focusText).toBe("");
  expect(update.mock.calls[1]?.[0]?.keyResult?.completed).toBeUndefined();
});

it("shows routines and explorations without outcome completion controls", async () => {
  vi.mocked(api.getKeyResult).mockImplementation(async (request) => {
    const result = results.find((item) => item.name === request?.name)!;
    return create(KeyResultSchema, { ...result, floorText: "" });
  });
  const view = mount("result-1-2");
  await screen.findByRole("heading", { name: "Routine" });
  expect(screen.queryByText("Floor")).toBeNull();
  expect(screen.getByText("Ceiling")).toBeTruthy();
  expect(
    screen.queryByRole("checkbox", { name: "Result confirmed complete" }),
  ).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Key result" }), {
    target: { value: "result-1-3" },
  });
  await screen.findByRole("heading", { name: "Exploration" });
  expect(screen.queryByText("0 milestones confirmed")).toBeNull();
  expect(screen.queryByText("Floor")).toBeNull();
  expect(screen.queryByText("Ceiling")).toBeNull();
  expect(screen.queryByText("Not set")).toBeNull();
  view.unmount();
});

it("cancels edits without a write and preserves the selected result and draft during a refresh", async () => {
  const update = vi
    .spyOn(api, "updateKeyResult")
    .mockImplementation(async (request) =>
      create(KeyResultSchema, {
        ...results[4]!,
        ...request?.keyResult,
        etag: "2",
        $typeName: undefined,
      }),
    );
  mount("result-2-2");
  await screen.findByRole("heading", { name: "Result 2.2" });
  fireEvent.click(screen.getByRole("button", { name: "Edit key result" }));
  const input = screen.getByRole("textbox", {
    name: "Title",
  }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Draft kept while loading" } });
  input.focus();
  input.setSelectionRange(6, 10);
  fireEvent.click(screen.getByRole("button", { name: "Refresh Goals" }));
  await waitFor(() => expect(api.getGoalCatalog).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("textbox", { name: "Title" })).toBe(input);
  expect(input.value).toBe("Draft kept while loading");
  expect(input.selectionStart).toBe(6);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(update).not.toHaveBeenCalled();
  expect(
    (screen.getByRole("combobox", { name: "Key result" }) as HTMLSelectElement)
      .value,
  ).toBe("result-2-2");
  fireEvent.click(screen.getByRole("button", { name: "Edit key result" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Saved annual routine" },
  });
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }),
  );
  await screen.findByRole("heading", { name: "Saved annual routine" });
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({
      etag: "1",
      keyResult: expect.objectContaining({
        name: "keyResults/result-2-2",
        title: "Saved annual routine",
      }),
    }),
  );
  expect(window.location.hash).toBe("#/goals/result-2-2");
});

it("creates, edits and deletes real progress notes with evidence and refreshes the bounded history", async () => {
  const entry = create(GoalProgressSchema, {
    id: "progress-note",
    name: "goalProgress/progress-note",
    keyResultId: "result-1-1",
    note: "Baseline reproduced",
    evidenceUrl: "https://example.org/evidence",
    etag: "1",
    createTime: { seconds: 1792800000n },
  });
  let stored = false;
  vi.mocked(api.listGoalProgress).mockImplementation(async () =>
    create(ListGoalProgressResponseSchema, {
      goalProgress: stored ? [entry] : [],
    }),
  );
  const createProgress = vi
    .spyOn(api, "createGoalProgress")
    .mockImplementation(async () => {
      stored = true;
      return entry;
    });
  const updateProgress = vi
    .spyOn(api, "updateGoalProgress")
    .mockImplementation(async () => entry);
  const remove = vi
    .spyOn(api, "deleteGoalProgress")
    .mockImplementation(async () => {
      stored = false;
      return { $typeName: "google.protobuf.Empty" };
    });
  mount();
  await screen.findByRole("button", { name: "Record progress" });
  fireEvent.click(screen.getByRole("button", { name: "Record progress" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Progress note" }), {
    target: { value: entry.note },
  });
  fireEvent.change(
    screen.getByRole("textbox", { name: "Evidence link (optional)" }),
    { target: { value: entry.evidenceUrl } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save progress" }));
  await screen.findByText("Baseline reproduced");
  expect(createProgress).toHaveBeenCalledWith(
    expect.objectContaining({
      goalProgress: expect.objectContaining({
        keyResultId: entry.keyResultId,
        note: entry.note,
        evidenceUrl: entry.evidenceUrl,
      }),
    }),
  );
  expect(
    screen.getByRole("link", { name: "View evidence" }).getAttribute("href"),
  ).toBe(entry.evidenceUrl);
  fireEvent.click(screen.getByRole("button", { name: /Edit progress from/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Progress note" }), {
    target: { value: "A clearer note" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save progress" }));
  await waitFor(() => expect(updateProgress).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: /Delete progress from/ }));
  fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
  await screen.findByText(/No progress recorded yet/);
  expect(remove).toHaveBeenCalledWith(
    expect.objectContaining({ name: entry.name, etag: entry.etag }),
  );
});

it("reads related Steps only when expanded and completes Tasks without changing goal progress", async () => {
  const parent = create(TaskSchema, {
    id: "linked-task",
    name: "tasks/linked-task",
    etag: "1",
    title: "Run the baseline",
    keyResultId: "result-1-1",
    childCount: 1,
    stage: "committed",
  });
  const step = create(TaskSchema, {
    id: "linked-step",
    name: "tasks/linked-step",
    etag: "1",
    title: "Prepare the fixture",
    kind: "step",
    parentId: parent.id,
    durationMinutes: 15,
  });
  vi.mocked(api.listTasks).mockImplementation(async (request) =>
    create(ListTasksResponseSchema, {
      tasks: request?.parentId ? [step] : [parent],
    }),
  );
  const update = vi.spyOn(api, "updateKeyResult");
  const progressWrite = vi.spyOn(api, "createGoalProgress");
  const { onCompleteTask, onCreateTask } = mount();
  await screen.findByRole("button", { name: parent.title });
  expect(api.listTasks).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Steps" }));
  await screen.findByRole("button", { name: step.title });
  expect(api.listTasks).toHaveBeenCalledWith(
    expect.objectContaining({ parentId: parent.id, pageSize: 30 }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: `Complete ${step.title}` }),
  );
  await waitFor(() => expect(onCompleteTask).toHaveBeenCalledWith(step));
  expect(update).not.toHaveBeenCalled();
  expect(progressWrite).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Add task for this goal" }),
  );
  expect(onCreateTask).toHaveBeenCalledWith("result-1-1");
});

it("Refresh Goals updates linked tasks and already expanded Steps", async () => {
  const task = create(TaskSchema, {
    id: "refresh-task",
    name: "tasks/refresh-task",
    title: "Before task refresh",
    childCount: 1,
  });
  const step = create(TaskSchema, {
    id: "refresh-step",
    name: "tasks/refresh-step",
    parentId: task.id,
    kind: "step",
    title: "Before Step refresh",
  });
  let refreshed = false;
  vi.mocked(api.listTasks).mockImplementation(async (request) =>
    create(ListTasksResponseSchema, {
      tasks: request?.parentId
        ? [
            create(TaskSchema, {
              ...step,
              title: refreshed ? "After Step refresh" : step.title,
            }),
          ]
        : [
            create(TaskSchema, {
              ...task,
              title: refreshed ? "After task refresh" : task.title,
            }),
          ],
    }),
  );
  mount();
  await screen.findByRole("button", { name: task.title });
  fireEvent.click(screen.getByRole("button", { name: "Steps" }));
  await screen.findByRole("button", { name: step.title });
  refreshed = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh Goals" }));
  await screen.findByRole("button", { name: "After task refresh" });
  await screen.findByRole("button", { name: "After Step refresh" });
  expect(
    screen
      .getByRole("button", { name: /^Steps.*inherit this goal/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
});

it("keeps a confirmed Goal save when an older refresh response arrives later", async () => {
  const original = results[0]!;
  let finishRead!: (value: typeof original) => void;
  vi.mocked(api.getKeyResult)
    .mockResolvedValueOnce(original)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
  vi.spyOn(api, "updateKeyResult").mockResolvedValue(
    create(KeyResultSchema, {
      ...original,
      title: "Confirmed title after refresh began",
      etag: "2",
    }),
  );
  mount(original.id);
  await screen.findByRole("heading", { name: original.title });
  fireEvent.click(screen.getByRole("button", { name: "Refresh Goals" }));
  await waitFor(() => expect(api.getKeyResult).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Edit key result" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Confirmed title after refresh began" },
  });
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }),
  );
  await screen.findByRole("heading", {
    name: "Confirmed title after refresh began",
  });
  await act(async () => {
    finishRead(original);
  });
  expect(
    screen.getByRole("heading", {
      name: "Confirmed title after refresh began",
    }),
  ).toBeTruthy();
  expect(screen.queryByRole("heading", { name: original.title })).toBeNull();
});

it("reuses the latest identical quick Goal write after a lost response and changes identity for the next edit", async () => {
  const original = create(KeyResultSchema, {
    ...results[0]!,
    milestones: [
      {
        id: "earlier",
        title: "Earlier result",
        completed: true,
        completeTime: { seconds: 1792800000n },
      },
      { id: "target", title: "Target result" },
    ],
    $typeName: undefined,
  });
  const confirmed = create(KeyResultSchema, {
    ...original,
    etag: "2",
    milestones: original.milestones.map((item) => ({
      ...item,
      completed: true,
    })),
  });
  vi.mocked(api.getKeyResult).mockResolvedValue(original);
  const update = vi
    .spyOn(api, "updateKeyResult")
    .mockRejectedValueOnce(new Error("Synthetic lost response"))
    .mockResolvedValueOnce(confirmed)
    .mockResolvedValueOnce(create(KeyResultSchema, { ...original, etag: "3" }));
  mount(original.id);
  await screen.findByRole("heading", { name: original.title });
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm milestone Target result" }),
  );
  await screen.findByRole("alert");
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm milestone Target result" }),
  );
  await screen.findByRole("button", { name: "Reopen milestone Target result" });
  expect(update.mock.calls[1]?.[0]).toEqual(update.mock.calls[0]?.[0]);
  fireEvent.click(
    screen.getByRole("button", { name: "Reopen milestone Target result" }),
  );
  await screen.findByRole("button", {
    name: "Confirm milestone Target result",
  });
  expect(update.mock.calls[2]?.[0]?.requestId).not.toBe(
    update.mock.calls[1]?.[0]?.requestId,
  );
  expect(update.mock.calls[2]?.[0]?.etag).toBe("2");
});

it("uses year navigation without reading unrelated result details", async () => {
  mount();
  await screen.findByRole("heading", { name: "Result 1.1" });
  fireEvent.click(screen.getByRole("button", { name: "Previous year" }));
  await screen.findByRole("heading", { name: "No goals for this year" });
  expect(api.getGoalCatalog).toHaveBeenLastCalledWith({
    name: "goalCatalog",
    year: 2025,
  });
  expect(api.getKeyResult).toHaveBeenCalledTimes(1);
});

it("opens archived results through existing task links and keeps them editable", async () => {
  const archived = create(KeyResultSchema, {
    ...results[0]!,
    archived: true,
    objectiveArchived: true,
  });
  vi.mocked(api.getGoalCatalog).mockResolvedValue(
    create(GoalCatalogSchema, {
      ...catalog(),
      objectives: [
        create(ObjectiveSchema, { ...objectives[0]!, archived: true }),
      ],
      keyResults: [
        create(KeyResultSummarySchema, { ...archived, $typeName: undefined }),
      ],
    }),
  );
  vi.mocked(api.getKeyResult).mockResolvedValue(archived);
  mount(archived.id);
  await screen.findByRole("heading", { name: archived.title });
  expect(screen.getAllByText("Archived").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Edit key result" }));
  expect(
    (screen.getByRole("checkbox", { name: "Archived" }) as HTMLInputElement)
      .checked,
  ).toBe(true);
});

it("opens a link from a previous year in that result's annual catalog", async () => {
  const previous = create(KeyResultSchema, { ...results[0]!, year: 2025 });
  vi.mocked(api.getKeyResult).mockResolvedValue(previous);
  mount(previous.id);
  await waitFor(() =>
    expect(api.getGoalCatalog).toHaveBeenCalledWith({
      name: "goalCatalog",
      year: 2025,
    }),
  );
  await act(async () => {});
});
