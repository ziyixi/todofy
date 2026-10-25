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
import { EMPTY_CATALOG, type Catalog } from "../api";
import { readRoute, type Route } from "../routes";

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
    ...["search", "upcoming", "mail", "plan", "focus", "gtd"].map((view) =>
      create(TaskCountSchema, { view, count: 9 }),
    ),
  ],
};
function sidebar(
  nextCatalog: Catalog = catalog,
  onAddTask = vi.fn(),
  route: Route = { page: "inbox", id: "" },
) {
  return render(
    <Sidebar
      route={route}
      catalog={nextCatalog}
      onAddTask={onAddTask}
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

it.each(["#/gtd/time", "#/gtd/completion", "#/focus/2026-10-19"])(
  "keeps the main navigation selected for %s",
  (href) => {
    const route = readRoute(href);
    sidebar(catalog, vi.fn(), route);
    const title = route.page === "gtd" ? "GTD" : "Focus";
    expect(
      screen.getByRole("link", { name: title }).getAttribute("aria-current"),
    ).toBe("page");
  },
);

it("shows positive category counts and keeps other navigation free of count badges", () => {
  sidebar();
  for (const [name, count] of [
    ["Inbox", "2"],
    ["Synthetic studio", "3"],
    ["Synthetic scope", "1"],
  ]) {
    expect(
      screen.getByRole("link", { name }).querySelector(".category-count")
        ?.textContent,
    ).toBe(count);
  }
  for (const name of [
    "Synthetic urgent",
    "Search",
    "Upcoming",
    "Mail",
    "Goals",
    "Plan",
    "Focus",
    "GTD",
  ])
    expect(
      screen.getByRole("link", { name }).querySelector(".category-count"),
    ).toBeNull();
  expect(screen.queryByRole("link", { name: "Planning settings" })).toBeNull();
  expect(screen.getByRole("link", { name: "Labels & filters" })).toBeTruthy();
});

it("places Search before Add task and groups the existing task and planning routes", () => {
  const onAddTask = vi.fn();
  sidebar(catalog, onAddTask);
  const search = screen.getByRole("link", { name: "Search" });
  const add = screen.getByRole("button", { name: /Add task/ });
  expect(
    search.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Tasks" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Planning" })).toBeTruthy();
  const navigation = screen.getByRole("navigation", {
    name: "Main navigation",
  });
  expect(
    [...navigation.querySelectorAll("a")].map((link) =>
      link.getAttribute("href"),
    ),
  ).toEqual([
    "#/inbox",
    "#/today",
    "#/upcoming",
    "#/mail",
    "#/goals",
    "#/plan",
    "#/focus",
    "#/gtd",
  ]);
  expect(add.querySelector("kbd")?.textContent).toBe("Q");
  fireEvent.click(add);
  expect(onAddTask).toHaveBeenCalledOnce();
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

it("expands asynchronously loaded project branches by default and remembers manual collapse", () => {
  const nestedCatalog = {
    ...catalog,
    projects: [
      ...catalog.projects,
      create(ProjectSchema, { id: "work", title: "Synthetic work" }),
      create(ProjectSchema, {
        id: "research",
        parentId: "work",
        title: "Synthetic research",
        favorite: true,
      }),
      create(ProjectSchema, {
        id: "notes",
        parentId: "research",
        title: "Synthetic research notes",
      }),
    ],
  };
  const view = sidebar();
  view.rerender(
    <Sidebar
      route={{ page: "inbox", id: "" }}
      catalog={nestedCatalog}
      onAddTask={vi.fn()}
      onAddProject={vi.fn()}
      onEditCatalog={vi.fn()}
      onCatalogSaved={async () => {}}
      onError={vi.fn()}
    />,
  );
  expect(
    screen
      .getByRole("button", { name: "Collapse Synthetic work" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(
    screen.getAllByRole("link", { name: "Synthetic research" }),
  ).toHaveLength(2);
  expect(
    screen.getByRole("link", { name: "Synthetic research notes" }),
  ).toBeTruthy();
  expect(browserStorage.getItem("tasks.expanded-projects")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Collapse Synthetic research" }),
  );
  expect(
    screen.queryByRole("link", { name: "Synthetic research notes" }),
  ).toBeNull();
  view.unmount();
  const reloaded = sidebar(nestedCatalog);
  expect(
    screen
      .getByRole("button", { name: "Collapse Synthetic work" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(
    screen
      .getByRole("button", { name: "Expand Synthetic research" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(
    screen.queryByRole("link", { name: "Synthetic research notes" }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Expand Synthetic research" }),
  );
  expect(
    screen.getByRole("link", { name: "Synthetic research notes" }),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Collapse Synthetic work" }),
  );
  expect(
    screen.getAllByRole("link", { name: "Synthetic research" }),
  ).toHaveLength(1);
  reloaded.unmount();
  sidebar(nestedCatalog);
  expect(
    screen
      .getByRole("button", { name: "Expand Synthetic work" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(
    screen.queryByRole("link", { name: "Synthetic research notes" }),
  ).toBeNull();
});

it("opens archived browsing from the footer even when My projects is collapsed", () => {
  browserStorage.setItem("tasks.projects-open", "false");
  sidebar({
    ...catalog,
    projects: [
      ...catalog.projects,
      create(ProjectSchema, {
        id: "archived",
        title: "Synthetic archived project",
        archived: true,
      }),
    ],
  });
  const archived = screen.getByRole("button", { name: "Archived projects" });
  expect(archived.closest(".sidebar-bottom")).toBeTruthy();
  fireEvent.click(archived);
  expect(
    screen.getByRole("link", { name: "Synthetic archived project" }),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Archived projects" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(screen.queryByRole("link", { name: project.title })).toBeNull();
  expect(
    screen.getByRole("button", {
      name: "More actions for Synthetic archived project",
    }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show active projects" }));
  expect(
    screen.queryByRole("link", { name: "Synthetic archived project" }),
  ).toBeNull();
  expect(screen.getByRole("link", { name: project.title })).toBeTruthy();
});

it("keeps old settings bookmarks useful without retaining an empty settings page", () => {
  expect(readRoute("#/settings")).toEqual({ page: "plan", id: "" });
});
