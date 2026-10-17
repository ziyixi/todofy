import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import { api, type TaskDraft } from "./api";
import { useTaskActions } from "./useTaskActions";
import { useTaskView } from "./useTaskView";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
