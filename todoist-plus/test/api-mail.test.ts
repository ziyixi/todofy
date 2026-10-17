import { expect, it } from "vitest";
import { createApi } from "../src/api";
import type { PlanningTask } from "../src/model";

type Call = { path: string; method: string; search: string; body: unknown };

/** The extension's API client over a synthetic Todofy that answers `reply` for each path. */
function client(reply: (call: Call) => unknown) {
  const calls: Call[] = [];
  const api = createApi(
    { apiOrigin: "https://api.example.test", token: "synthetic" },
    async (input, init) => {
      const url = new URL(String(input));
      const call = {
        path: url.pathname,
        method: init?.method ?? "GET",
        search: url.search,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return Response.json(reply(call));
    },
  );
  return { api, calls };
}
const task: PlanningTask = {
  id: "mail-1",
  title: "Synthetic mail",
  parentId: "",
  projectId: "mail",
  labels: [],
  area: "unassigned",
  stage: "none",
  priority: 1,
  deadline: "",
  due: "",
  leadDays: 0,
  estimatedMinutes: 15,
  etag: "task-1",
  mustStart: false,
  missingLead: false,
};

it("asks about mail 200 tasks a request, and once with none for the categories alone", async () => {
  const { api, calls } = client(({ body }) => {
    const ids = (body as { task_ids?: string[] }).task_ids ?? [];
    return {
      items: ids
        .filter((id) => id.endsWith("0"))
        .map((id) => ({
          id: `event-${id}`,
          task: { provider: "todoist", external_id: id },
          brief: "Synthetic brief.",
          receive_time: "2026-10-16T09:42:00Z",
          has_summary: true,
        })),
      categories: [
        {
          id: "7",
          label: { provider: "todoist", external_id: "label-office" },
          priority: "p2",
        },
        // Another store's label is not Plus's to file by.
        {
          id: "8",
          label: { provider: "elsewhere", external_id: "x" },
          priority: "p4",
        },
      ],
      categories_etag: "categories-1",
      // Todofy still answers an old build's destination, which filing no longer uses.
      destination: { provider: "todoist", external_id: "project-work" },
    };
  });
  const ids = Array.from({ length: 201 }, (_, index) => `t${index}`);
  const lookup = await api.lookupMail(ids);
  expect(calls.map((call) => [call.path, call.method])).toEqual([
    ["/api/plus/v1/mailItems:lookup", "POST"],
    ["/api/plus/v1/mailItems:lookup", "POST"],
  ]);
  expect(
    calls.map((call) => (call.body as { task_ids: string[] }).task_ids.length),
  ).toEqual([200, 1]);
  expect(lookup.items).toHaveLength(21); // t0, t10, …, t200
  expect(lookup.items[0]).toEqual({
    id: "event-t0",
    taskId: "t0",
    brief: "Synthetic brief.",
    receivedAt: "2026-10-16T09:42:00.000Z",
    hasSummary: true,
  });
  expect(lookup.categories).toEqual([
    { id: "7", labelId: "label-office", priority: 2 },
  ]);
  expect(lookup.etag).toBe("categories-1");
  expect(lookup).not.toHaveProperty("destination");
  calls.length = 0;
  await api.lookupMail([]);
  expect(calls.map((call) => call.body)).toEqual([{ task_ids: [] }]);
});

it("reads one summary by mail ID, and the categories without the Inbox Todofy answers old builds", async () => {
  const { api, calls } = client(({ path }) =>
    path.endsWith(":readMailSummary")
      ? { summary: "Line one.\n\nLine two." }
      : {
          categories: [],
          etag: "settings-0",
          destination: { provider: "todoist", external_id: "inbox-1" },
          projects: [{ id: "inbox-1", display_name: "Inbox", inbox: true }],
        },
  );
  expect(await api.readMailSummary("event-1")).toBe("Line one.\n\nLine two.");
  expect(calls[0]).toMatchObject({
    path: "/api/plus/v1/mailItems:readMailSummary",
    method: "GET",
    search: "?id=event-1",
  });
  expect(await api.readMailSettings()).toEqual({
    categories: [],
    etag: "settings-0",
  });
});

it("saves categories, files by a category or into the Inbox alone, and deletes, with Todofy's references and request IDs", async () => {
  const { api, calls } = client(({ path, body }) => {
    if (path.endsWith(":updateMailSettings"))
      return {
        categories: [
          {
            id: "3",
            label: { provider: "todoist", external_id: "label-home" },
            priority: "p1",
          },
        ],
        etag: "settings-2",
        // The destination an old build saved, which Todofy keeps and ignores.
        destination: { provider: "todoist", external_id: "project-old" },
      };
    if (path.endsWith(":fileMailItem"))
      return (body as { category_id: string }).category_id
        ? {
            task: {
              id: "mail-1",
              title: "Synthetic mail",
              project_id: "account-inbox",
              labels: ["home"],
              area: "personal",
              priority: 4,
              etag: "task-2",
            },
          }
        : {
            task: {
              id: "mail-2",
              title: "Another synthetic mail",
              project_id: "account-inbox",
              etag: "task-3",
            },
          };
    return { deleted_task_ids: ["mail-1"], kept_task_ids: ["mail-2"] };
  });
  expect(
    await api.updateMailSettings(
      [{ labelId: "label-home", priority: 1 }],
      "settings-1",
    ),
  ).toEqual({
    categories: [{ id: "3", labelId: "label-home", priority: 1 }],
    etag: "settings-2",
  });
  // The destination is still REQUIRED on the wire; Todofy ignores it since protocol 6.
  expect(calls[0]!.body).toEqual({
    categories: [
      {
        label: { provider: "todoist", external_id: "label-home" },
        priority: "p1",
      },
    ],
    destination: { provider: "todoist", external_id: "inbox" },
    etag: "settings-1",
  });
  const filed = await api.fileMail(
    task,
    { id: "3", labelId: "label-home", priority: 1 },
    "settings-2",
    "11111111-1111-4111-8111-111111111111",
  );
  expect(calls[1]).toMatchObject({
    path: "/api/plus/v1/mailItems:fileMailItem",
    body: {
      task_id: "mail-1",
      etag: "task-1",
      request_id: "11111111-1111-4111-8111-111111111111",
      category_id: "3",
      categories_etag: "settings-2",
    },
  });
  // Todoist's API priority 4 is P1; FlowDay's estimate stays the one shown.
  expect(filed).toMatchObject({
    projectId: "account-inbox",
    area: "personal",
    priority: 4,
    estimatedMinutes: 15,
    etag: "task-2",
  });
  // Without a category: an empty category ID, which Todofy files as a move alone, and no
  // categories etag, which Todofy would not check.
  const moved = await api.fileMail(
    { ...task, id: "mail-2", etag: "task-1b" },
    undefined,
    "settings-2",
    "33333333-3333-4333-8333-333333333333",
  );
  expect(calls[2]).toMatchObject({
    path: "/api/plus/v1/mailItems:fileMailItem",
    body: {
      task_id: "mail-2",
      etag: "task-1b",
      request_id: "33333333-3333-4333-8333-333333333333",
      category_id: "",
      categories_etag: "",
    },
  });
  expect(moved).toMatchObject({ id: "mail-2", projectId: "account-inbox" });
  expect(
    await api.deleteMail(
      ["mail-1", "mail-2"],
      "22222222-2222-4222-8222-222222222222",
    ),
  ).toEqual({ deletedTaskIds: ["mail-1"], keptTaskIds: ["mail-2"] });
  expect(calls[3]).toMatchObject({
    path: "/api/plus/v1/mailItems:deleteMailItems",
    body: {
      request_id: "22222222-2222-4222-8222-222222222222",
      task_ids: ["mail-1", "mail-2"],
    },
  });
});
