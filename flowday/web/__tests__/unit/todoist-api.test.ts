import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchTodoistProjects, fetchTodoistTasks } from "@/lib/todoist/api";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("todoist api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("paginates task results until next_cursor is exhausted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ id: "task-1" }],
          next_cursor: "cursor-2",
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ id: "task-2" }],
          next_cursor: null,
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const tasks = await fetchTodoistTasks("secret-key");

    expect(tasks.map((task) => task.id)).toEqual(["task-1", "task-2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.todoist.com/api/v1/tasks?limit=200"
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api.todoist.com/api/v1/tasks?limit=200&cursor=cursor-2"
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        headers: { Authorization: "Bearer secret-key" },
        cache: "no-store",
      })
    );
  });

  it("paginates project results with the same cursor contract", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ id: "project-1", name: "Inbox", color: "blue" }],
          next_cursor: "cursor-2",
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ id: "project-2", name: "Work", color: "orange" }],
          next_cursor: null,
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const projects = await fetchTodoistProjects("secret-key");

    expect(projects.map((project) => project.id)).toEqual(["project-1", "project-2"]);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api.todoist.com/api/v1/projects?limit=200&cursor=cursor-2"
    );
  });

  it("throws a descriptive error when Todoist returns a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad gateway", {
        status: 502,
        statusText: "Bad Gateway",
      }))
    );

    await expect(fetchTodoistTasks("secret-key")).rejects.toThrow(
      "Todoist API error: 502 Bad Gateway"
    );
  });
});
