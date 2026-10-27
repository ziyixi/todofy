import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import { ListTasksResponseSchema } from "@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb";
import { api } from "./api";
import { useTaskView } from "./useTaskView";
import { readRoute, routeHref } from "./routes";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("routes Goals and its result links without loading an ordinary task view", async () => {
  const requests = vi.spyOn(api, "listTasks");
  const route = readRoute("#/goals/synthetic-result");
  expect(route).toEqual({ page: "goals", id: "synthetic-result" });
  expect(routeHref(route)).toBe("#/goals/synthetic-result");
  const { result } = renderHook(() =>
    useTaskView(route, "", "", "sort_order", false),
  );
  await result.current.read();
  expect(requests).not.toHaveBeenCalled();
  expect(result.current.tasks).toEqual([]);
});

it("reads no ListTasks view for GTD, on open or after a write", async () => {
  const requests = vi.spyOn(api, "listTasks");
  const { result } = renderHook(() =>
    useTaskView(readRoute("#/gtd/time"), "", "", "sort_order", false),
  );
  await result.current.read();
  await result.current.refresh();
  expect(requests).not.toHaveBeenCalled();
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

it("after a write, keeps the pages the owner loaded instead of collapsing to the first", async () => {
  const page = (start: number, count: number) =>
    Array.from({ length: count }, (_, index) =>
      create(TaskSchema, { id: `task-${String(start + index)}` }),
    );
  const pages: Record<
    string,
    { tasks: ReturnType<typeof page>; next: string }
  > = {
    "": { tasks: page(0, 100), next: "second" },
    second: { tasks: page(100, 100), next: "third" },
    third: { tasks: page(200, 20), next: "" },
  };
  const requests = vi
    .spyOn(api, "listTasks")
    .mockImplementation(async (request) => {
      const answer = pages[request?.pageToken ?? ""]!;
      return create(ListTasksResponseSchema, {
        tasks: answer.tasks,
        nextPageToken: answer.next,
      });
    });
  const { result } = renderHook(() =>
    useTaskView({ page: "inbox", id: "" }, "", "", "sort_order", false),
  );
  await waitFor(() => expect(result.current.tasks).toHaveLength(100));
  await result.current.refresh();
  expect(requests.mock.calls.map(([request]) => request?.pageToken)).toEqual([
    "",
    "",
  ]);
  await result.current.read("second");
  await waitFor(() => expect(result.current.tasks).toHaveLength(200));
  requests.mockClear();
  await result.current.refresh();
  await waitFor(() => expect(result.current.nextPage).toBe("third"));
  expect(requests.mock.calls.map(([request]) => request?.pageToken)).toEqual([
    "",
    "second",
  ]);
  expect(result.current.tasks).toHaveLength(200);
});
