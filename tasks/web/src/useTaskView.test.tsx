import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import { ListTasksResponseSchema } from "@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb";
import { api } from "./api";
import { useTaskView } from "./useTaskView";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps previous search results on failure without offering that query's stale next page", async () => {
  const task = create(TaskSchema, {
    id: "before",
    title: "Previous search result",
  });
  vi.spyOn(api, "listTasks")
    .mockResolvedValueOnce(
      create(ListTasksResponseSchema, {
        tasks: [task],
        nextPageToken: "previous-query-page",
      }),
    )
    .mockRejectedValueOnce(new Error("Synthetic unavailable search"));
  const { result, rerender } = renderHook(
    (query: string) =>
      useTaskView({ page: "search", id: "" }, query, "", "sort_order", false),
    { initialProps: "before" },
  );
  await waitFor(() => expect(result.current.tasks).toEqual([task]));
  expect(result.current.nextPage).toBe("previous-query-page");
  rerender("after");
  await waitFor(() => expect(result.current.error).not.toBe(""));
  expect(result.current.tasks).toEqual([task]);
  expect(result.current.nextPage).toBe("");
});
