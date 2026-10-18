import {
  useState,
  type Dispatch,
  type SetStateAction,
  type RefObject,
} from "react";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import type { Catalog, CatalogItem, CatalogKind } from "../api";
import { shiftDate, todayDate } from "../dates";
import type { Route } from "../routes";
import type { useTaskView } from "../useTaskView";
import type { useTaskActions } from "../useTaskActions";
import { TaskList } from "./TaskList";
import { CompletedHistory } from "./CompletedHistory";

interface Props {
  title: string;
  route: Route;
  catalog: Catalog;
  catalogLoading: boolean;
  list: ReturnType<typeof useTaskView>;
  actions: ReturnType<typeof useTaskActions>;
  search: string;
  setSearch: Dispatch<SetStateAction<string>>;
  searchRef: RefObject<HTMLInputElement | null>;
  date: string;
  setDate: Dispatch<SetStateAction<string>>;
  includeCompleted: boolean;
  setIncludeCompleted: Dispatch<SetStateAction<boolean>>;
  orderBy: string;
  setOrderBy: Dispatch<SetStateAction<string>>;
  addTask: () => void;
  openTask: (id: string) => Promise<void>;
  editCatalog: (kind: CatalogKind, item?: CatalogItem) => void;
}
export function TaskWorkspace({
  title,
  route,
  catalog,
  catalogLoading,
  list,
  actions,
  search,
  setSearch,
  searchRef,
  date,
  setDate,
  includeCompleted,
  setIncludeCompleted,
  orderBy,
  setOrderBy,
  addTask,
  openTask,
  editCatalog,
}: Props) {
  const { batch, busyIds, selected, setSelected, complete, reorder } = actions;
  const [historyVisible, setHistoryVisible] = useState(false);
  const project = catalog.projects.find((item) => item.id === route.id);
  return (
    <div className="list-view">
      <header className="view-header">
        <div>
          <h1>{title}</h1>
          {route.page === "today" && (
            <p className="view-subtitle">
              {new Date().toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
            </p>
          )}
          {route.page === "project" && project?.archived && (
            <p className="view-subtitle">Archived project</p>
          )}
        </div>
        <div className="view-tools">
          {route.page !== "completed" && (
            <label className="completed-toggle">
              <input
                type="checkbox"
                checked={includeCompleted}
                onChange={(event) => setIncludeCompleted(event.target.checked)}
              />
              Completed
            </label>
          )}
          <select
            className="sort-select"
            aria-label="Sort tasks"
            value={orderBy}
            onChange={(event) => setOrderBy(event.target.value)}
          >
            <option value="sort_order">Custom order</option>
            <option value="title">Name</option>
            <option value="priority">Priority</option>
            <option value="due_date">Date</option>
          </select>
          {route.page === "project" && (
            <>
              <button
                className="icon-button"
                aria-label="Edit project"
                onClick={() => editCatalog("project", project)}
              >
                <Pencil size={17} />
              </button>
              <button
                className="text-button"
                onClick={() => editCatalog("section")}
              >
                <Plus size={15} />
                Section
              </button>
            </>
          )}
          <button
            className="icon-button"
            aria-label="Refresh tasks"
            disabled={list.loading}
            onClick={() => void list.read()}
          >
            <RefreshCw size={17} className={list.loading ? "spinning" : ""} />
          </button>
        </div>
      </header>
      {route.page === "search" && (
        <div className="search-box">
          <Search size={19} />
          <input
            ref={searchRef}
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tasks"
            aria-label="Search tasks"
          />
          <kbd>/</kbd>
        </div>
      )}
      {route.page === "upcoming" && (
        <div className="week-switcher">
          <span>
            <CalendarDays size={16} />
            {new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
              month: "long",
              year: "numeric",
            })}
          </span>
          <button
            className="icon-button"
            aria-label="Previous week"
            onClick={() => setDate((current) => shiftDate(current, -7))}
          >
            <ChevronLeft size={17} />
          </button>
          <button className="text-button" onClick={() => setDate(todayDate())}>
            Today
          </button>
          <button
            className="icon-button"
            aria-label="Next week"
            onClick={() => setDate((current) => shiftDate(current, 7))}
          >
            <ChevronRight size={17} />
          </button>
        </div>
      )}
      {selected.size > 0 && (
        <div className="selection-bar">
          <span>{selected.size} selected</span>
          <button
            className="text-button"
            disabled={busyIds.size > 0}
            onClick={() => void batch("complete")}
          >
            <Check size={15} />
            Complete
          </button>
          <select
            aria-label="Move selected tasks"
            value=""
            disabled={busyIds.size > 0}
            onChange={(event) => {
              if (event.target.value)
                void batch(
                  "move",
                  event.target.value === "__inbox" ? "" : event.target.value,
                );
            }}
          >
            <option value="">Move to…</option>
            <option value="__inbox">Inbox</option>
            {catalog.projects
              .filter((item) => !item.archived)
              .map((item) => (
                <option value={item.id} key={item.id}>
                  {item.title}
                </option>
              ))}
          </select>
          <button
            className="text-button"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </button>
        </div>
      )}
      {list.error && (
        <p role="alert" className="error-message">
          {list.error}
          <button className="text-button" onClick={() => void list.read()}>
            Retry
          </button>
        </p>
      )}
      {(catalogLoading || (list.loading && !list.tasks.length)) && (
        <p className="loading-state" role="status">
          <LoaderCircle size={17} className="spinning" />
          Loading tasks…
        </p>
      )}
      <TaskList
        menuActions={actions}
        tasks={list.tasks}
        catalog={catalog}
        busyIds={busyIds}
        selected={selected}
        onSelect={(id) =>
          setSelected((current) =>
            current.has(id)
              ? new Set([...current].filter((item) => item !== id))
              : new Set([...current, id]),
          )
        }
        onOpen={(id) => void openTask(id)}
        onComplete={(task) => void complete(task)}
        onReorder={(id, before) => void reorder(id, before)}
        groupBy={
          route.page === "upcoming"
            ? "date"
            : route.page === "project"
              ? "section"
              : "none"
        }
      />
      {!list.loading &&
        !list.error &&
        !catalogLoading &&
        !list.tasks.length && (
          <div className="empty-state">
            <Check size={26} />
            <h2>
              {route.page === "search"
                ? "No matching tasks"
                : route.page === "today"
                  ? "Nothing scheduled for today"
                  : "No tasks here"}
            </h2>
            <p>
              {route.page === "search"
                ? "Try a different title or description."
                : "Add a task when you have something to capture."}
            </p>
          </div>
        )}
      {route.page !== "completed" && (
        <button className="list-add" onClick={addTask}>
          <Plus size={18} />
          Add task
        </button>
      )}
      {list.nextPage && (
        <button
          className="secondary-button load-more"
          disabled={list.loading}
          onClick={() => void list.read(list.nextPage)}
        >
          {list.loading ? "Loading…" : "Load more tasks"}
        </button>
      )}
      {route.page === "project" &&
        catalog.sections
          .filter((section) => section.projectId === route.id)
          .map((section) => (
            <button
              className="section-edit"
              key={section.id}
              onClick={() => editCatalog("section", section)}
            >
              Edit section: {section.title}
            </button>
          ))}
      {route.page === "completed" && (
        <>
          <button
            className="text-button history-toggle"
            onClick={() => setHistoryVisible((current) => !current)}
          >
            {historyVisible ? "Hide" : "Show"} completion history
          </button>
          {historyVisible && (
            <CompletedHistory onOpen={(id) => void openTask(id)} />
          )}
        </>
      )}
    </div>
  );
}
