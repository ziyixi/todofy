import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import { ListTasksResponseSchema } from "@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb";
import { RpcStatusError } from "@ziyixi/proto/http-client";
import { parseStatus } from "@ziyixi/proto/rpc-status";
import { api, type TaskDraft } from "./api";
import type { Route } from "./routes";
import { useTaskActions } from "./useTaskActions";
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
  let saved!: Promise<void>;
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
  await act(() => result.current.saveTask(task as TaskDraft, task));
  expect(result.current.mutationRevision).toBe(1);
  await act(() => result.current.complete(task));
  expect(result.current.mutationRevision).toBe(2);
  await act(() => result.current.deleteTask(task));
  expect(result.current.mutationRevision).toBe(3);
  update.mockRejectedValueOnce(new Error("Synthetic failed write"));
  await act(async () => {
    await expect(
      result.current.saveTask(task as TaskDraft, task),
    ).rejects.toThrow("Synthetic failed write");
  });
  expect(result.current.mutationRevision).toBe(3);
  expect(read).not.toHaveBeenCalled();
});
