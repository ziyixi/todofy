import {
  Archive,
  CalendarDays,
  CalendarRange,
  CheckCheck,
  ChevronDown,
  Hash,
  Inbox,
  LayoutGrid,
  ListFilter,
  Mail,
  Plus,
  Search,
  Settings,
  Tag,
  Target,
  Timer,
} from "lucide-react";
import type { Catalog } from "../api";
import { routeHref, type Route } from "../routes";

const navigation = [
  { page: "search", title: "Search", icon: Search },
  { page: "inbox", title: "Inbox", icon: Inbox },
  { page: "today", title: "Today", icon: CalendarDays },
  { page: "upcoming", title: "Upcoming", icon: CalendarRange },
  { page: "plan", title: "Plan", icon: Target },
  { page: "focus", title: "Focus", icon: Timer },
  { page: "mail", title: "Mail", icon: Mail },
] as const;

export function Sidebar({
  route,
  catalog,
  managedRoles,
  hiddenFilters,
  onAddTask,
  onAddProject,
}: {
  route: Route;
  catalog: Catalog;
  managedRoles: ReadonlyMap<string, string>;
  hiddenFilters: ReadonlySet<string>;
  onAddTask: () => void;
  onAddProject: () => void;
}) {
  const active = (page: Route["page"], id = "") =>
    route.page === page && route.id === id;
  const projects = catalog.projects.filter(
    (project) => !project.archived && !project.inbox,
  );
  function projectRows(parentId = "", depth = 0): React.ReactNode {
    return projects
      .filter((project) => project.parentId === parentId)
      .map((project) => (
        <div key={project.id}>
          <a
            className={`nav-item ${active("project", project.id) ? "selected" : ""}`}
            style={{ paddingInlineStart: `${12 + depth * 14}px` }}
            href={routeHref({ page: "project", id: project.id })}
          >
            <Hash size={18} style={{ color: project.color || undefined }} />
            <span>{project.title}</span>
          </a>
          {depth < 8 && projectRows(project.id, depth + 1)}
        </div>
      ));
  }
  const favorites = [
    ...catalog.projects
      .filter(
        (project) => project.favorite && !project.archived && !project.inbox,
      )
      .map((project) => ({
        page: "project" as const,
        id: project.id,
        title: project.title,
        icon: Hash,
      })),
    ...catalog.filters
      .filter((filter) => filter.favorite && !hiddenFilters.has(filter.id))
      .map((filter) => ({
        page: "filter" as const,
        id: filter.id,
        title: filter.title,
        icon: ListFilter,
      })),
    ...catalog.labels
      .filter((label) => label.favorite && !managedRoles.has(label.id))
      .map((label) => ({
        page: "label" as const,
        id: label.id,
        title: label.title,
        icon: Tag,
      })),
  ];
  return (
    <aside className="sidebar">
      <a className="brand" href="#/today">
        <span className="brand-mark">
          <CheckCheck size={19} />
        </span>
        <strong>Todofy Tasks</strong>
      </a>
      <button className="add-task-nav" onClick={onAddTask}>
        <Plus size={20} />
        <span>Add task</span>
        <kbd>Q</kbd>
      </button>
      <nav aria-label="Main navigation">
        {navigation.map(({ page, title, icon: Icon }) => (
          <a
            key={page}
            href={routeHref({ page, id: "" })}
            className={`nav-item ${active(page) ? "selected" : ""}`}
            aria-current={active(page) ? "page" : undefined}
          >
            <Icon size={19} />
            <span>{title}</span>
          </a>
        ))}
      </nav>
      {favorites.length > 0 && (
        <section className="sidebar-section">
          <h2>Favorites</h2>
          {favorites.map(({ page, id, title, icon: Icon }) => (
            <a
              className={`nav-item ${active(page, id) ? "selected" : ""}`}
              href={routeHref({ page, id })}
              key={`${page}-${id}`}
            >
              <Icon size={17} />
              <span>{title}</span>
            </a>
          ))}
        </section>
      )}
      <section className="sidebar-section">
        <header>
          <h2>
            <ChevronDown size={14} />
            My projects
          </h2>
          <button
            className="icon-button"
            aria-label="Add project"
            onClick={onAddProject}
          >
            <Plus size={17} />
          </button>
        </header>
        {projectRows()}
      </section>
      <div className="sidebar-bottom">
        <a
          className={`nav-item ${route.page === "settings" ? "selected" : ""}`}
          href="#/settings"
        >
          <Settings size={18} />
          <span>Planning settings</span>
        </a>
        <a
          className={`nav-item ${route.page === "catalog" ? "selected" : ""}`}
          href="#/catalog"
        >
          <LayoutGrid size={18} />
          <span>Projects, labels & filters</span>
        </a>
        <a
          className={`nav-item ${route.page === "completed" ? "selected" : ""}`}
          href="#/completed"
        >
          <Archive size={18} />
          <span>Completed tasks</span>
        </a>
      </div>
    </aside>
  );
}
