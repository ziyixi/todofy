import {
  Archive,
  CalendarDays,
  CalendarRange,
  ChartLine,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Folder,
  Hash,
  Inbox,
  LayoutGrid,
  ListFilter,
  Mail,
  Plus,
  Search,
  Tag,
  Target,
  Timer,
} from "lucide-react";
import { useState } from "react";
import type { Catalog, CatalogItem, CatalogKind } from "../api";
import { CatalogMenu } from "./CatalogMenu";
import { routeHref, type Route } from "../routes";
import { TaskCategoryLink } from "./TaskDrag";
import "./sidebar.css";

const navigationGroups = [
  {
    title: "Tasks",
    items: [
      { page: "inbox", title: "Inbox", icon: Inbox },
      { page: "today", title: "Today", icon: CalendarDays },
      { page: "upcoming", title: "Upcoming", icon: CalendarRange },
      { page: "mail", title: "Mail", icon: Mail },
    ],
  },
  {
    title: "Planning",
    items: [
      { page: "goals", title: "Goals", icon: Target },
      { page: "plan", title: "Plan", icon: Target },
      { page: "focus", title: "Focus", icon: Timer },
      { page: "gtd", title: "GTD", icon: ChartLine },
    ],
  },
] as const;

export function Sidebar({
  route,
  catalog,
  onAddTask,
  onAddProject,
  onEditCatalog,
  onCatalogSaved,
  onError,
}: {
  route: Route;
  catalog: Catalog;
  onAddTask: () => void;
  onAddProject: () => void;
  onEditCatalog: (kind: CatalogKind, item?: CatalogItem) => void;
  onCatalogSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [projectsOpen, setProjectsOpen] = useState(() => {
    try {
      return localStorage.getItem("tasks.projects-open") !== "false";
    } catch {
      return true;
    }
  });
  const [expandedProjects, setExpandedProjects] = useState<Set<string> | null>(() => {
    try {
      const stored = localStorage.getItem("tasks.expanded-projects");
      if (stored === null) return null;
      const saved: unknown = JSON.parse(stored);
      return new Set(
        Array.isArray(saved)
          ? saved.filter((id): id is string => typeof id === "string")
          : [],
      );
    } catch {
      return null;
    }
  });
  function toggleProjects() {
    const next = !projectsOpen;
    setProjectsOpen(next);
    try {
      localStorage.setItem("tasks.projects-open", String(next));
    } catch {
      // The current window still collapses when browser storage is disabled.
    }
  }
  function toggleProject(id: string) {
    const next = new Set(
      expandedProjects ?? catalog.projects.map((project) => project.id),
    );
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedProjects(next);
    try {
      localStorage.setItem("tasks.expanded-projects", JSON.stringify([...next]));
    } catch {
      // Project branches still work when browser storage is disabled.
    }
  }
  function categoryCount(view: string, id = "") {
    const count = catalog.taskCounts?.find(
      (item) => item.view === view && item.id === id,
    )?.count;
    return count === undefined || count === 0 ? null : (
      <span
        className="category-count"
        aria-hidden="true"
        title={`${count} open tasks`}
      >
        {count}
      </span>
    );
  }
  const [showArchived, setShowArchived] = useState(false);
  const active = (page: Route["page"], id = "") =>
    route.page === page && (page === "goals" || route.id === id);
  const projects = catalog.projects.filter(
    (project) => project.archived === showArchived && !project.inbox,
  );
  const projectChildren = new Map<string, Catalog["projects"]>();
  for (const project of projects) {
    const siblings = projectChildren.get(project.parentId) ?? [];
    siblings.push(project);
    projectChildren.set(project.parentId, siblings);
  }
  function projectRows(parentId = "", depth = 0): React.ReactNode {
    return (showArchived ? projects : projectChildren.get(parentId) ?? []).map(
      (project) => {
        const hasChildren =
          !showArchived && depth < 8 && projectChildren.has(project.id);
        const expanded = expandedProjects?.has(project.id) ?? true;
        const Icon = depth === 0 ? Folder : Hash;
        return (
          <div key={project.id}>
            <CatalogMenu
              kind="project"
              item={project}
              onEdit={() => onEditCatalog("project", project)}
              onSaved={onCatalogSaved}
              onError={onError}
            >
              <div
                className={`sidebar-context-row${hasChildren ? " has-project-children" : ""}`}
              >
                <TaskCategoryLink
                  className={`nav-item ${active("project", project.id) ? "selected" : ""}`}
                  style={{ paddingInlineStart: `${12 + depth * 14}px` }}
                  href={routeHref({ page: "project", id: project.id })}
                  aria-current={active("project", project.id) ? "page" : undefined}
                  target={
                    project.archived
                      ? undefined
                      : { page: "project", id: project.id }
                  }
                >
                  <Icon size={20} style={{ color: project.color || undefined }} />
                  <span>{project.title}</span>
                  {categoryCount("project", project.id)}
                </TaskCategoryLink>
                <CatalogMenu
                  kind="project"
                  item={project}
                  onEdit={() => onEditCatalog("project", project)}
                  onSaved={onCatalogSaved}
                  onError={onError}
                />
                {hasChildren && (
                  <button
                    className="icon-button sidebar-project-toggle"
                    aria-label={`${expanded ? "Collapse" : "Expand"} ${project.title}`}
                    aria-expanded={expanded}
                    onClick={() => toggleProject(project.id)}
                  >
                    <ChevronRight size={16} />
                  </button>
                )}
              </div>
            </CatalogMenu>
            {hasChildren && expanded && projectRows(project.id, depth + 1)}
          </div>
        );
      },
    );
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
        item: project,
        color: project.color,
        icon: Hash,
      })),
    ...catalog.filters
      .filter((filter) => filter.favorite)
      .map((filter) => ({
        page: "filter" as const,
        id: filter.id,
        title: filter.title,
        item: filter,
        color: filter.color,
        icon: ListFilter,
      })),
    ...catalog.labels
      .filter((label) => label.favorite)
      .map((label) => ({
        page: "label" as const,
        id: label.id,
        title: label.title,
        item: label,
        color: label.color,
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
      <TaskCategoryLink
        href="#/search"
        className={`nav-item sidebar-search ${active("search") ? "selected" : ""}`}
        aria-current={active("search") ? "page" : undefined}
      >
        <Search size={21} />
        <span>Search</span>
      </TaskCategoryLink>
      <button className="add-task-nav" onClick={onAddTask}>
        <Plus size={26} />
        <span>Add task</span>
        <kbd>Q</kbd>
      </button>
      <nav aria-label="Main navigation">
        {navigationGroups.map((group) => (
          <section className="sidebar-section" key={group.title}>
            <h2>{group.title}</h2>
            {group.items.map(({ page, title, icon: Icon }) => (
              <TaskCategoryLink
                key={page}
                href={routeHref({ page, id: "" })}
                className={`nav-item ${active(page) ? "selected" : ""}`}
                aria-current={active(page) ? "page" : undefined}
                target={page === "inbox" || page === "today" ? { page } : undefined}
              >
                <Icon size={21} />
                <span>{title}</span>
                {(page === "inbox" || page === "today") && categoryCount(page)}
              </TaskCategoryLink>
            ))}
          </section>
        ))}
      </nav>
      {favorites.length > 0 && (
        <section className="sidebar-section">
          <h2>Favorites</h2>
          {favorites.map(({ page, id, title, color, item, icon: Icon }) => (
            <CatalogMenu
              key={`${page}-${id}`}
              kind={page}
              item={item}
              onEdit={() => onEditCatalog(page, item)}
              onSaved={onCatalogSaved}
              onError={onError}
            >
              <div className="sidebar-context-row">
                <TaskCategoryLink
                  className={`nav-item ${active(page, id) ? "selected" : ""}`}
                  href={routeHref({ page, id })}
                  aria-current={active(page, id) ? "page" : undefined}
                  target={
                    page === "project" || page === "label"
                      ? { page, id }
                      : undefined
                  }
                >
                  <Icon size={20} style={{ color: color || undefined }} />
                  <span>{title}</span>
                  {categoryCount(page, id)}
                </TaskCategoryLink>
                <CatalogMenu
                  kind={page}
                  item={item}
                  onEdit={() => onEditCatalog(page, item)}
                  onSaved={onCatalogSaved}
                  onError={onError}
                />
              </div>
            </CatalogMenu>
          ))}
        </section>
      )}
      <section className="sidebar-section sidebar-projects">
        <header>
          <h2>
            <button
              className="sidebar-group-toggle"
              aria-expanded={projectsOpen}
              onClick={toggleProjects}
            >
              <ChevronDown
                size={14}
                className={projectsOpen ? "" : "collapsed"}
              />
              {showArchived ? "Archived projects" : "My projects"}
            </button>
          </h2>
          <button
            className="icon-button"
            aria-label="Add project"
            onClick={onAddProject}
          >
            <Plus size={17} />
          </button>
        </header>
        {projectsOpen && projectRows()}
      </section>
      <div className="sidebar-bottom">
        <a
          className={`nav-item ${route.page === "catalog" ? "selected" : ""}`}
          href="#/catalog"
          aria-current={route.page === "catalog" ? "page" : undefined}
        >
          <LayoutGrid size={20} />
          <span>Labels & filters</span>
        </a>
        <a
          className={`nav-item ${route.page === "completed" ? "selected" : ""}`}
          href="#/completed"
          aria-current={route.page === "completed" ? "page" : undefined}
        >
          <Archive size={20} />
          <span>Completed tasks</span>
        </a>
        <button
          className={`nav-item ${showArchived ? "selected" : ""}`}
          aria-pressed={showArchived}
          onClick={() => {
            setShowArchived((current) => !current);
            if (!projectsOpen) toggleProjects();
          }}
        >
          <Archive size={20} />
          <span>{showArchived ? "Show active projects" : "Archived projects"}</span>
        </button>
      </div>
    </aside>
  );
}
