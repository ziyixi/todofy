import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import {
  ProjectSchema,
  LabelSchema,
  SavedFilterSchema,
} from "@ziyixi/proto/tasks/ui/v1/task_pb";
import { TaskCountSchema } from "@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb";
import { Sidebar } from "./Sidebar";
import { EMPTY_CATALOG } from "../api";
import { readRoute } from "../routes";

const project = create(ProjectSchema, {
  id: "studio",
  title: "Synthetic studio",
});
const catalog = {
  ...EMPTY_CATALOG,
  projects: [project],
  labels: [
    create(LabelSchema, {
      id: "scope",
      title: "Synthetic scope",
      favorite: true,
    }),
  ],
  filters: [
    create(SavedFilterSchema, {
      id: "urgent",
      title: "Synthetic urgent",
      query: "p1",
      favorite: true,
    }),
  ],
  taskCounts: [
    create(TaskCountSchema, { view: "inbox", count: 2 }),
    create(TaskCountSchema, { view: "project", id: "studio", count: 3 }),
    create(TaskCountSchema, { view: "label", id: "scope", count: 1 }),
    create(TaskCountSchema, { view: "filter", id: "urgent", count: 0 }),
  ],
};
function sidebar() {
  return render(
    <Sidebar
      route={{ page: "inbox", id: "" }}
      catalog={catalog}
      onAddTask={vi.fn()}
      onTaskDrop={vi.fn()}
      onAddProject={vi.fn()}
      onEditCatalog={vi.fn()}
      onCatalogSaved={async () => {}}
      onError={vi.fn()}
    />,
  );
}
const browserStorage = (
  globalThis as typeof globalThis & { jsdom: { window: Window } }
).jsdom.window.localStorage;
beforeEach(() => vi.stubGlobal("localStorage", browserStorage));
afterEach(() => {
  cleanup();
  browserStorage.clear();
  vi.unstubAllGlobals();
});

it("shows exact category counts without renaming navigation or inventing planning counts", () => {
  sidebar();
  for (const [name, count] of [
    ["Inbox", "2"],
    ["Synthetic studio", "3"],
    ["Synthetic scope", "1"],
    ["Synthetic urgent", "0"],
  ]) {
    expect(
      screen.getByRole("link", { name }).querySelector(".category-count")
        ?.textContent,
    ).toBe(count);
  }
  expect(
    screen.getByRole("link", { name: "Plan" }).querySelector(".category-count"),
  ).toBeNull();
  expect(screen.queryByRole("link", { name: "Planning settings" })).toBeNull();
  expect(screen.getByRole("link", { name: "Labels & filters" })).toBeTruthy();
});

it("collapses My projects using its real button and remembers the choice after reload", () => {
  const view = sidebar();
  const toggle = screen.getByRole("button", { name: "My projects" });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("link", { name: project.title })).toBeNull();
  view.unmount();
  sidebar();
  expect(
    screen
      .getByRole("button", { name: "My projects" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "My projects" }));
  expect(screen.getByRole("link", { name: project.title })).toBeTruthy();
});

it("keeps old settings bookmarks useful without retaining an empty settings page", () => {
  expect(readRoute("#/settings")).toEqual({ page: "plan", id: "" });
});
