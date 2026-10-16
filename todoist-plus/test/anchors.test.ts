import { expect, it } from "vitest";
import { detailTaskId, keepsVisible } from "../src/anchors";

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
    detailTaskId(breadcrumbFirst, "https://app.todoist.com/app/task/child"),
  ).toBe("child");
  expect(
    detailTaskId(
      breadcrumbFirst,
      "https://app.todoist.com/app/project/work-p1/task/write-it-child",
    ),
  ).toBe("child");
});

it("attaches nothing when the task link names another task", () => {
  expect(
    detailTaskId(breadcrumbFirst, "https://app.todoist.com/app/task/parent"),
  ).toBeUndefined();
  expect(
    detailTaskId(
      breadcrumbFirst,
      "https://app.todoist.com/app/task/someone-elses-child-2",
    ),
  ).toBeUndefined();
});

it("keeps today's lookup when the URL is not a task link", () => {
  expect(
    detailTaskId(breadcrumbFirst, "https://app.todoist.com/app/today"),
  ).toBe("child");
  const noList = modal(`<div><div data-item-id="only"></div></div>`);
  expect(detailTaskId(noList, "https://app.todoist.com/app/inbox")).toBe(
    "only",
  );
  const unsaved = modal(
    `<div data-testid="task-selection-list-container"><div data-item-id="tmp-1"></div></div>`,
  );
  expect(
    detailTaskId(unsaved, "https://app.todoist.com/app/today"),
  ).toBeUndefined();
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
