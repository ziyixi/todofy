import { expect, it } from "vitest";
import { createPlanningActions } from "../src/api";
import type { HttpCall, HttpSend } from "@ziyixi/proto/http-client";

it("reads native mail references and refuses another store's labels without changing task IDs", async () => {
  const plus: HttpSend = async () =>
    Response.json({
      items: [
        {
          id: "mail-event",
          task: { provider: "tasks", external_id: "old-todoist-id" },
          receive_time: "2026-10-17T12:00:00Z",
          brief: "Synthetic brief",
        },
      ],
      categories: [
        {
          id: "work",
          label: { provider: "tasks", external_id: "work" },
          priority: "p2",
        },
        {
          id: "legacy",
          label: { provider: "todoist", external_id: "old-work" },
          priority: "p2",
        },
      ],
      categories_etag: "1",
    });
  const api = createPlanningActions(
    { plus, flowday: plus },
    undefined,
    "tasks",
  );
  const result = await api.lookupMail(["old-todoist-id"]);
  expect(result.items[0]?.taskId).toBe("old-todoist-id");
  expect(result.categories).toEqual([
    { id: "work", labelId: "work", priority: 2 },
  ]);
});
it("sends category edits through the host transport with the selected store", async () => {
  const calls: HttpCall[] = [];
  const plus: HttpSend = async (call) => {
    calls.push(call);
    return Response.json({
      categories: [
        {
          id: "work",
          label: { provider: "tasks", external_id: "work" },
          priority: "p2",
        },
      ],
      etag: "2",
    });
  };
  const api = createPlanningActions(
    { plus, flowday: plus },
    undefined,
    "tasks",
  );
  const result = await api.updateMailSettings(
    [{ labelId: "work", priority: 2 }],
    "1",
  );
  expect(calls[0]?.url).toBe("/api/plus/v1/mailSettings:updateMailSettings");
  expect(JSON.parse(calls[0]!.body!)).toMatchObject({
    categories: [
      { label: { provider: "tasks", external_id: "work" }, priority: "p2" },
    ],
    etag: "1",
  });
  expect(result.categories[0]?.labelId).toBe("work");
});
