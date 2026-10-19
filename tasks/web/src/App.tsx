import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Menu } from "lucide-react";
import {
  api,
  describeError,
  EMPTY_CATALOG,
  type Catalog,
  type CatalogItem,
  type CatalogKind,
  type Task,
  type TaskDraft,
} from "./api";
import { todayDate } from "./dates";
import {
  clearDetailReadCache,
  peekDetailRead,
  readDetail,
} from "./detail-read-cache";
import { isPlanning, readRoute, type Route } from "./routes";
import { useTaskView } from "./useTaskView";
import { useTaskActions } from "./useTaskActions";
import { Sidebar } from "./components/Sidebar";
import { SidebarResize } from "./components/SidebarResize";
import { TaskWorkspace } from "./components/TaskWorkspace";
import { CatalogView } from "./components/CatalogView";
const PlanningPage = lazy(() => import("./PlanningPage"));
const MailPage = lazy(() => import("./MailPage"));
const TaskDialog = lazy(() =>
  import("./components/TaskDialog").then((module) => ({
    default: module.TaskDialog,
  })),
);
const CatalogEditor = lazy(() =>
  import("./components/CatalogEditor").then((module) => ({
    default: module.CatalogEditor,
  })),
);

export function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [catalog, setCatalog] = useState<Catalog>(EMPTY_CATALOG);
  const [catalogError, setCatalogError] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [date, setDate] = useState("");
  const accountToday = todayDate(new Date(), catalog.timeZone || undefined);
  const upcomingDate = date || accountToday;
  const [orderBy, setOrderBy] = useState("sort_order");
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [editor, setEditor] = useState<{
    task?: Task;
    defaults?: Partial<TaskDraft>;
  }>();
  const [catalogEditor, setCatalogEditor] = useState<{
    kind: CatalogKind;
    item?: CatalogItem;
  }>();
  const [showSidebar, setShowSidebar] = useState(false);
  const taskOpenSequence = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const currentRoute = useRef(route);
  currentRoute.current = route;
  const list = useTaskView(
    route,
    route.page === "search" ? search : "",
    route.page === "upcoming" ? upcomingDate : "",
    orderBy,
    includeCompleted,
  );
  const actions = useTaskActions(route, orderBy, list, accountToday);
  const { saveTask, deleteTask, complete, setSelected, notice, setNotice } =
    actions;
  const loadCatalog = useCallback(async () => {
    setCatalogError("");
    try {
      const loaded = await api.getCatalog({ name: "catalog" });
      setCatalog(loaded);
      return loaded;
    } catch (reason) {
      setCatalogError(describeError(reason));
    } finally {
      setCatalogLoading(false);
    }
  }, []);
  const refreshCatalog = useCallback(async () => {
    await loadCatalog();
  }, [loadCatalog]);
  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);
  useEffect(() => {
    window.addEventListener("focus", clearDetailReadCache);
    document.addEventListener("visibilitychange", clearDetailReadCache);
    return () => {
      window.removeEventListener("focus", clearDetailReadCache);
      document.removeEventListener("visibilitychange", clearDetailReadCache);
      taskOpenSequence.current++;
      clearDetailReadCache();
    };
  }, []);
  useEffect(() => {
    if (actions.mutationRevision > 0) void loadCatalog();
  }, [actions.mutationRevision, loadCatalog]);
  useEffect(() => {
    const change = () => {
      taskOpenSequence.current++;
      setRoute(readRoute());
      setSelected(new Set());
      setShowSidebar(false);
      setNotice("");
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  const addTask = useCallback(async () => {
    const request = ++taskOpenSequence.current;
    const current = currentRoute.current;
    const settings = catalog.timeZone ? catalog : await loadCatalog();
    if (!settings || request !== taskOpenSequence.current) return;
    setEditor({
      defaults: {
        projectId: current.page === "project" ? current.id : "",
        dueDate:
          current.page === "today"
            ? todayDate(new Date(), settings.timeZone || undefined)
            : "",
      },
    });
  }, [catalog, loadCatalog]);
  const openTask = useCallback(async (id: string) => {
    const request = ++taskOpenSequence.current;
    const key = `task:${id}` as const;
    const cached = peekDetailRead<Task>(key);
    if (cached) {
      setEditor({ task: cached });
      return;
    }
    try {
      // ListTasks omits full descriptions; only the dedicated GetTask reply may seed a detail.
      const task = await readDetail(key, () =>
        api.getTask({ name: `tasks/${id}` }),
      );
      if (request === taskOpenSequence.current) setEditor({ task });
    } catch (reason) {
      if (request === taskOpenSequence.current)
        setNotice(describeError(reason));
    }
  }, []);
  useEffect(() => {
    const id = new URL(window.location.href).searchParams.get("task");
    if (id) void openTask(id);
  }, [openTask]);
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement &&
          event.target.isContentEditable) ||
        document.querySelector("dialog[open]")
      )
        return;
      if (event.key.toLowerCase() === "q" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        addTask();
      }
      if (
        event.key === "/" ||
        (event.key === "k" && (event.metaKey || event.ctrlKey))
      ) {
        event.preventDefault();
        window.location.hash = "/search";
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }
    }
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [addTask]);
  const project = catalog.projects.find((item) => item.id === route.id);
  const title =
    route.page === "project"
      ? project?.title || "Project"
      : route.page === "label"
        ? catalog.labels.find((item) => item.id === route.id)?.title || "Label"
        : route.page === "filter"
          ? catalog.filters.find((item) => item.id === route.id)?.title ||
            "Filter"
          : {
              inbox: "Inbox",
              today: "Today",
              upcoming: "Upcoming",
              search: "Search",
              completed: "Completed tasks",
              plan: "Plan",
              focus: "Focus",
              mail: "Mail",
              catalog: "Labels & filters",
            }[route.page] || "Tasks";
  const editCatalog = (kind: CatalogKind, item?: CatalogItem) =>
    setCatalogEditor({ kind, item });
  return (
    <div className={`app-shell ${showSidebar ? "sidebar-open" : ""}`}>
      <Sidebar
        route={route}
        catalog={catalog}
        onAddTask={addTask}
        onAddProject={() => editCatalog("project")}
        onEditCatalog={editCatalog}
        onCatalogSaved={refreshCatalog}
        onError={actions.setNotice}
        onTaskDrop={(id, target) =>
          void actions.dropOnCategory(id, target, catalog.timeZone)
        }
      />
      <SidebarResize />
      {showSidebar && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setShowSidebar(false)}
        />
      )}
      <main
        className={
          route.page !== "mail" && isPlanning(route.page)
            ? "main-content planning-content"
            : "main-content"
        }
      >
        <div className="mobile-bar">
          <button
            className="icon-button"
            aria-label="Toggle navigation"
            onClick={() => setShowSidebar((current) => !current)}
          >
            <Menu size={20} />
          </button>
          <span>{title}</span>
        </div>
        {catalogError && (
          <div className="error-message" role="alert">
            {catalogError}
            <button onClick={() => void loadCatalog()} className="text-button">
              Retry
            </button>
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            {notice}
            <button className="text-button" onClick={() => setNotice("")}>
              Dismiss
            </button>
          </div>
        )}
        {route.page === "mail" ? (
          <Suspense
            fallback={
              <p className="loading-state" role="status">
                Loading Mail…
              </p>
            }
          >
            <MailPage catalog={catalog} onTaskCreated={actions.taskChanged} />
          </Suspense>
        ) : isPlanning(route.page) ? (
          <Suspense
            fallback={
              <p className="loading-state" role="status">
                Loading {title}…
              </p>
            }
          >
            <PlanningPage
              onCompleteTask={actions.finishTask}
              page={route.page}
              mutationRevision={actions.mutationRevision}
              onOpenTask={(id) => void openTask(id)}
              onSettings={() => {
                window.location.hash = "/plan";
              }}
            />
          </Suspense>
        ) : route.page === "catalog" ? (
          <CatalogView
            catalog={catalog}
            onEdit={editCatalog}
            onSaved={refreshCatalog}
            onError={actions.setNotice}
          />
        ) : (
          <TaskWorkspace
            title={title}
            route={route}
            catalog={catalog}
            catalogLoading={catalogLoading}
            list={list}
            actions={actions}
            search={search}
            setSearch={setSearch}
            searchRef={searchRef}
            date={upcomingDate}
            setDate={setDate}
            includeCompleted={includeCompleted}
            setIncludeCompleted={setIncludeCompleted}
            orderBy={orderBy}
            setOrderBy={setOrderBy}
            addTask={addTask}
            openTask={openTask}
            editCatalog={editCatalog}
          />
        )}
      </main>
      {editor && catalog.timeZone && (
        <Suspense
          fallback={
            <p className="loading-state" role="status">
              Opening task…
            </p>
          }
        >
          <TaskDialog
            onChildAdded={() => {
              actions.taskChanged();
              void list.read();
            }}
            key={editor.task?.id || "new"}
            task={editor.task}
            defaults={editor.defaults}
            catalog={catalog}
            onClose={() => {
              taskOpenSequence.current++;
              setEditor(undefined);
            }}
            onSave={saveTask}
            onDelete={deleteTask}
            onComplete={complete}
            onOpen={(id) => void openTask(id)}
          />
        </Suspense>
      )}
      {catalogEditor && (
        <Suspense
          fallback={
            <p className="loading-state" role="status">
              Opening editor…
            </p>
          }
        >
          <CatalogEditor
            kind={catalogEditor.kind}
            item={catalogEditor.item}
            catalog={catalog}
            projectId={route.page === "project" ? route.id : ""}
            onClose={() => setCatalogEditor(undefined)}
            onSaved={refreshCatalog}
          />
        </Suspense>
      )}
    </div>
  );
}
