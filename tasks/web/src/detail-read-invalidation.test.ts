import { afterEach, expect, it, vi } from "vitest";
import { TasksUiService } from "@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb";
import { send } from "./api";
import {
  clearDetailReadCache,
  peekDetailRead,
  readDetail,
} from "./detail-read-cache";

afterEach(() => {
  clearDetailReadCache();
  vi.unstubAllGlobals();
});

it("keeps other details after successful reads but clears them on auth failure or CAS conflict", async () => {
  let status = 200;
  vi.stubGlobal("fetch", async () => new Response("{}", { status }));
  await readDetail("task:example", async () => "confirmed");
  await send({
    method: TasksUiService.method.getTask,
    httpMethod: "GET",
    url: "/api/tasks/v1/tasks/other",
    body: undefined,
  });
  expect(peekDetailRead("task:example")).toBe("confirmed");
  for (status of [401, 403, 409]) {
    await readDetail("task:example", async () => "confirmed");
    await send({
      method: TasksUiService.method.getTask,
      httpMethod: "GET",
      url: "/api/tasks/v1/tasks/other",
      body: undefined,
    });
    expect(peekDetailRead("task:example")).toBeUndefined();
  }
});

it("clears both detail kinds after a confirmed write and an uncertain write response", async () => {
  vi.stubGlobal("fetch", async (url: string) =>
    url === "/api/tasks/csrf"
      ? Response.json({ token: "synthetic" })
      : Response.json({}),
  );
  await readDetail("task:example", async () => "confirmed");
  await readDetail("planning:example:1", async () => "flags");
  await send({
    method: TasksUiService.method.createTask,
    httpMethod: "POST",
    url: "/api/tasks/v1/tasks",
    body: "{}",
  });
  expect(peekDetailRead("task:example")).toBeUndefined();
  expect(peekDetailRead("planning:example:1")).toBeUndefined();
  await readDetail("task:example", async () => "confirmed");
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("Synthetic lost response");
  });
  await expect(
    send({
      method: TasksUiService.method.updateTask,
      httpMethod: "PATCH",
      url: "/api/tasks/v1/tasks/example",
      body: "{}",
    }),
  ).rejects.toThrow();
  expect(peekDetailRead("task:example")).toBeUndefined();
});
