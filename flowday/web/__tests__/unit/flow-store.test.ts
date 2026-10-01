import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { format } from "date-fns";
import { useFlowStore } from "@/features/flow/store";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

  it("adds tasks optimistically and persists the flow order", () => {
    const requestBodies: Array<{
      action: string;
      date: string;
      taskIds?: string[];
      taskId?: string;
    }> = [];
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        requestBodies.push(
          JSON.parse(String(init?.body)) as {
            action: string;
            date: string;
            taskIds?: string[];
            taskId?: string;
          }
        );
        return jsonResponse({ success: true });
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    useFlowStore.getState().addTask("task-1", "2026-04-13");

    const state = useFlowStore.getState();
    expect(state.flows["2026-04-13"]).toEqual(["task-1"]);
    expect(state.sortableGen).toBe(1);
    expect(state.sortableKeys["task-1"]).toBe(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/flows",
      expect.objectContaining({ method: "PUT" })
    );
    expect(requestBodies).toEqual([{
      action: "setFlow",
      date: "2026-04-13",
      taskIds: ["task-1"],
    }]);
  });

  it("moves tasks between flow and completed lists optimistically", () => {
    const requestBodies: Array<{
      action: string;
      date: string;
      taskIds?: string[];
      taskId?: string;
    }> = [];
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        requestBodies.push(
          JSON.parse(String(init?.body)) as {
            action: string;
            date: string;
            taskIds?: string[];
            taskId?: string;
          }
        );
        return jsonResponse({ success: true });
      }
    );
    vi.stubGlobal("fetch", fetchMock);
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

    const actions = requestBodies.map((body) => body.action);
    expect(actions).toEqual([
      "setFlow",
      "addCompleted",
      "setFlow",
      "removeCompleted",
    ]);
  });

  it("rehydrates from the server when a flow persistence write fails", async () => {
    const today = format(new Date(), "yyyy-MM-dd");
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";

      if (url === "/api/flows" && method === "PUT") {
        return new Response(null, { status: 500 });
      }

      if (url === "/api/flows" && method === "GET") {
        return jsonResponse({
          flows: { "2026-04-13": ["server-task"] },
          completedTasks: { "2026-04-13": ["done-task"] },
        });
      }

      if (url.startsWith("/api/settings?today=") && method === "GET") {
        return jsonResponse({
          day_capacity_mins: 420,
          planning_completed_today: true,
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

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
