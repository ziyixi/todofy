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
import { displayedTitle, duration, elapsed } from "./domain";
import { words } from "./i18n";
import { PlanView } from "./PlanView";
import { FocusView } from "./FocusView";
import { TaskEditor } from "./TaskEditor";
import type {
  Language,
  PlanState,
  PlanningTask,
  PlusActions,
  PlusData,
  View,
} from "./model";

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
  const [selectedDate, setSelectedDate] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [selectedId, setSelectedId] = useState(externalTaskId ?? "");
  const completionIds = useRef(new Map<string, string>());
  const [, tick] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const text = words(language);
  const load = useCallback(async () => {
    try {
      const next = await actions.load();
      setData(next);
      onReady?.(next.plan);
    } catch (failure) {
      onReady?.();
      throw failure;
    }
  }, [actions, onReady]);
  const run = useCallback(
    async (operation: () => Promise<void>): Promise<boolean> => {
      if (lock.current) return false;
      lock.current = true;
      setBusy(true);
      setError("");
      try {
        await operation();
        await load();
        return true;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : text.lastError);
        // Another window may have changed the timer or task. Show its current state.
        try {
          await load();
        } catch {
          // Keep the last confirmed view and the original operation error.
        }
        return false;
      } finally {
        lock.current = false;
        setBusy(false);
      }
    },
    [load, text.lastError],
  );
  useEffect(() => {
    void run(async () => {});
  }, [run]);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === "visible" && !lock.current)
        void run(async () => {});
    };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [run]);
  useEffect(() => {
    if (data?.focus.timer?.status !== "running") return;
    const id = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(id);
  }, [data?.focus.timer?.status]);
  useEffect(() => {
    if (externalTaskId) setSelectedId(externalTaskId);
  }, [externalTaskId]);
  useEffect(() => {
    if (selectedId && dialog.current && !dialog.current.open)
      dialog.current.showModal();
  }, [selectedId]);

  const selectedDay =
    data?.days.find((day) => day.date === selectedDate) ?? data?.focus;
  const currentFocus =
    data && selectedDay ? { ...data.focus, ...selectedDay } : undefined;
  async function addFocus(id: string, day = selectedDay) {
    if (!data || !day || day.taskIds.includes(id)) return;
    await run(() => actions.updateQueue([...day.taskIds, id], day));
  }
  function complete(task: PlanningTask) {
    let id = completionIds.current.get(task.id);
    if (!id) {
      id = crypto.randomUUID();
      completionIds.current.set(task.id, id);
    }
    const requestId = id;
    void run(() =>
      actions.completeTask(
        task,
        requestId,
        data?.focus.timer?.taskId === task.id
          ? data.focus.timer.flowDate
          : (currentFocus?.date ?? ""),
      ),
    ).then((ok) => {
      if (ok) completionIds.current.delete(task.id);
    });
  }
  const selected = data?.plan.tasks.find((task) => task.id === selectedId);
  const timerTask = data?.plan.tasks.find(
    (task) => task.id === data.focus.timer?.taskId,
  );
  return (
    <div className={`plus-root plus-root-${view}`}>
      <header className="plus-page-header">
        <div>
          <h1>{view === "plan" ? text.plan : text.focus}</h1>
          <div className="plus-subtitle">
            <CalendarDays size={13} />
            {data
              ? view === "plan"
                ? data.plan.week
                : currentFocus?.date
              : ""}
            {data && <span> · {data.plan.timezone}</span>}
          </div>
        </div>
        <div className="plus-header-actions">
          <button
            className="plus-icon"
            aria-label={text.refresh}
            disabled={busy}
            onClick={() => void run(async () => {})}
          >
            <RefreshCw size={17} className={busy ? "plus-spin" : ""} />
          </button>
          <button
            className="plus-icon"
            aria-label={text.manage}
            onClick={onSettings}
          >
            <Settings size={17} />
          </button>
        </div>
      </header>
      {error && (
        <div className="plus-error" role="alert">
          <span>{error}</span>
          <button onClick={() => void run(async () => {})}>
            {text.refresh}
          </button>
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
          disabled={busy || !data.plan.configured}
        >
          {view === "plan" ? (
            <PlanView
              plan={data.plan}
              days={data.days}
              flowTasks={data.focus.flowTasks}
              timer={data.focus.timer}
              currentDate={data.focus.date}
              onOpenFocus={(date) => {
                setSelectedDate(date);
                onViewChange?.("focus");
              }}
              language={language}
              busy={busy || !data.plan.configured}
              run={run}
              actions={actions}
              editTask={(task) => setSelectedId(task.id)}
            />
          ) : (
            <FocusView
              plan={data.plan}
              focus={currentFocus!}
              days={data.days}
              today={data.focus.date}
              onDateChange={setSelectedDate}
              language={language}
              busy={busy || !data.plan.configured}
              run={run}
              actions={actions}
              editTask={(task) => setSelectedId(task.id)}
              addFocus={(id) => void addFocus(id)}
              complete={complete}
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
          <output>{duration(elapsed(data.focus))}</output>
          <button
            className="plus-icon"
            disabled={busy}
            aria-label={
              data.focus.timer.status === "running" ? text.pause : text.resume
            }
            onClick={() =>
              void run(() =>
                actions.timer(
                  data.focus.timer?.status === "running" ? "pause" : "resume",
                  data.focus.timer!.taskId,
                  data.focus,
                ),
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
            disabled={busy}
            aria-label={text.stop}
            onClick={() =>
              void run(() =>
                actions.timer("stop", data.focus.timer!.taskId, data.focus),
              )
            }
          >
            <Square size={15} />
          </button>
          {timerTask && (
            <button
              className="plus-icon"
              disabled={busy}
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
      >
        {selected && data && (
          <TaskEditor
            key={selected.id}
            task={selected}
            tasks={data.plan.tasks}
            language={language}
            busy={busy}
            run={run}
            actions={actions}
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
