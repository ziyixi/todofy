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
import { isPlanning, readRoute, type Route } from "./routes";
import { useTaskView } from "./useTaskView";
import { useTaskActions } from "./useTaskActions";
import { Sidebar } from "./components/Sidebar";
import { TaskWorkspace } from "./components/TaskWorkspace";
import { TaskDialog } from "./components/TaskDialog";
import { CatalogView } from "./components/CatalogView";
import { PlanningSettings } from "./components/PlanningSettings";
import { usePlanningSettings } from "./usePlanningSettings";
import { planningPresentation } from "./planning-presentation";
import { CatalogEditor } from "./components/CatalogEditor";
const PlanningPage = lazy(() => import("./PlanningPage"));

export function App() {
  const planning = usePlanningSettings();
  const presentation = planningPresentation(planning.plan);
  const [route, setRoute] = useState<Route>(readRoute);
  const [catalog, setCatalog] = useState<Catalog>(EMPTY_CATALOG);
  const [catalogError, setCatalogError] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [date, setDate] = useState(todayDate);
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
  const searchRef = useRef<HTMLInputElement>(null);
  const currentRoute = useRef(route);
  currentRoute.current = route;
  const list = useTaskView(
    route,
    route.page === "search" ? search : "",
    route.page === "upcoming" ? date : "",
    orderBy,
    includeCompleted,
  );
  const actions = useTaskActions(route, orderBy, list);
  const { saveTask, deleteTask, complete, setSelected, notice, setNotice } =
    actions;
  const loadCatalog = useCallback(async () => {
    setCatalogError("");
    try {
      setCatalog(await api.getCatalog({ name: "catalog" }));
    } catch (reason) {
      setCatalogError(describeError(reason));
    } finally {
      setCatalogLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);
  useEffect(() => {
    const change = () => {
      setRoute(readRoute());
      setSelected(new Set());
      setShowSidebar(false);
      setNotice("");
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  const addTask = useCallback(() => {
    const current = currentRoute.current;
    setEditor({
      defaults: {
        projectId: current.page === "project" ? current.id : "",
        dueDate: current.page === "today" ? todayDate() : "",
      },
    });
  }, []);
  const openTask = useCallback(async (id: string) => {
    try {
      setEditor({ task: await api.getTask({ name: `tasks/${id}` }) });
    } catch (reason) {
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
              catalog: "Projects, labels & filters",
              settings: "Planning settings",
            }[route.page] || "Tasks";
  const editCatalog = (kind: CatalogKind, item?: CatalogItem) =>
    setCatalogEditor({ kind, item });
  return (
    <div className={`app-shell ${showSidebar ? "sidebar-open" : ""}`}>
      <Sidebar
        route={route}
        catalog={catalog}
        managedRoles={presentation.roles}
        hiddenFilters={presentation.hiddenFilters}
        onAddTask={addTask}
        onAddProject={() => editCatalog("project")}
      />
      {showSidebar && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setShowSidebar(false)}
        />
      )}
      <main
        className={
          isPlanning(route.page)
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
        {isPlanning(route.page) ? (
          <Suspense
            fallback={
              <p className="loading-state" role="status">
                Loading {title}…
              </p>
            }
          >
            <PlanningPage
              page={route.page}
              mutationRevision={actions.mutationRevision}
              onReady={planning.accept}
              onOpenTask={(id) => void openTask(id)}
              onSettings={() => {
                window.location.hash = "/settings";
              }}
            />
          </Suspense>
        ) : route.page === "settings" ? (
          <PlanningSettings state={planning} />
        ) : route.page === "catalog" ? (
          <CatalogView catalog={catalog} onEdit={editCatalog} />
        ) : (
          <TaskWorkspace
            title={title}
            route={route}
            catalog={catalog}
            managedRoles={presentation.roles}
            catalogLoading={catalogLoading}
            list={list}
            actions={actions}
            search={search}
            setSearch={setSearch}
            searchRef={searchRef}
            date={date}
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
      {editor && (
        <TaskDialog
          onChildAdded={actions.taskChanged}
          key={editor.task?.id || "new"}
          task={editor.task}
          defaults={editor.defaults}
          catalog={catalog}
          onClose={() => setEditor(undefined)}
          onSave={saveTask}
          onDelete={deleteTask}
          onComplete={complete}
          onOpen={(id) => void openTask(id)}
        />
      )}
      {catalogEditor && (
        <CatalogEditor
          kind={catalogEditor.kind}
          item={catalogEditor.item}
          catalog={catalog}
          projectId={route.page === "project" ? route.id : ""}
          onClose={() => setCatalogEditor(undefined)}
          onSaved={async () => {
            await Promise.all([loadCatalog(), planning.load()]);
          }}
        />
      )}
    </div>
  );
}
