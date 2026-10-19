import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import { ListTasksResponseSchema } from "@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb";
import { RpcStatusError } from "@ziyixi/proto/http-client";
import { parseStatus } from "@ziyixi/proto/rpc-status";
import { api, type Task } from "./api";
import type { Route } from "./routes";
import { useTaskActions } from "./useTaskActions";
import * as focus from "./task-completion-focus";
import { useTaskView } from "./useTaskView";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("refreshes the current project after a save finishes in the view we left", async () => {
  const source = create(TaskSchema, {
    id: "moving",
    name: "tasks/moving",
    title: "Move to studio",
    etag: "1",
  });
  const studio = create(TaskSchema, {
    id: "studio",
    title: "Existing studio task",
    projectId: "studio",
  });
  const moved = create(TaskSchema, {
    ...source,
    projectId: "studio",
    etag: "2",
  });
  let persisted = false;
  vi.spyOn(api, "listTasks").mockImplementation(async (request) =>
    create(ListTasksResponseSchema, {
      tasks:
        request?.projectId === "studio"
          ? [studio, ...(persisted ? [moved] : [])]
          : persisted
            ? []
            : [source],
    }),
  );
  let finish!: (task: typeof source) => void;
  vi.spyOn(api, "updateTask").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result, rerender } = renderHook(
    (route: Route) => {
      const list = useTaskView(route, "", "", "sort_order", false);
      return { list, actions: useTaskActions(route, "sort_order", list) };
    },
    { initialProps: { page: "inbox", id: "" } as Route },
  );
  await waitFor(() => expect(result.current.list.tasks).toEqual([source]));
  let saved!: Promise<Task>;
  act(() => {
    saved = result.current.actions.saveTask(moved, source);
  });
  rerender({ page: "project", id: "studio" });
  await waitFor(() => expect(result.current.list.tasks).toEqual([studio]));
  persisted = true;
  await act(async () => {
    finish(moved);
    await saved;
  });
  expect(result.current.list.tasks).toEqual([studio, moved]);
});

it("can duplicate again with a refreshed etag after a definite conflict", async () => {
  const task = create(TaskSchema, {
    id: "template",
    name: "tasks/template",
    title: "Synthetic template",
    etag: "1",
  });
  const status = parseStatus(409, {
    error: { code: 409, status: "ABORTED", message: "Task changed" },
  });
  if (!status) throw new Error("Synthetic conflict status is invalid");
  let copies = 0;
  vi.spyOn(api, "duplicateTask").mockImplementation(async (request) => {
    if (request?.etag === "1") throw new RpcStatusError(status);
    copies++;
    return create(TaskSchema, { ...task, id: "copy" });
  });
  vi.spyOn(api, "listTasks").mockResolvedValue(create(ListTasksResponseSchema));
  const route = { page: "focus" as const, id: "" };
  const { result } = renderHook(() =>
    useTaskActions(
      route,
      "sort_order",
      useTaskView(route, "", "", "sort_order", false),
    ),
  );
  await act(() => result.current.duplicateTask(task));
  expect(result.current.notice).toBe("Task changed");
  await act(() =>
    result.current.duplicateTask(create(TaskSchema, { ...task, etag: "2" })),
  );
  expect(copies).toBe(1);
  expect(result.current.notice).toBe("Task duplicated");
});

it("replays the same duplicate after a lost response even if the source was then edited", async () => {
  const task = create(TaskSchema, {
    id: "template",
    name: "tasks/template",
    title: "Synthetic template",
    etag: "1",
  });
  const receipts = new Set<string>();
  let copies = 0;
  vi.spyOn(api, "duplicateTask").mockImplementation(async (request) => {
    const id = request?.requestId || "";
    if (!receipts.has(id)) {
      receipts.add(id);
      copies++;
      throw new TypeError("Synthetic lost response");
    }
    return create(TaskSchema, { ...task, id: "copy" });
  });
  vi.spyOn(api, "listTasks").mockResolvedValue(create(ListTasksResponseSchema));
  const route = { page: "focus" as const, id: "" };
  const { result } = renderHook(() =>
    useTaskActions(
      route,
      "sort_order",
      useTaskView(route, "", "", "sort_order", false),
    ),
  );
  await act(() => result.current.duplicateTask(task));
  await act(() =>
    result.current.duplicateTask(create(TaskSchema, { ...task, etag: "2" })),
  );
  expect(copies).toBe(1);
  expect(result.current.notice).toBe("Task duplicated");
});

it("invalidates planning only after confirmed native task changes", async () => {
  vi.spyOn(focus, "settleCompletedTask").mockResolvedValue(undefined);
  const task = create(TaskSchema, {
    id: "synthetic",
    name: "tasks/synthetic",
    title: "Synthetic step",
    etag: "1",
  });
  const update = vi.spyOn(api, "updateTask").mockResolvedValue(task);
  vi.spyOn(api, "completeTask").mockResolvedValue(
    create(TaskSchema, { ...task, completed: true }),
  );
  vi.spyOn(api, "deleteTask").mockResolvedValue(
    {} as Awaited<ReturnType<typeof api.deleteTask>>,
  );
  const read = vi.spyOn(api, "listTasks");
  const route = { page: "focus" as const, id: "" };
  const { result } = renderHook(() => {
    const list = useTaskView(route, "", "", "sort_order", false);
    return useTaskActions(route, "sort_order", list);
  });
  expect(result.current.mutationRevision).toBe(0);
  await act(() =>
    result.current.saveTask(
      { ...task, title: "Synthetic confirmed change" },
      task,
    ),
  );
  expect(result.current.mutationRevision).toBe(1);
  await act(() => result.current.complete(task));
  expect(result.current.mutationRevision).toBe(2);
  await act(() => result.current.deleteTask(task));
  expect(result.current.mutationRevision).toBe(3);
  update.mockRejectedValueOnce(new Error("Synthetic failed write"));
  await act(async () => {
    await expect(
      result.current.saveTask(
        { ...task, title: "Synthetic rejected change" },
        task,
      ),
    ).rejects.toThrow("Synthetic failed write");
  });
  expect(result.current.mutationRevision).toBe(3);
  expect(read).not.toHaveBeenCalled();
});

it("replays an uncertain recurring completion with its original source etag and UUID", async () => {
  const task = create(TaskSchema, {
    id: "recurring",
    name: "tasks/recurring",
    title: "Synthetic daily action",
    etag: "1",
    recurrence: "every day",
  });
  const receipts = new Set<string>();
  let occurrences = 0;
  const complete = vi
    .spyOn(api, "completeTask")
    .mockImplementation(async (request) => {
      const requestId = request?.requestId || "";
      if (!receipts.has(requestId)) {
        receipts.add(requestId);
        occurrences++;
        throw new TypeError("Synthetic lost completion response");
      }
      return create(TaskSchema, { ...task, etag: "2", completedCount: 1 });
    });
  const settle = vi
    .spyOn(focus, "settleCompletedTask")
    .mockResolvedValue("Task completed. Focus is temporarily unavailable.");
  const route = { page: "focus" as const, id: "" };
  const { result } = renderHook(() =>
    useTaskActions(
      route,
      "sort_order",
      useTaskView(route, "", "", "sort_order", false),
      "2026-10-17",
    ),
  );
  await act(() => result.current.complete(task));
  await act(() =>
    result.current.complete(create(TaskSchema, { ...task, etag: "2" })),
  );
  expect(occurrences).toBe(1);
  expect(complete.mock.calls[1]![0]).toEqual(complete.mock.calls[0]![0]);
  expect(settle).toHaveBeenCalledWith(
    expect.anything(),
    complete.mock.calls[0]![0]!.requestId,
    "1",
    "2026-10-17",
  );
  expect(result.current.notice).toBe(
    "Task completed. Focus is temporarily unavailable.",
  );
  expect(result.current.mutationRevision).toBe(1);
});

it("keeps an uncertain batch completion selected and replays it once before settling Focus", async () => {
  const task = create(TaskSchema, {
    id: "batch-step",
    name: "tasks/batch-step",
    title: "Synthetic selected step",
    etag: "1",
    recurrence: "every day",
  });
  vi.spyOn(api, "listTasks").mockResolvedValue(
    create(ListTasksResponseSchema, { tasks: [task] }),
  );
  const receipts = new Set<string>();
  let occurrences = 0;
  const close = vi
    .spyOn(api, "completeTask")
    .mockImplementation(async (request) => {
      const requestId = request?.requestId || "";
      if (!receipts.has(requestId)) {
        receipts.add(requestId);
        occurrences++;
        throw new TypeError("Synthetic lost batch reply");
      }
      return create(TaskSchema, { ...task, etag: "2", completedCount: 1 });
    });
  const settle = vi
    .spyOn(focus, "settleCompletedTask")
    .mockResolvedValue(undefined);
  const route = { page: "inbox" as const, id: "" };
  const { result } = renderHook(() =>
    useTaskActions(
      route,
      "sort_order",
      useTaskView(route, "", "", "sort_order", false),
      "2026-10-17",
    ),
  );
  await waitFor(() => expect(result.current.selected.size).toBe(0));
  await waitFor(() => expect(api.listTasks).toHaveBeenCalled());
  await act(() => result.current.setSelected(new Set([task.id])));
  await act(() => result.current.batch("complete"));
  expect(result.current.selected.has(task.id)).toBe(true);
  await act(() => result.current.batch("complete"));
  expect(occurrences).toBe(1);
  expect(close.mock.calls[1]![0]).toEqual(close.mock.calls[0]![0]);
  expect(settle).toHaveBeenCalledWith(
    task,
    close.mock.calls[0]![0]!.requestId,
    "1",
    "2026-10-17",
  );
  expect(result.current.selected.size).toBe(0);
});

it("settles Focus after a confirmed completion even when the task list refresh fails", async () => {
  const task = create(TaskSchema, {
    id: "refresh-failure",
    name: "tasks/refresh-failure",
    title: "Synthetic task",
    etag: "1",
  });
  const source = vi
    .spyOn(api, "completeTask")
    .mockResolvedValue(create(TaskSchema, { ...task, completed: true }));
  let settled = false;
  vi.spyOn(focus, "settleCompletedTask").mockImplementation(async () => {
    settled = true;
    return undefined;
  });
  const list = {
    tasks: [task],
    replace: vi.fn(),
    remove: vi.fn(),
    read: vi.fn(async () => {
      expect(settled).toBe(true);
      throw new Error("Synthetic refresh failure");
    }),
  } as unknown as ReturnType<typeof useTaskView>;
  const { result } = renderHook(() =>
    useTaskActions({ page: "inbox", id: "" }, "sort_order", list),
  );
  await act(async () => {
    expect(await result.current.complete(task)).toBeUndefined();
  });
  expect(source).toHaveBeenCalledOnce();
  expect(result.current.notice).toMatch(
    /^Task completed\. The task list could not refresh/,
  );
});

it("keeps a confirmed batch completion successful when its final refresh fails", async () => {
  const task = create(TaskSchema, {
    id: "batch-refresh",
    name: "tasks/batch-refresh",
    title: "Synthetic task",
    etag: "1",
  });
  vi.spyOn(api, "completeTask").mockResolvedValue(
    create(TaskSchema, { ...task, completed: true }),
  );
  vi.spyOn(focus, "settleCompletedTask").mockResolvedValue(undefined);
  const list = {
    tasks: [task],
    read: vi.fn().mockRejectedValue(new Error("Synthetic refresh failure")),
  } as unknown as ReturnType<typeof useTaskView>;
  const { result } = renderHook(() =>
    useTaskActions({ page: "inbox", id: "" }, "sort_order", list),
  );
  await act(() => result.current.setSelected(new Set([task.id])));
  await act(() => result.current.batch("complete"));
  expect(result.current.selected.size).toBe(0);
  expect(result.current.notice).toMatch(
    /^Selected tasks completed.*could not refresh/,
  );
});

it("does not write generic task data for an unchanged draft while planning can save separately", async () => {
  const task = create(TaskSchema, {
    id: "unchanged-full-task",
    name: "tasks/unchanged-full-task",
    etag: "8",
    title: "Synthetic unchanged task",
    description: "Keep the complete description.",
    labelIds: ["synthetic-label"],
    kind: "task",
    effort: "deep",
  });
  const update = vi.spyOn(api, "updateTask");
  const listRead = vi
    .spyOn(api, "listTasks")
    .mockResolvedValue(create(ListTasksResponseSchema, { tasks: [task] }));
  const { result } = renderHook(() => {
    const list = useTaskView(
      { page: "inbox", id: "" },
      "",
      "",
      "sort_order",
      false,
    );
    return useTaskActions({ page: "inbox", id: "" }, "sort_order", list);
  });
  await waitFor(() => expect(listRead).toHaveBeenCalledTimes(1));
  let saved: Task | undefined;
  await act(async () => {
    saved = await result.current.saveTask(
      { ...task, labelIds: [...task.labelIds] },
      task,
    );
  });
  expect(saved).toBe(task);
  expect(saved?.description).toBe("Keep the complete description.");
  expect(update).not.toHaveBeenCalled();
  expect(listRead).toHaveBeenCalledTimes(1);
  expect(result.current.mutationRevision).toBe(0);
});

function listView() {
  return {
    tasks: [],
    setTasks: vi.fn(),
    nextPage: "",
    loading: false,
    error: "",
    setError: vi.fn(),
    read: vi.fn(async () => {}),
    replace: vi.fn(),
    remove: vi.fn(),
  };
}

it("replays a queued Plan completion with its original baseline, while the next occurrence gets a new identity", async () => {
  const first = create(TaskSchema, {
    id: "synthetic",
    name: "tasks/synthetic",
    etag: "before",
    recurrence: "every day",
  });
  const next = create(TaskSchema, {
    ...first,
    etag: "advanced",
    dueDate: "2026-10-20",
    completedCount: 1,
  });
  const close = vi.spyOn(api, "completeTask").mockResolvedValue(next);
  vi.spyOn(focus, "settleCompletedTask").mockResolvedValue(undefined);
  const list = listView();
  const { result } = renderHook(() =>
    useTaskActions({ page: "plan", id: "" }, "sort_order", list),
  );
  const finish = result.current.finishTask;
  const requestId = crypto.randomUUID();
  await act(async () => {
    await finish(first, requestId, "2026-10-19");
  });
  expect(result.current.finishTask).toBe(finish);
  await act(async () => {
    await result.current.finishTask(next, requestId, "2026-10-19");
  });
  expect(close.mock.calls.map(([body]) => [body.requestId, body.etag])).toEqual(
    [
      [requestId, "before"],
      [requestId, "before"],
    ],
  );
  const following = crypto.randomUUID();
  await act(async () => {
    await result.current.finishTask(next, following, "2026-10-20");
  });
  expect(close.mock.calls.at(-1)![0]).toMatchObject({
    requestId: following,
    etag: "advanced",
  });
});

it("Plan's finish action cannot turn into Reopen when a fresh read finds the task already completed", async () => {
  const completed = create(TaskSchema, {
    id: "synthetic",
    name: "tasks/synthetic",
    etag: "done",
    completed: true,
  });
  const close = vi.spyOn(api, "completeTask").mockResolvedValue(completed);
  const reopen = vi.spyOn(api, "reopenTask");
  vi.spyOn(focus, "settleCompletedTask").mockResolvedValue(undefined);
  const list = listView();
  const { result } = renderHook(() =>
    useTaskActions({ page: "plan", id: "" }, "sort_order", list),
  );
  await act(async () => {
    await result.current.finishTask(
      completed,
      crypto.randomUUID(),
      "2026-10-19",
    );
  });
  expect(close).toHaveBeenCalledOnce();
  expect(reopen).not.toHaveBeenCalled();
});
