import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  applyConfirmed,
  pendingTask,
  remapsTasks,
  REREAD_AFTER_MS,
  rereadsAfter,
  withNextWeek,
} from "./plan-updates";
import { Elapsed } from "./StatusMarks";
import { PlanView } from "./PlanView";
import { FocusView } from "./FocusView";
import { TaskEditor } from "./TaskEditor";
import { BoardLabels } from "./BoardLabels";
import { WeeklyGoals } from "./WeeklyGoals";
import type {
  Language,
  PendingChange,
  PlanState,
  PlanningTask,
  PlusActions,
  PlusData,
  PlusSnapshot,
  RunOperation,
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
  /** Data from an earlier visit, shown at once while it is read again in the background. */
  snapshot?: PlusSnapshot;
  /** The last confirmed data, or undefined once a remembered board is dropped. */
  onSnapshot?: (snapshot?: PlusSnapshot) => void;
  /** Opened from the weekly review task's link: Plan starts with the review checklist. */
  review?: boolean;
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
  snapshot,
  onSnapshot,
  review,
}: Props) {
  // What the server confirmed, from reads and writes. Pending drags are drawn on top of it.
  const [confirmed, setConfirmed] = useState<PlusData | undefined>(
    snapshot?.data,
  );
  const [pending, setPending] = useState<readonly PendingChange[]>([]);
  const data = useMemo(
    () =>
      confirmed &&
      pending.reduce(
        (shown, change) => change.predict?.(shown) ?? shown,
        confirmed,
      ),
    [confirmed, pending],
  );
  const pendingCards = useMemo(
    () => new Set(pending.flatMap((change) => change.pending)),
    [pending],
  );
  // An empty week follows the server's current week, including a Monday rollover while away.
  const displayedWeek = useRef(
    snapshot && snapshot.data.days[0]?.date !== snapshot.data.plan.week
      ? (snapshot.data.days[0]?.date ?? "")
      : "",
  );
  const weekRequest = useRef(0);
  // Reads can overlap (Refresh, returning to the tab); an older one never replaces a newer.
  const reads = useRef({ started: 0, shown: 0 });
  const [error, setError] = useState("");
  // Confirm-first writes queued or running; they disable write controls.
  const [waiting, setWaiting] = useState(0);
  // Shown data that needs a complete read before it is written: a remembered snapshot, which
  // may predate a completion or midnight, and every task etag after a new label mapping.
  const [stale, setStale] = useState(Boolean(snapshot));
  const remembered = useRef(Boolean(snapshot));
  const busy = waiting > 0 || stale;
  const [weekLoading, setWeekLoading] = useState(false);
  const [reading, setReading] = useState(0);
  // One queue runs every write in order: FlowDay queue updates keep the last write without an
  // etag, and a later Todoist write needs the etag an earlier one returns. A failure advances
  // the epoch, which drops the writes queued behind it.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const writes = useRef({ queued: 0, settled: 0, epoch: 0 });
  const rereadAfterWrites = useRef(false);
  const loadedAt = useRef(snapshot?.readAt ?? 0);
  const [selectedId, setSelectedId] = useState(externalTaskId ?? "");
  // The task whose editor opens at the empty step entry (a follow-up step from Waiting).
  const [stepsFor, setStepsFor] = useState("");
  const completionIds = useRef(new Map<string, string>());
  // Confirmed completions stay visible but disabled until a re-read shows the result.
  const [completing, setCompleting] = useState<ReadonlySet<string>>(new Set());
  const dialog = useRef<HTMLDialogElement>(null);
  const text = words(language);
  // A confirmed planning write on Sunday also changes next week's choices, which only ReadPlan lists.
  const planActions = useMemo<PlusActions>(
    () => ({
      ...actions,
      async updateTask(task, update) {
        const saved = await actions.updateTask(task, update);
        setConfirmed(
          (current) => current && withNextWeek(current, update, saved),
        );
        return saved;
      },
    }),
    [actions],
  );
  const load = useCallback(async (): Promise<boolean> => {
    const request = ++weekRequest.current;
    const read = ++reads.current.started;
    const settled = writes.current.settled;
    try {
      const week = displayedWeek.current;
      const next = await actions.load(week || undefined);
      // A write confirmed during the read may be missing from it.
      if (settled !== writes.current.settled) return false;
      if (read < reads.current.shown) return true;
      reads.current.shown = read;
      if (!displayedWeek.current) displayedWeek.current = next.plan.week;
      loadedAt.current = Date.now();
      remembered.current = false;
      setConfirmed((current) =>
        current && request !== weekRequest.current
          ? { ...next, days: current.days }
          : next,
      );
      setStale(false);
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
  // Reads never wait for writes or disable controls.
  const revalidate = useCallback(async () => {
    setReading((count) => count + 1);
    try {
      while (!(await load())) {
        // Read again now, or after the last queued write if any remain.
        if (writes.current.queued) {
          rereadAfterWrites.current = true;
          return;
        }
      }
    } catch (failure) {
      const message =
        failure instanceof Error ? failure.message : text.lastError;
      // A remembered board only bridges this visit's first read, as with a first load.
      if (remembered.current) setConfirmed(undefined);
      // A failed write's error stays: it says what was not saved.
      setError((current) => current || message);
    } finally {
      setReading((count) => count - 1);
    }
  }, [load, text.lastError]);
  const run: RunOperation = useCallback(
    (operation, change) => {
      const epoch = writes.current.epoch;
      writes.current.queued++;
      if (change) setPending((list) => [...list, change]);
      else setWaiting((count) => count + 1);
      setError("");
      const write = queue.current.then(async () => {
        let reread = false;
        try {
          // An earlier failure rolled back the changes this write was based on.
          if (epoch !== writes.current.epoch) return false;
          const result = await operation();
          setConfirmed((current) => current && applyConfirmed(current, result));
          // Every task etag changed, so writes wait for the re-read that follows.
          if (remapsTasks(result)) setStale(true);
          reread = rereadsAfter(result);
          return true;
        } catch (failure) {
          writes.current.epoch++;
          setPending([]);
          // Every write queued behind this one is dropped by the epoch check.
          const dropped = writes.current.queued - 1;
          setError(
            [
              change && text.restored,
              failure instanceof Error ? failure.message : text.lastError,
              dropped > 0 && `${text.notSent} ${dropped}`,
            ]
              .filter(Boolean)
              .join(" "),
          );
          // Another window may have changed the timer, queue or task. Show its current state.
          reread = true;
          return false;
        } finally {
          if (change)
            setPending((list) => list.filter((item) => item !== change));
          else setWaiting((count) => count - 1);
          writes.current.queued--;
          writes.current.settled++;
          if (reread) rereadAfterWrites.current = true;
          if (rereadAfterWrites.current && !writes.current.queued) {
            rereadAfterWrites.current = false;
            void revalidate();
          }
        }
      });
      queue.current = write;
      return write;
    },
    [revalidate, text],
  );
  useEffect(() => {
    void revalidate();
  }, [revalidate]);
  useEffect(() => {
    const visible = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - loadedAt.current >= REREAD_AFTER_MS
      ) {
        setError("");
        void revalidate();
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [revalidate]);
  useEffect(() => {
    onSnapshot?.(confirmed && { data: confirmed, readAt: loadedAt.current });
  }, [confirmed, onSnapshot]);
  useEffect(() => {
    if (externalTaskId) setSelectedId(externalTaskId);
  }, [externalTaskId]);
  useEffect(() => {
    if (!selectedId || !dialog.current) return;
    if (!dialog.current.open) dialog.current.showModal();
    // A follow-up step starts in the empty entry, once no running write disables it.
    const entry =
      stepsFor === selectedId
        ? dialog.current.querySelector<HTMLTextAreaElement>("textarea")
        : null;
    if (entry && !entry.disabled) {
      entry.focus();
      setStepsFor("");
    }
  }, [selectedId, stepsFor, busy, pendingCards]);
  function openTask(task: PlanningTask, steps = false) {
    setStepsFor(steps ? task.id : "");
    setSelectedId(task.id);
  }

  async function addFocus(id: string, day = data?.focus) {
    if (!data || !day || day.taskIds.includes(id)) return;
    await run(() => actions.addToDay(id, day.date));
  }
  function changeWeek(week: string): Promise<void> {
    const request = ++weekRequest.current;
    const settled = writes.current.settled;
    displayedWeek.current = week;
    setWeekLoading(true);
    return actions.loadDays(week).then(
      (days) => {
        if (weekRequest.current !== request) return;
        // A write confirmed during the read may be missing from these queues.
        if (settled !== writes.current.settled) return changeWeek(week);
        setConfirmed((current) => current && { ...current, days });
        setWeekLoading(false);
      },
      (failure) => {
        if (weekRequest.current !== request) return;
        setError(failure instanceof Error ? failure.message : text.lastError);
        setWeekLoading(false);
      },
    );
  }
  function commandTimer(
    action: "start" | "pause" | "resume" | "stop",
    taskId: string,
  ) {
    if (!data) return;
    void run(() => actions.timer(action, taskId, data.focus));
  }
  /** Completes in Focus by default; an empty day (the weekly review task) settles no FlowDay day. */
  function complete(
    task: PlanningTask,
    flowDate = data?.focus.timer?.taskId === task.id
      ? data.focus.timer.flowDate
      : (data?.focus.date ?? ""),
  ) {
    let id = completionIds.current.get(task.id);
    if (!id) {
      id = crypto.randomUUID();
      completionIds.current.set(task.id, id);
    }
    const requestId = id;
    return run(async () => {
      await actions.completeTask(task, requestId, flowDate);
      // Todoist may advance a recurring task, so only the following re-read shows the result.
      completionIds.current.delete(task.id);
      setCompleting((current) => new Set(current).add(task.id));
    });
  }
  const selected = data?.plan.tasks.find((task) => task.id === selectedId);
  // A task whose stage drag waits still carries its old etag, so its editor waits too.
  const selectedPending = Boolean(
    selected && pendingCards.has(pendingTask(selected.id)),
  );
  const timerTask = data?.plan.tasks.find(
    (task) => task.id === data.focus.timer?.taskId,
  );
  const timerSettling = Boolean(timerTask && completing.has(timerTask.id));
  function refresh() {
    if (error.includes("Extension updated. Reload Todoist to continue."))
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
            disabled={waiting > 0}
            onClick={refresh}
          >
            <RefreshCw
              size={17}
              className={waiting || weekLoading || reading ? "plus-spin" : ""}
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
                pending={pendingCards}
                run={run}
                actions={planActions}
                editTask={openTask}
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
                pending={pendingCards}
                run={run}
                actions={planActions}
                editTask={openTask}
                onLabels={() => setSelectedId("board-labels")}
                todayTaskIds={data.focus.taskIds}
                addFocus={(id) => void addFocus(id, data.focus)}
                addStep={(task) => openTask(task, true)}
                onOpenTask={onOpenTask}
                completeReview={(task) => complete(task, "")}
                reviewing={review}
              />
            </>
          ) : (
            <FocusView
              plan={data.plan}
              focus={data.focus}
              language={language}
              busy={busy || !data.plan.configured}
              pending={pendingCards}
              completing={completing}
              editTask={openTask}
              complete={(task) => void complete(task)}
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
              onClick={() => void complete(timerTask)}
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
            // Once the drag settles, the fields show what the server kept.
            key={`${selected.id}:${selectedPending}`}
            task={selected}
            tasks={data.plan.tasks}
            language={language}
            busy={busy || selectedPending}
            pending={selectedPending}
            run={run}
            actions={planActions}
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
