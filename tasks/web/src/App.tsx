import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Menu } from "lucide-react";
import { FocusTimer_State } from "@ziyixi/proto/tasks/ui/v1/focus_pb";
import {
  api,
  describeError,
  EMPTY_CATALOG,
  prepareWrites,
  type Catalog,
  type CatalogItem,
  type CatalogKind,
  type Task,
  type TaskDraft,
} from "./api";
import { todayDate } from "./dates";
import {
  readRoute,
  removeQueryParameter,
  setQueryParameter,
  type Route,
} from "./routes";
import { useTaskView } from "./useTaskView";
import { useTaskActions } from "./useTaskActions";
import { Sidebar } from "./components/Sidebar";
import { SidebarResize } from "./components/SidebarResize";
import { TaskWorkspace } from "./components/TaskWorkspace";
import { CatalogView } from "./components/CatalogView";
import { ErrorBoundary, ReloadPrompt } from "./components/ErrorBoundary";
import { TaskDragProvider } from "./components/TaskDrag";
import { useReturnRefresh } from "./useReturnRefresh";
import { useOutdated } from "./outdated";
import { useLaunchQueue, type Launch } from "./launch";
import { TitleBar, useTitlebarOverlay } from "./titlebar";
// The app's own styles come before the task dialog's and Plan's, as when those two loaded on demand.
import "./styles.css";
// The dialog and Plan load with the app: a part loaded on demand shows only after React's 300ms Suspense
// reveal throttle when it first opens. Mail, GTD and the catalog editor are rarely opened and still load on demand.
import { TaskDialog } from "./components/TaskDialog";
import PlanningPage, { readIdlePause } from "./PlanningPage";
const MailPage = lazy(() => import("./MailPage"));
const GtdPage = lazy(() => import("./GtdPage"));
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
  // Each new positive value opens Plan's weekly review checklist: the review link on load, then each review
  // launch into this window.
  const [reviewRequest, setReviewRequest] = useState(() =>
    new URL(window.location.href).searchParams.get("review") === "1" ? 1 : 0,
  );
  // A launched task or Quick add waits while a task dialog is open, so a launch never discards a draft; only the
  // newest waits. A Quick add link (`?add=1`, the Dock's shortcut) waits here on load for the catalog.
  const [launchToOpen, setLaunchToOpen] = useState<
    Pick<Launch, "taskId" | "quickAdd"> | undefined
  >(() =>
    new URL(window.location.href).searchParams.get("add") === "1"
      ? { taskId: "", quickAdd: true }
      : undefined,
  );
  // Mail reads its summary link (`?mail=`) when it mounts; a mail launch remounts it.
  const [mailLaunches, setMailLaunches] = useState(0);
  // While a Focus session exists, Plan/Focus stays mounted behind the other pages, so the Focus mini timer keeps
  // its window and its controls keep working there.
  const planningPage =
    route.page === "plan" || route.page === "focus" ? route.page : undefined;
  const [focusSession, setFocusSession] = useState(false);
  const [lastPlanningPage, setLastPlanningPage] = useState<"plan" | "focus">(
    planningPage ?? "focus",
  );
  if (planningPage && planningPage !== lastPlanningPage)
    setLastPlanningPage(planningPage);
  // Pause when away watches from PlanningPage, which nothing mounts on another page after a reload or relaunch, or
  // for a session started on another device. With the setting on, one timer read on load and on each return finds
  // such a session; PlanningPage then mounts behind the page, watches, and follows the session itself.
  const planningMounted = useRef(false);
  planningMounted.current = Boolean(planningPage || focusSession);
  const findSession = useCallback(() => {
    if (planningMounted.current || !readIdlePause()) return;
    api.getFocusTimer({ name: "focusTimer" }).then(
      (timer) => {
        if (
          timer.taskId &&
          (timer.state === FocusTimer_State.RUNNING ||
            timer.state === FocusTimer_State.PAUSED)
        )
          setFocusSession(true);
      },
      // Plan and Focus read the timer themselves; the next return tries again.
      () => {},
    );
  }, []);
  useEffect(findSession, [findSession]);
  const titlebar = useTitlebarOverlay();
  // A newer build serves Tasks, so this tab's bundle may call routes it no longer has: the page and its
  // errors give way to the reload prompt.
  const outdated = useOutdated();
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
    prepareWrites();
    void loadCatalog();
  }, [loadCatalog]);
  useEffect(
    () => () => {
      taskOpenSequence.current++;
    },
    [],
  );
  useEffect(() => {
    if (actions.mutationRevision > 0) void loadCatalog();
  }, [actions.mutationRevision, loadCatalog]);
  // A window left open overnight, or while Todofy added tasks, shows today's list and counts on return.
  useReturnRefresh(() => {
    void list.refresh();
    void loadCatalog();
    findSession();
  });
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
  const openTask = useCallback(async (id: string, fromLink = false) => {
    const request = ++taskOpenSequence.current;
    try {
      // ListTasks omits full descriptions; GetTask answers the whole task, planning facts included.
      const task = await api.getTask({ name: `tasks/${id}` });
      if (request === taskOpenSequence.current) setEditor({ task });
    } catch (reason) {
      // A link to a task that does not open, such as one deleted since, would otherwise fail on every reload.
      // An opened link stays until its editor closes, so a reload meanwhile reopens the task.
      if (fromLink) removeQueryParameter("task");
      if (request === taskOpenSequence.current)
        setNotice(describeError(reason));
    }
  }, []);
  useEffect(() => {
    const id = new URL(window.location.href).searchParams.get("task");
    if (id) void openTask(id, true);
  }, [openTask]);
  // The review and Quick add parameters act once: a reload does not act on them again.
  useEffect(() => {
    removeQueryParameter("review");
    removeQueryParameter("add");
  }, []);
  // A review request belongs to the Plan it opens: a later visit to Plan does not reopen the checklist.
  useEffect(() => {
    if (route.page !== "plan") setReviewRequest(0);
  }, [route.page]);
  // The title bar's field shows Search's query only on Search.
  useEffect(() => {
    if (titlebar && route.page !== "search") setSearch("");
  }, [titlebar, route.page]);
  // A launch into this open window (launch.ts): its route, the review checklist and a mail summary apply at
  // once; a task or Quick add opens through launchToOpen.
  useLaunchQueue((launch) => {
    if (launch.review) setReviewRequest((count) => count + 1);
    if (launch.mailId) {
      setQueryParameter("mail", launch.mailId);
      setMailLaunches((count) => count + 1);
    }
    // A task or Quick add, unless the open dialog shows it already.
    const opens = launch.taskId
      ? launch.taskId !== editor?.task?.id
      : launch.quickAdd && !(editor && !editor.task);
    const open = () => {
      if (opens) setLaunchToOpen(launch);
    };
    if (launch.hash && launch.hash !== window.location.hash) {
      // A route change drops a task that is still opening, so the launch's task opens after it.
      window.addEventListener("hashchange", open, { once: true });
      window.location.hash = launch.hash;
    } else open();
  });
  useEffect(() => {
    if (!launchToOpen || editor) return;
    if (launchToOpen.taskId) {
      setLaunchToOpen(undefined);
      // As a link loaded in this window: a reload reopens the task until its dialog closes.
      setQueryParameter("task", launchToOpen.taskId);
      void openTask(launchToOpen.taskId, true);
    } else if (catalog.timeZone) {
      setLaunchToOpen(undefined);
      taskOpenSequence.current++;
      // The Dock has no page context, so Quick add captures to Inbox with no date wherever the window is.
      setEditor({});
    }
  }, [launchToOpen, editor, catalog.timeZone, openTask]);
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
              gtd: "GTD",
              catalog: "Labels & filters",
            }[route.page] || "Tasks";
  const editCatalog = (kind: CatalogKind, item?: CatalogItem) =>
    setCatalogEditor({ kind, item });
  return (
    <TaskDragProvider
      onError={actions.setNotice}
      onDrop={async (task, target) => {
        if (target.kind === "category")
          return actions.dropOnCategory(
            task.id,
            target.target,
            catalog.timeZone,
          );
        if (target.kind === "detach") return actions.detach(task);
        return actions.dropInList(task, target);
      }}
    >
      <div className={`app-shell ${showSidebar ? "sidebar-open" : ""}`}>
        {titlebar && (
          <TitleBar
            search={search}
            searching={route.page === "search"}
            onSearch={(text) => {
              setSearch(text);
              if (route.page !== "search") window.location.hash = "/search";
            }}
            searchRef={searchRef}
          />
        )}
        <Sidebar
          route={route}
          catalog={catalog}
          onAddTask={addTask}
          onAddProject={() => editCatalog("project")}
          onEditCatalog={editCatalog}
          onCatalogSaved={refreshCatalog}
          onError={actions.setNotice}
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
            planningPage ? "main-content planning-content" : "main-content"
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
          {catalogError && !outdated && (
            <div className="error-message" role="alert">
              {catalogError}
              <button
                onClick={() => void loadCatalog()}
                className="text-button"
              >
                Retry
              </button>
            </div>
          )}
          {notice && !outdated && (
            <div className="notice" role="status">
              {notice}
              <button className="text-button" onClick={() => setNotice("")}>
                Dismiss
              </button>
            </div>
          )}
          {outdated ? (
            <ReloadPrompt updated />
          ) : route.page === "mail" ? (
            <ErrorBoundary key="mail">
              <Suspense
                fallback={
                  <p className="loading-state" role="status">
                    Loading Mail…
                  </p>
                }
              >
                <MailPage
                  key={mailLaunches}
                  catalog={catalog}
                  onTaskCreated={actions.taskChanged}
                />
              </Suspense>
            </ErrorBoundary>
          ) : route.page === "gtd" ? (
            <ErrorBoundary key="gtd">
              <Suspense
                fallback={
                  <p className="loading-state" role="status">
                    Loading GTD…
                  </p>
                }
              >
                <GtdPage onOpenTask={(id) => void openTask(id)} />
              </Suspense>
            </ErrorBoundary>
          ) : planningPage ? null : route.page === "catalog" ? (
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
              titlebarSearch={titlebar}
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
          {!outdated && (planningPage || focusSession) && (
            // Plan and Focus share one PlanningPage, so the route resets a failure instead of a remount. Behind
            // another page a failure shows nothing there; opening Plan or Focus resets it.
            <ErrorBoundary
              key="planning"
              resetKey={planningPage ?? "background"}
              quiet={!planningPage}
            >
              <PlanningPage
                onCompleteTask={actions.finishTask}
                page={planningPage ?? lastPlanningPage}
                background={!planningPage}
                onSession={setFocusSession}
                review={reviewRequest}
                refreshRevision={actions.planRevision}
                onOpenTask={(id) => void openTask(id)}
                onSettings={() => {
                  window.location.hash = "/plan";
                }}
              />
            </ErrorBoundary>
          )}
        </main>
        {editor && catalog.timeZone && (
          <ErrorBoundary>
            <TaskDialog
              onChildAdded={() => {
                actions.taskChanged();
                void list.refresh();
              }}
              key={editor.task?.id || "new"}
              task={editor.task}
              defaults={editor.defaults}
              catalog={catalog}
              onClose={() => {
                taskOpenSequence.current++;
                setEditor(undefined);
                removeQueryParameter("task");
              }}
              onSave={saveTask}
              onDelete={deleteTask}
              onComplete={complete}
              onOpen={(id) => void openTask(id)}
            />
          </ErrorBoundary>
        )}
        {catalogEditor && (
          <ErrorBoundary>
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
          </ErrorBoundary>
        )}
      </div>
    </TaskDragProvider>
  );
}
