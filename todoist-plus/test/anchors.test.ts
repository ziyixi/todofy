import { expect, it } from "vitest";
import {
  ANCHORS,
  detailTask,
  find,
  findAll,
  keepsVisible,
} from "../src/anchors";

function modal(html: string) {
  const element = document.createElement("section");
  element.innerHTML = html;
  return element;
}
// A parent breadcrumb with its own ID renders before the edited task's selection list.
const breadcrumbFirst = modal(
  `<a data-item-id="parent">Synthetic project</a><div data-testid="task-selection-list-container"><div data-item-id="child"></div><div data-item-id="grandchild"></div></div>`,
);

it("takes the selection list's first row, not the first ID in the modal", () => {
  expect(
    detailTask(breadcrumbFirst, "https://app.todoist.com/app/task/child"),
  ).toEqual({ id: "child" });
  expect(
    detailTask(
      breadcrumbFirst,
      "https://app.todoist.com/app/project/work-p1/task/write-it-child",
    ),
  ).toEqual({ id: "child" });
});

it("attaches nothing when the task link names another task", () => {
  expect(
    detailTask(breadcrumbFirst, "https://app.todoist.com/app/task/parent"),
  ).toEqual({ off: "taskIdMismatch" });
  expect(
    detailTask(
      breadcrumbFirst,
      "https://app.todoist.com/app/task/someone-elses-child-2",
    ),
  ).toEqual({ off: "taskIdMismatch" });
});

it("keeps today's lookup when the URL is not a task link", () => {
  expect(
    detailTask(breadcrumbFirst, "https://app.todoist.com/app/today"),
  ).toEqual({ id: "child" });
  const noList = modal(`<div><div data-item-id="only"></div></div>`);
  expect(detailTask(noList, "https://app.todoist.com/app/inbox")).toEqual({
    id: "only",
  });
  // A task not saved yet is no Todoist change.
  const unsaved = modal(
    `<div data-testid="task-selection-list-container"><div data-item-id="tmp-1"></div></div>`,
  );
  expect(detailTask(unsaved, "https://app.todoist.com/app/today")).toEqual({
    id: undefined,
  });
  expect(
    detailTask(modal(`<h2>No rows</h2>`), "https://app.todoist.com/app/today"),
  ).toEqual({ off: "detailRow" });
});

it("tries each anchor's selectors in table order, not document order", () => {
  document.body.innerHTML = `<main id="first-main"></main><div id="content"></div><aside data-testid="app-sidebar-scrollable-container"><ul><li class="current" id="by-class"></li><li><a aria-current="page" id="by-aria" href="/app/inbox"></a></li></ul></aside>`;
  expect(find("content")?.id).toBe("content");
  expect(findAll("current", find("sidebar")).map((item) => item.id)).toEqual([
    "by-aria",
  ]);
  document.querySelector("#by-aria")!.removeAttribute("aria-current");
  expect(findAll("current", find("sidebar")).map((item) => item.id)).toEqual([
    "by-class",
  ]);
  document.querySelector("#content")!.remove();
  expect(find("content")?.id).toBe("first-main");
  document.querySelector("aside")!.remove();
  expect(find("sidebar")).toBeUndefined();
  // The retired #left_menu fallback had no match on the live page.
  expect(ANCHORS.sidebar).toEqual([
    "[data-testid=app-sidebar-scrollable-container]",
  ]);
  document.body.innerHTML = "";
});

it("leaves Todoist's dialogs, alerts and toasts visible", () => {
  const element = (html: string) => modal(html).firstElementChild!;
  expect(keepsVisible(element(`<div role="dialog"></div>`))).toBe(true);
  expect(keepsVisible(element(`<div role="alertdialog"></div>`))).toBe(true);
  expect(keepsVisible(element(`<div role="alert"></div>`))).toBe(true);
  expect(keepsVisible(element(`<div role="status"></div>`))).toBe(true);
  expect(keepsVisible(element(`<div aria-modal="true"></div>`))).toBe(true);
  expect(keepsVisible(element(`<dialog></dialog>`))).toBe(true);
  expect(keepsVisible(element(`<section><h1>List</h1></section>`))).toBe(false);
});
