import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { format } from "date-fns";
import { useFlowStore } from "@/features/flow/store";
import { addCompletedFlowTask, fakeFetch, fakeWorker, setFlowTaskIds, setSetting } from "../helpers/fake-worker";

function resetFlowStore() {
  useFlowStore.setState({
    currentDate: "2026-04-13",
    viewMode: 1,
    flows: {},
    completedTasks: {},
    sortableGen: 0,
    sortableKeys: {},
    quickFocusTaskIds: {},
    dayCapacityMins: 360,
    hydrated: false,
    planningCompletedDates: {},
  });
}

describe("flow store", () => {
  beforeEach(() => {
    resetFlowStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetFlowStore();
  });

  it("adds tasks optimistically and persists the flow order", async () => {
    vi.stubGlobal("fetch", fakeFetch);

    useFlowStore.getState().addTask("task-1", "2026-04-13");

    const state = useFlowStore.getState();
    expect(state.flows["2026-04-13"]).toEqual(["task-1"]);
    expect(state.sortableGen).toBe(1);
    expect(state.sortableKeys["task-1"]).toBe(1);

    // The write left synchronously (writes keep their order).
    expect(fakeWorker.requests.map((request) => [request.method, request.path, request.body])).toEqual([
      ["PATCH", "/api/v1/flows/2026-04-13?update_mask=task_ids", { task_ids: ["task-1"] }],
    ]);
    await vi.waitFor(() => expect(fakeWorker.flows.get("2026-04-13")).toEqual(["task-1"]));
  });

  it("moves tasks between flow and completed lists optimistically", async () => {
    vi.stubGlobal("fetch", fakeFetch);
    setFlowTaskIds("2026-04-13", ["task-1"]);
    useFlowStore.setState({
      flows: { "2026-04-13": ["task-1"] },
      completedTasks: { "2026-04-13": [] },
    });

    useFlowStore.getState().completeTask("task-1", "2026-04-13");
    let state = useFlowStore.getState();
    expect(state.flows["2026-04-13"]).toEqual([]);
    expect(state.completedTasks["2026-04-13"]).toEqual(["task-1"]);

    useFlowStore.getState().uncompleteTask("task-1", "2026-04-13");
    state = useFlowStore.getState();
    expect(state.flows["2026-04-13"]).toEqual(["task-1"]);
    expect(state.completedTasks["2026-04-13"]).toEqual([]);

    expect(fakeWorker.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "PATCH /api/v1/flows/2026-04-13?update_mask=task_ids",
      "POST /api/v1/flows/2026-04-13:completeTask",
      "PATCH /api/v1/flows/2026-04-13?update_mask=task_ids",
      "POST /api/v1/flows/2026-04-13:reopenTask",
    ]);
    await vi.waitFor(() => expect(fakeWorker.completed.get("2026-04-13")).toEqual([]));
    expect(fakeWorker.flows.get("2026-04-13")).toEqual(["task-1"]);
  });

  it("rolls over selected tasks, and asks nothing for an empty selection", async () => {
    vi.stubGlobal("fetch", fakeFetch);
    setFlowTaskIds("2026-04-13", ["a", "b", "c"]);
    await useFlowStore.getState().rolloverSelectedTasks("2026-04-13", "2026-04-14", ["a", "c"]);
    expect(useFlowStore.getState().flows).toEqual({ "2026-04-13": ["b"], "2026-04-14": ["a", "c"] });
    fakeWorker.requests = [];
    await useFlowStore.getState().rolloverSelectedTasks("2026-04-13", "2026-04-15", []);
    expect(fakeWorker.requests.map((request) => request.method)).toEqual(["GET"]);
    expect(useFlowStore.getState().flows["2026-04-13"]).toEqual(["b"]);
  });

  it("rehydrates from the server when a flow persistence write fails", async () => {
    const today = format(new Date(), "yyyy-MM-dd");
    setFlowTaskIds("2026-04-13", ["server-task"]);
    addCompletedFlowTask("2026-04-13", "done-task");
    fakeWorker.planned.add(today);
    setSetting("day_capacity_mins", "420");
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PATCH") return new Response(null, { status: 500 });
      return fakeFetch(input, init);
    });

    useFlowStore.getState().addTask("task-1", "2026-04-13");
    await vi.waitFor(() => {
      const state = useFlowStore.getState();
      expect(state.flows["2026-04-13"]).toEqual(["server-task"]);
      expect(state.completedTasks["2026-04-13"]).toEqual(["done-task"]);
      expect(state.dayCapacityMins).toBe(420);
      expect(state.planningCompletedDates[today]).toBe(true);
      expect(state.hydrated).toBe(true);
    });
  });
});
