import { useCallback, useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  Check,
  Pause,
  Play,
  RefreshCw,
  Settings,
  Square,
} from "lucide-react";
import { displayedTitle } from "./domain";
import { words } from "./i18n";
import { applyConfirmed, rereadsAfter } from "./plan-updates";
import { Elapsed } from "./StatusMarks";
import { PlanView } from "./PlanView";
import { FocusView } from "./FocusView";
import { TaskEditor } from "./TaskEditor";
import { BoardLabels } from "./BoardLabels";
import { WeeklyGoals } from "./WeeklyGoals";
import type {
  Confirmed,
  Language,
  PlanState,
  PlanningTask,
  PlusActions,
  PlusData,
  View,
} from "./model";

/** Returning to the tab re-reads only when the last read is at least this old. */
const VISIBLE_REREAD_MS = 60_000;

interface Props {
  actions: PlusActions;
  view: View;
  language: Language;
  onOpenTask: (id: string) => void;
  onSettings: () => void;
  onReady?: (plan?: PlanState) => void;
  externalTaskId?: string;
  onViewChange?: (view: View) => void;
}
export function App({
  actions,
  view,
  language,
  onOpenTask,
  onSettings,
  onReady,
  externalTaskId,
  onViewChange,
}: Props) {
  const [data, setData] = useState<PlusData>();
  const displayedWeek = useRef("");
  const weekRequest = useRef(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [weekLoading, setWeekLoading] = useState(false);
  const [reading, setReading] = useState(0);
  const lock = useRef(false);
  // Changes when a write starts or ends; a read that overlapped a write may predate it.
  const writes = useRef(0);
  const rereadAfterWrite = useRef(false);
  const loadedAt = useRef(0);
  const [selectedId, setSelectedId] = useState(externalTaskId ?? "");
  const completionIds = useRef(new Map<string, string>());
  // Confirmed completions stay visible but disabled until a re-read shows the result.
  const [completing, setCompleting] = useState<ReadonlySet<string>>(new Set());
  const dialog = useRef<HTMLDialogElement>(null);
  const text = words(language);
  const load = useCallback(async (): Promise<boolean> => {
    const request = ++weekRequest.current;
    const version = writes.current;
    try {
      const week = displayedWeek.current;
      const next = await actions.load(week || undefined);
      if (version !== writes.current || lock.current) return false;
      if (!displayedWeek.current) displayedWeek.current = next.plan.week;
      loadedAt.current = Date.now();
      setData((current) =>
        current && request !== weekRequest.current
          ? { ...next, days: current.days }
          : next,
      );
      setCompleting(new Set());
      onReady?.(next.plan);
      return true;
    } catch (failure) {
      onReady?.();
      throw failure;
    } finally {
      if (request === weekRequest.current) setWeekLoading(false);
    }
  }, [actions, onReady]);
  // Reads never take the write lock or disable controls.
  const revalidate = useCallback(
    async (report = true) => {
      setReading((count) => count + 1);
      try {
        while (!(await load())) {
          // The read overlapped a write. A running write reads again when it ends.
          if (lock.current) {
            rereadAfterWrite.current = true;
            return;
          }
        }
      } catch (failure) {
        if (report)
          setError(failure instanceof Error ? failure.message : text.lastError);
      } finally {
        setReading((count) => count - 1);
      }
    },
    [load, text.lastError],
  );
  const run = useCallback(
    async (operation: () => Promise<Confirmed>): Promise<boolean> => {
      if (lock.current) return false;
      lock.current = true;
      writes.current++;
      setBusy(true);
      setError("");
      let reread = false;
      let failed = false;
      try {
        const confirmed = await operation();
        setData((current) => current && applyConfirmed(current, confirmed));
        reread = rereadsAfter(confirmed);
        return true;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : text.lastError);
        // Another window may have changed the timer or task. Show its current state.
        reread = failed = true;
        return false;
      } finally {
        lock.current = false;
        writes.current++;
        setBusy(false);
        if (reread || rereadAfterWrite.current) {
          rereadAfterWrite.current = false;
          // A failed re-read keeps the last confirmed view and the original operation error.
          void revalidate(!failed);
        }
      }
    },
    [revalidate, text.lastError],
  );
  useEffect(() => {
    void revalidate();
  }, [revalidate]);
  useEffect(() => {
    const visible = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - loadedAt.current >= VISIBLE_REREAD_MS
      ) {
        setError("");
        void revalidate();
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [revalidate]);
  useEffect(() => {
    if (externalTaskId) setSelectedId(externalTaskId);
  }, [externalTaskId]);
  useEffect(() => {
    if (selectedId && dialog.current && !dialog.current.open)
      dialog.current.showModal();
  }, [selectedId]);

  async function addFocus(id: string, day = data?.focus) {
    if (!data || !day || day.taskIds.includes(id)) return;
    await run(() => actions.updateQueue([...day.taskIds, id], day));
  }
  function changeWeek(week: string) {
    const request = ++weekRequest.current;
    displayedWeek.current = week;
    setWeekLoading(true);
    return actions
      .loadDays(week)
      .then((days) => {
        if (weekRequest.current === request)
          setData((current) => (current ? { ...current, days } : current));
      })
      .catch((failure) => {
        if (weekRequest.current === request)
          setError(failure instanceof Error ? failure.message : text.lastError);
      })
      .finally(() => {
        if (weekRequest.current === request) setWeekLoading(false);
      });
  }
  function commandTimer(
    action: "start" | "pause" | "resume" | "stop",
    taskId: string,
  ) {
    if (!data) return;
    void run(() => actions.timer(action, taskId, data.focus));
  }
  function complete(task: PlanningTask) {
    let id = completionIds.current.get(task.id);
    if (!id) {
      id = crypto.randomUUID();
      completionIds.current.set(task.id, id);
    }
    const requestId = id;
    void run(async () => {
      await actions.completeTask(
        task,
        requestId,
        data?.focus.timer?.taskId === task.id
          ? data.focus.timer.flowDate
          : (data?.focus.date ?? ""),
      );
      // Todoist may advance a recurring task, so only the following re-read shows the result.
      completionIds.current.delete(task.id);
      setCompleting((current) => new Set(current).add(task.id));
    });
  }
  const selected = data?.plan.tasks.find((task) => task.id === selectedId);
  const timerTask = data?.plan.tasks.find(
    (task) => task.id === data.focus.timer?.taskId,
  );
  const timerSettling = Boolean(timerTask && completing.has(timerTask.id));
  function refresh() {
    if (error === "Extension updated. Reload Todoist to continue.")
      window.location.reload();
    else {
      setError("");
      void revalidate();
    }
  }
  return (
    <div className={`plus-root plus-root-${view}`}>
      <header className="plus-page-header">
        <div>
          <h1>{view === "plan" ? text.plan : text.focus}</h1>
          <div className="plus-subtitle">
            <CalendarDays size={13} />
            {data
              ? view === "plan"
                ? (data.days[0]?.date ?? data.plan.week)
                : data.focus.date
              : ""}
            {data && <span> · {data.plan.timezone}</span>}
          </div>
        </div>
        <div className="plus-header-actions">
          <button
            className="plus-icon"
            aria-label={text.refresh}
            disabled={busy}
            onClick={refresh}
          >
            <RefreshCw
              size={17}
              className={busy || weekLoading || reading ? "plus-spin" : ""}
            />
          </button>
          <button
            className="plus-icon"
            aria-label={text.boardLabels}
            onClick={() => setSelectedId("board-labels")}
          >
            <Settings size={17} />
          </button>
        </div>
      </header>
      {error && (
        <div className="plus-error" role="alert">
          <span>{error}</span>
          <button onClick={refresh}>{text.refresh}</button>
          <button onClick={onSettings}>{text.manage}</button>
        </div>
      )}
      {!data && !error && (
        <p className="plus-muted" role="status">
          {text.loading}
        </p>
      )}
      {data && !data.plan.configured && (
        <p className="plus-error">
          {text.setup}
          <button onClick={onSettings}>{text.manage}</button>
        </p>
      )}
      {data && (
        <fieldset
          className="plus-content-fieldset"
          disabled={!data.plan.configured}
        >
          {view === "plan" ? (
            <>
              <WeeklyGoals
                plan={data.plan}
                language={language}
                busy={busy || !data.plan.configured}
                run={run}
                actions={actions}
                editTask={(task) => setSelectedId(task.id)}
                onOpenTask={onOpenTask}
              />
              <PlanView
                plan={data.plan}
                days={data.days}
                flowTasks={data.focus.flowTasks}
                timer={data.focus.timer}
                currentDate={data.focus.date}
                onWeekChange={changeWeek}
                language={language}
                busy={busy || weekLoading || !data.plan.configured}
                run={run}
                actions={actions}
                editTask={(task) => setSelectedId(task.id)}
                onLabels={() => setSelectedId("board-labels")}
              />
            </>
          ) : (
            <FocusView
              plan={data.plan}
              focus={data.focus}
              language={language}
              busy={busy || !data.plan.configured}
              completing={completing}
              editTask={(task) => setSelectedId(task.id)}
              complete={complete}
              onOpenPlan={() => onViewChange?.("plan")}
              onTimer={commandTimer}
            />
          )}
        </fieldset>
      )}
      {data?.focus.timer && (
        <aside className="plus-timer-bar" aria-label={text.focus}>
          <div>
            <small>
              {data.focus.timer.status === "running" ? text.focus : text.pause}
            </small>
            <strong>
              {timerTask
                ? displayedTitle(timerTask.title)
                : (data.focus.flowTasks[data.focus.timer.taskId]?.title ??
                  text.focus)}
            </strong>
          </div>
          <output>
            <Elapsed focus={data.focus} />
          </output>
          <button
            className="plus-icon"
            disabled={busy || timerSettling}
            aria-label={
              data.focus.timer.status === "running" ? text.pause : text.resume
            }
            onClick={() =>
              commandTimer(
                data.focus.timer?.status === "running" ? "pause" : "resume",
                data.focus.timer!.taskId,
              )
            }
          >
            {data.focus.timer.status === "running" ? (
              <Pause size={17} />
            ) : (
              <Play size={17} />
            )}
          </button>
          <button
            className="plus-icon"
            disabled={busy || timerSettling}
            aria-label={text.stop}
            onClick={() => commandTimer("stop", data.focus.timer!.taskId)}
          >
            <Square size={15} />
          </button>
          {timerTask && (
            <button
              className="plus-icon"
              disabled={busy || timerSettling}
              aria-label={text.complete}
              onClick={() => complete(timerTask)}
            >
              <Check size={18} />
            </button>
          )}
        </aside>
      )}
      <dialog
        className="plus-dialog"
        ref={dialog}
        onClose={() => setSelectedId("")}
        onCancel={() => setSelectedId("")}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            dialog.current?.close();
            setSelectedId("");
          }
        }}
      >
        {selectedId === "board-labels" && data && (
          <BoardLabels
            plan={data.plan}
            language={language}
            busy={busy}
            onSave={(labels) =>
              run(() => actions.updateLabels(labels, data.plan.etag))
            }
            onClose={() => dialog.current?.close()}
            onConnection={onSettings}
          />
        )}
        {selected && data && (
          <TaskEditor
            key={selected.id}
            task={selected}
            tasks={data.plan.tasks}
            language={language}
            busy={busy}
            run={run}
            actions={actions}
            todayTaskIds={data.focus.taskIds}
            addFocus={(id) => void addFocus(id, data.focus)}
            onOpenTask={onOpenTask}
            onClose={() => {
              dialog.current?.close();
              setSelectedId("");
            }}
          />
        )}
      </dialog>
    </div>
  );
}
