import { expect, it } from "vitest";
import { pageStatus, statusLine } from "../src/page-status";

it("keeps a status made only of known keys", () => {
  const status = { language: "zh", off: { taskTools: "taskIdMismatch" } };
  expect(pageStatus(status)).toEqual(status);
  expect(pageStatus({ language: "en", off: {} })).toEqual({
    language: "en",
    off: {},
  });
});

it("rejects anything outside the closed key sets, so no page content can be stored", () => {
  for (const value of [
    null,
    "views",
    [],
    { language: "en" },
    { language: "en", off: [] },
    { language: "fr", off: {} },
    { language: "en", off: {}, url: "https://app.todoist.com/app/task/1" },
    { language: "en", off: { title: "sidebar" } },
    { language: "en", off: { views: "Synthetic task title" } },
    { language: "en", off: { views: 1 } },
  ])
    expect(pageStatus(value), JSON.stringify(value)).toBeUndefined();
});

it("reads as one line in the Todoist page's language", () => {
  expect(statusLine({ language: "zh", off: {} })).toBe(
    "Todoist 页面检测：全部正常",
  );
  expect(statusLine({ language: "en", off: {} })).toBe(
    "Todoist page check: all good",
  );
  expect(
    statusLine({
      language: "en",
      off: { views: "sidebar", taskTools: "taskIdMismatch" },
    }),
  ).toBe(
    "Todoist page check: Plan and Focus are off (the sidebar was not found); Steps & timing is off (the task ID did not match the page link)",
  );
  expect(statusLine({ language: "zh", off: { taskTools: "detailMain" } })).toBe(
    "Todoist 页面检测：步骤与时间已关闭（找不到任务详情区域）",
  );
  expect(statusLine(undefined)).toBe(
    "Todoist page check: open Todoist to run it",
  );
});
