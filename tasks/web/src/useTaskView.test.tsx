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

it("does not send an empty search, and clearing a search removes its stale results and error", async () => {
  const task = create(TaskSchema, {
    id: "search-result",
    title: "Synthetic result",
  });
  const requests = vi
    .spyOn(api, "listTasks")
    .mockResolvedValue(
      create(ListTasksResponseSchema, {
        tasks: [task],
        nextPageToken: "next-result",
      }),
    );
  const { result, rerender } = renderHook(
    (query: string) =>
      useTaskView({ page: "search", id: "" }, query, "", "sort_order", false),
    { initialProps: "" },
  );
  expect(result.current.loading).toBe(false);
  await result.current.read();
  expect(requests).not.toHaveBeenCalled();
  rerender("Synthetic");
  await waitFor(() => expect(result.current.tasks).toEqual([task]));
  expect(requests).toHaveBeenCalledTimes(1);
  rerender("  ");
  await waitFor(() => expect(result.current.tasks).toEqual([]));
  expect(result.current.nextPage).toBe("");
  expect(result.current.error).toBe("");
  expect(result.current.loading).toBe(false);
  expect(requests).toHaveBeenCalledTimes(1);
});

it("ignores a pending search response after the search is cleared", async () => {
  let finish!: (
    value: ReturnType<typeof create<typeof ListTasksResponseSchema>>,
  ) => void;
  const requests = vi.spyOn(api, "listTasks").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result, rerender } = renderHook(
    (query: string) =>
      useTaskView({ page: "search", id: "" }, query, "", "sort_order", false),
    { initialProps: "pending" },
  );
  await waitFor(() => expect(requests).toHaveBeenCalledOnce());
  rerender("");
  finish(
    create(ListTasksResponseSchema, {
      tasks: [create(TaskSchema, { id: "stale", title: "Stale" })],
    }),
  );
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.tasks).toEqual([]);
  expect(result.current.error).toBe("");
});
