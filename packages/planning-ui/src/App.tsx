import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  CalendarDays,
  Check,
  Pause,
  PictureInPicture2,
  Play,
  RefreshCw,
  Square,
} from "lucide-react";
import { displayedTitle, elapsed } from "./domain";
import { words } from "./i18n";
import { readableDate, weekLabel } from "./PlanningCalendar";
import {
  applyConfirmed,
  pendingTask,
  REREAD_AFTER_MS,
  rereadsAfter,
  withNextWeek,
  withWeek,
} from "./plan-updates";
import { Elapsed } from "./StatusMarks";
import { PlanView } from "./PlanView";
import { FocusView } from "./FocusView";
import { StepEditor } from "./StepEditor";
import { TaskEditor } from "./TaskEditor";
import { WeeklyGoals } from "./WeeklyGoals";
import { localDate } from "./mail";
import { MiniTimer } from "./MiniTimer";
import { useAnnouncement } from "./announce";
import type { IdleCommand } from "./idle-pause";
import { useIdlePause } from "./useIdlePause";
import {
  canOpenMiniWindow,
  openMiniWindow,
  type MiniWindow,
} from "./picture-in-picture";
import { outcomeForTask } from "./planning-outcomes";
import type { PlanViewPatch, PlanViewState } from "./plan-view-state";
import type {
  Area,
  Confirmed,
  Language,
  PendingChange,
  PlanState,
  PlanningTask,
  PlusActions,
  PlusData,
  PlusSnapshot,
  RenderGoalPicker,
  TimerSnapshot,
  View,
} from "./model";

export interface PlanningAppProps {
  actions: PlusActions;
  view: View;
  language: Language;
  onOpenTask: (id: string) => void;
  onSettings: () => void;
  renderGoalPicker?: RenderGoalPicker;
  onReady?: (plan?: PlanState) => void;
  externalTaskId?: string;
  /** A confirmed task write outside this planning surface requires a fresh snapshot. */
  refreshRevision?: number;
  onViewChange?: (view: View) => void;
  /** The weekly review's mail line opens the host's Mail page. */
  onOpenMail?: () => void;
  /** Focus and the weekly review open the host's GTD page. */
  onOpenGtd?: () => void;
  /** A selected statistics day opens Focus there; subsequent day navigation stays local. */
  focusDay?: string;
  /** Data from an earlier visit, shown at once while it is read again in the background. */
  snapshot?: PlusSnapshot;
  /** The last confirmed data, or undefined once a remembered board is dropped. */
  onSnapshot?: (snapshot?: PlusSnapshot) => void;
  /**
   * Each new positive value opens Plan's weekly review checklist: the host counts the weekly review task's
   * link, on load and each time it is launched into an open window.
   */
  review?: number;
  /** Plan's remembered view, and where its changes go. */
  planView?: PlanViewState;
  onPlanView?: (patch: PlanViewPatch) => void;
  /**
   * The host shows another page: nothing renders but the mini timer, which keeps working on its data, writes
   * and timer reads. Full reads wait until Plan or Focus shows again.
   */
  background?: boolean;
  /** Whether a Focus session exists, each time that changes in the confirmed data. */
  onSession?: (active: boolean) => void;
  /**
   * Pause when away, the owner's setting for this device, which the host keeps; with `onIdlePause`, Focus › Day
   * shows its toggle where the browser has the Idle Detection API.
   */
  idlePause?: boolean;
  onIdlePause?: (on: boolean) => void;
}
export function App({
  actions,
  view,
  language,
  onOpenTask,
  onSettings,
  renderGoalPicker,
  onReady,
  externalTaskId,
  refreshRevision,
  onViewChange,
  onOpenMail,
  onOpenGtd,
  focusDay,
  snapshot,
  onSnapshot,
  review,
  planView,
  onPlanView,
  background = false,
  onSession,
  idlePause,
  onIdlePause,
}: PlanningAppProps) {
  // What the server confirmed, from reads and writes. Pending drags are drawn on top of it.
  const [confirmed, setConfirmed] = useState<PlusData | undefined>(
    snapshot?.data,
  );
  // The latest confirmed data for code that runs between renders: a write queued behind another (an away pause)
  // reads it when it runs. A confirmed write updates it at once; reads reach it as they render.
  const latestData = useRef(confirmed);
  useLayoutEffect(() => {
    latestData.current = confirmed;
  }, [confirmed]);
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
  // The last write failed, rather than a read: the mini timer says so until the next write.
  const [writeFailed, setWriteFailed] = useState(false);
  // The open mini timer (Document Picture-in-Picture), one per page.
  const [mini, setMini] = useState<MiniWindow>();
  // Confirm-first writes queued or running; they disable write controls.
  const [waiting, setWaiting] = useState(0);
  // Shown data that needs a complete read before it is written: a remembered snapshot, which
  // may predate a completion or midnight.
  const [stale, setStale] = useState(Boolean(snapshot));
  const remembered = useRef(Boolean(snapshot));
  const busy = waiting > 0 || stale;
  const [weekLoading, setWeekLoading] = useState(false);
  const [reading, setReading] = useState(0);
  // One queue runs every write in order: a later task write needs the etag an earlier one
  // returns, and a queue move places a step among the steps earlier moves left. A failure
  // advances the epoch, which drops the writes queued behind it.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const writes = useRef({ queued: 0, settled: 0, epoch: 0 });
  const rereadAfterWrites = useRef(false);
  const loadedAt = useRef(snapshot?.readAt ?? 0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [selectedId, setSelectedId] = useState(externalTaskId ?? "");
  // Focus's quiet line opens Plan at Start now.
  const [showStart, setShowStart] = useState(false);
  // Focus opens today unless statistics chose a day. An empty date follows Tasks' today at midnight.
  const [focusDate, setFocusDate] = useState(focusDay ?? "");
  const [requestedFocusDay, setRequestedFocusDay] = useState(focusDay);
  const [showCompleted, setShowCompleted] = useState(false);
  // Shown again after another page, Plan and Focus open as on a first visit; their dialog closed with them.
  const shownView = background ? undefined : view;
  const [visited, setVisited] = useState(shownView);
  if (visited !== shownView) {
    setVisited(shownView);
    setFocusDate(shownView === "focus" ? (focusDay ?? "") : "");
    setShowCompleted(false);
    if (!shownView) setSelectedId("");
  }
  if (requestedFocusDay !== focusDay) {
    setRequestedFocusDay(focusDay);
    if (shownView === "focus") setFocusDate(focusDay ?? "");
  }
  // Confirmed writes so far; Focus reads the other days it shows again after each.
  const [written, setWritten] = useState(0);
  // Each task's completion keeps its first request ID and Focus day until it is confirmed, so a
  // retry, from any view, resends both and a lost answer replays instead of completing again.
  const completionIds = useRef(
    new Map<string, { requestId: string; focusDay: string }>(),
  );
  // Confirmed completions stay visible but disabled until a re-read shows the result.
  const [completing, setCompleting] = useState<ReadonlySet<string>>(new Set());
  const dialog = useRef<HTMLDialogElement>(null);
  // The open panel's heading, which names the dialog.
  const dialogTitle = useId();
  // When the dialog opened, and what had focus then, which gets it back when it closes.
  const openedAt = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
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
      // A week shown since this read started stays, with the tasks its read named.
      setConfirmed((current) =>
        current && request !== weekRequest.current
          ? withWeek(next, {
              days: current.days,
              tasks: { ...current.focus.tasks, ...next.focus.tasks },
            })
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
  /** The RunOperation every view gets; `quiet` (a retry of a failed away pause) shows no error of its own. */
  const run = useCallback(
    (
      operation: () => Promise<Confirmed>,
      change?: PendingChange,
      quiet = false,
    ) => {
      const epoch = writes.current.epoch;
      writes.current.queued++;
      if (change) setPending((list) => [...list, change]);
      else setWaiting((count) => count + 1);
      const clearError = () => {
        setError("");
        setWriteFailed(false);
      };
      // A quiet retry leaves the error it retries until it succeeds.
      if (!quiet) clearError();
      const write = queue.current.then(async () => {
        let reread = false;
        try {
          // An earlier failure rolled back the changes this write was based on.
          if (epoch !== writes.current.epoch) return false;
          const result = await operation();
          latestData.current =
            latestData.current && applyConfirmed(latestData.current, result);
          setConfirmed((current) => current && applyConfirmed(current, result));
          setWritten((count) => count + 1);
          if (quiet) clearError();
          reread = rereadsAfter(result);
          return true;
        } catch (failure) {
          writes.current.epoch++;
          setPending([]);
          // Every write queued behind this one is dropped by the epoch check.
          const dropped = writes.current.queued - 1;
          if (!quiet) {
            setWriteFailed(true);
            setError(
              [
                change && text.restored,
                failure instanceof Error ? failure.message : text.lastError,
                dropped > 0 && `${text.notSent} ${dropped}`,
              ]
                .filter(Boolean)
                .join(" "),
            );
          }
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
  // Timer reads started and settled; only the newest one's answer is shown.
  const timerReads = useRef({ started: 0, settled: 0 });
  /** One GetFocusTimer, shown unless a write or a full read started meanwhile. */
  const readTimer = useCallback(async () => {
    if (!actions.readTimer) return;
    const read = ++timerReads.current.started;
    const settled = writes.current.settled;
    const planRead = reads.current.started;
    try {
      const timer = await actions.readTimer();
      if (
        mounted.current &&
        read === timerReads.current.started &&
        settled === writes.current.settled &&
        planRead === reads.current.started &&
        !writes.current.queued
      )
        setConfirmed((current) => current && applyConfirmed(current, timer));
    } catch (failure) {
      if (mounted.current)
        setError(
          (current) =>
            current ||
            (failure instanceof Error ? failure.message : text.lastError),
        );
    } finally {
      timerReads.current.settled++;
    }
  }, [actions, text.lastError]);
  // Whether the mini timer is open, for effects that must not rerun when it opens or closes.
  const miniOpen = useRef(false);
  // In the background, full reads wait: one runs when Plan or Focus shows again, if a read was missed or the
  // data has aged. A missed read means a task write elsewhere, so writes wait for that read.
  const inBackground = useRef(background);
  const missedRead = useRef(false);
  useEffect(() => {
    if (background === inBackground.current) return;
    inBackground.current = background;
    if (background) return;
    if (missedRead.current) setStale(true);
    if (
      missedRead.current ||
      Date.now() - loadedAt.current >= REREAD_AFTER_MS
    ) {
      missedRead.current = false;
      void revalidate();
    }
  }, [background, revalidate]);
  useEffect(() => {
    // Shown, mounted behind another page with nothing read yet (the host found a session there), or with the mini
    // timer open, whose Complete needs the task's current etag: a full read now.
    if (!inBackground.current || !latestData.current || miniOpen.current) {
      void revalidate();
      return;
    }
    // Otherwise the full read waits, but the timer is read now: completing or deleting the step elsewhere ends
    // its session, which the away watch and the session the host keeps must not outlive.
    missedRead.current = true;
    if (writes.current.queued) rereadAfterWrites.current = true;
    else void readTimer();
  }, [revalidate, readTimer, refreshRevision]);
  useEffect(() => {
    const visible = () => {
      if (
        document.visibilityState === "visible" &&
        !inBackground.current &&
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
    if (!confirmed || !actions.readTimer) return;
    // The mini timer floats in view while the main window is often hidden.
    const visible = () =>
      document.visibilityState === "visible" ||
      mini?.window.document.visibilityState === "visible";
    const refreshTimer = async () => {
      if (
        timerReads.current.started !== timerReads.current.settled ||
        reading ||
        writes.current.queued ||
        !visible()
      )
        return;
      if (
        localDate(new Date().toISOString(), confirmed.plan.timezone) !==
        confirmed.plan.today
      ) {
        await revalidate();
        return;
      }
      await readTimer();
    };
    const interval = window.setInterval(
      () => void refreshTimer(),
      REREAD_AFTER_MS,
    );
    window.addEventListener("focus", refreshTimer);
    mini?.window.addEventListener("focus", refreshTimer);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", refreshTimer);
      mini?.window.removeEventListener("focus", refreshTimer);
    };
  }, [
    actions,
    confirmed?.plan.timezone,
    confirmed?.plan.today,
    mini,
    readTimer,
    reading,
    revalidate,
  ]);
  useEffect(() => {
    const timer = confirmed?.focus.timer;
    if (
      !timer ||
      timer.status !== "running" ||
      timer.mode !== "pomodoro" ||
      !timer.targetSeconds ||
      busy ||
      error
    )
      return;
    const remaining = timer.targetSeconds - elapsed(confirmed.focus);
    const timeout = window.setTimeout(
      () => {
        void run(() => actions.timer("finish", timer.taskId, confirmed.focus));
      },
      Math.max(0, remaining) * 1000 + 1000,
    );
    return () => clearTimeout(timeout);
  }, [actions, confirmed?.focus.timer, busy, error, run]);
  useEffect(() => {
    onSnapshot?.(confirmed && { data: confirmed, readAt: loadedAt.current });
  }, [confirmed, onSnapshot]);
  // Pause when away: its commands run in the one write queue against the latest confirmed timer, read when they
  // run rather than when they were queued.
  const sendIdle = useCallback(
    async (command: IdleCommand, quiet: boolean) => {
      let saved: TimerSnapshot | undefined;
      const sent = await run(
        async () => {
          const focus = latestData.current?.focus;
          // The session ended meanwhile: nothing to send; the read that follows shows what changed.
          if (!focus?.timer) return undefined;
          saved = await actions.timer(
            command.action,
            focus.timer.taskId,
            focus,
            undefined,
            undefined,
            command.at === undefined
              ? undefined
              : new Date(command.at).toISOString(),
          );
          return saved;
        },
        undefined,
        quiet,
      );
      return sent ? saved : undefined;
    },
    [actions, run],
  );
  const [spoken, announce] = useAnnouncement();
  const away = useIdlePause({
    enabled: idlePause,
    onEnabled: onIdlePause,
    timer: confirmed?.focus.timer,
    send: sendIdle,
    onAnswered: (kept) =>
      announce(kept ? text.awayCounted : text.resumedFromNow),
  });
  const question = away.question;
  const askedMinutes = question?.minutes;
  useEffect(() => {
    if (askedMinutes) announce(text.away(askedMinutes));
  }, [announce, askedMinutes, text]);
  const session = confirmed && Boolean(confirmed.focus.timer);
  useEffect(() => {
    if (session !== undefined) onSession?.(session);
  }, [session, onSession]);
  // The mini timer's window closes with this page (and on a reload, with the browser's).
  useEffect(() => {
    miniOpen.current = Boolean(mini);
    if (!mini) return;
    const closed = () => setMini(undefined);
    mini.window.addEventListener("pagehide", closed);
    return () => {
      mini.window.removeEventListener("pagehide", closed);
      mini.window.close();
    };
  }, [mini]);
  const root = useRef<HTMLDivElement>(null);
  const opening = useRef(false);
  useEffect(() => {
    if (externalTaskId) setSelectedId(externalTaskId);
  }, [externalTaskId]);
  useEffect(() => {
    if (selectedId && dialog.current && !dialog.current.open) {
      const focused = document.activeElement;
      opener.current =
        focused instanceof HTMLElement && focused !== document.body
          ? focused
          : null;
      dialog.current.showModal();
      openedAt.current = performance.now();
    }
  }, [selectedId]);
  /**
   * A double-click's second press and click, when its first click opened the dialog: they land on
   * the backdrop, which would close it, or on a control in the panel, which would write. A double
   * click that opens the dialog itself (Week's commitments) has no presses after it.
   */
  function swallowSecondClick(event: MouseEvent) {
    if (event.detail > 1 && performance.now() - openedAt.current < 600) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  function openTask(task: PlanningTask) {
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
      (range) => {
        if (weekRequest.current !== request) return;
        // A write confirmed during the read may be missing from these queues.
        if (settled !== writes.current.settled) return changeWeek(week);
        setConfirmed((current) => current && withWeek(current, range));
        setWeekLoading(false);
      },
      (failure) => {
        if (weekRequest.current !== request) return;
        setError(failure instanceof Error ? failure.message : text.lastError);
        setWeekLoading(false);
      },
    );
  }
  /** One timer command; Start also sends its pomodoro length (none counts up) and the task's area. */
  function commandTimer(
    action: "start" | "pause" | "resume" | "stop" | "finish",
    taskId: string,
    targetSeconds?: number,
    area?: Area,
  ) {
    if (!data) return;
    void run(() =>
      actions.timer(action, taskId, data.focus, targetSeconds, area),
    );
  }
  /**
   * Completes in Tasks, which marks the task done in `focusDay`'s queue: Focus's day by default, a
   * calendar card's own day, and Tasks' today for an empty one (the weekly review task). A related
   * timer settles on its own day.
   */
  function complete(task: PlanningTask, focusDay = data?.focus.date ?? "") {
    let completion = completionIds.current.get(task.id);
    if (!completion) {
      completion = { requestId: crypto.randomUUID(), focusDay };
      completionIds.current.set(task.id, completion);
    }
    const { requestId, focusDay: day } = completion;
    return run(async () => {
      await actions.completeTask(task, requestId, day);
      // Tasks may advance a recurring task, so only the following re-read shows the result.
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
  // The mini timer closes as the session ends: stopped, finished, completed once confirmed, or gone on a read;
  // also when it ended while the window was opening.
  const sessionOpen = Boolean(data?.focus.timer) && !timerSettling;
  useEffect(() => {
    if (mini && !sessionOpen) setMini(undefined);
  }, [mini, sessionOpen]);
  /** Opens the mini timer, or closes it when open. */
  async function toggleMini() {
    if (mini) return setMini(undefined);
    if (opening.current || !root.current) return;
    opening.current = true;
    const opened = await openMiniWindow(root.current, language);
    opening.current = false;
    if (opened && mounted.current) setMini(opened);
    else opened?.window.close();
  }
  function refresh() {
    setError("");
    void revalidate();
  }
  // Above every page's content: what failed.
  const notices = error && (
    <div className="plus-error" role="alert">
      <span>{error}</span>
      <button onClick={refresh}>{text.refresh}</button>
      <button onClick={onSettings}>{text.manage}</button>
    </div>
  );
  // While the away question waits it takes a line of its own above the bar's row, in place of the status, and its
  // answers take Pause/Resume's place.
  const timerBar = data?.focus.timer && (
    <aside
      className={question ? "plus-timer-bar is-asking" : "plus-timer-bar"}
      aria-label={text.focus}
    >
      {question && (
        <small className="plus-away-question">
          {text.away(question.minutes)}
        </small>
      )}
      <div>
        {!question && (
          <small>
            {data.focus.timer.status === "running" ? text.focus : text.paused}
          </small>
        )}
        <strong>
          {timerTask
            ? displayedTitle(timerTask.title)
            : (data.focus.tasks[data.focus.timer.taskId]?.title ?? text.focus)}
        </strong>
      </div>
      <output>
        <Elapsed focus={data.focus} />
      </output>
      {question ? (
        <span className="plus-away-answers">
          <button disabled={busy || timerSettling} onClick={question.keep}>
            {text.keep}
          </button>
          <button disabled={busy || timerSettling} onClick={question.discard}>
            {text.discard}
          </button>
        </span>
      ) : (
        <button
          className="plus-icon"
          disabled={busy || timerSettling}
          aria-label={
            data.focus.timer.status === "running" ? text.pause : text.resume
          }
          title={
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
      )}
      <button
        className="plus-icon"
        disabled={busy || timerSettling}
        aria-label={text.stop}
        title={text.stop}
        onClick={() => commandTimer("stop", data.focus.timer!.taskId)}
      >
        <Square size={15} />
      </button>
      {timerTask && (
        <button
          className="plus-icon"
          disabled={busy || timerSettling}
          aria-label={text.complete}
          title={text.complete}
          onClick={() => void complete(timerTask)}
        >
          <Check size={18} />
        </button>
      )}
      {canOpenMiniWindow() && (
        <button
          className="plus-icon plus-pip-toggle"
          aria-label={text.miniTimer}
          title={text.miniTimer}
          aria-pressed={Boolean(mini)}
          onClick={() => void toggleMini()}
        >
          <PictureInPicture2 size={17} />
        </button>
      )}
    </aside>
  );
  // The mini timer acts through the timer bar's own functions, so through the one write queue.
  let miniTimer: ReactNode = null;
  if (mini && data?.focus.timer) {
    const timer = data.focus.timer;
    const known = data.focus.tasks[timer.taskId];
    const outcome = timerTask && outcomeForTask(timerTask, data.plan.tasks);
    // The step's records on the session's day: today's, or that day's in the shown week.
    const day =
      timer.day === data.focus.date
        ? data.focus
        : data.days.find((item) => item.date === timer.day);
    miniTimer = createPortal(
      <MiniTimer
        clock={mini.window}
        language={language}
        focus={{ ...data.focus, timer }}
        title={
          timerTask
            ? displayedTitle(timerTask.title)
            : known && displayedTitle(known.title)
        }
        outcome={
          outcome && outcome.id !== timer.taskId
            ? displayedTitle(outcome.title)
            : undefined
        }
        estimate={
          data.focus.estimates[timer.taskId] ??
          timerTask?.estimatedMinutes ??
          known?.estimatedMinutes ??
          0
        }
        recorded={(day?.entries ?? [])
          .filter((entry) => entry.taskId === timer.taskId)
          .reduce((sum, entry) => sum + entry.seconds, 0)}
        busy={busy || timerSettling}
        failed={writeFailed && Boolean(error)}
        onTimer={(action) => commandTimer(action, timer.taskId)}
        onComplete={timerTask && (() => void complete(timerTask))}
        away={question}
      />,
      mini.container,
    );
  }
  return (
    // The mini timer keeps its place in the tree, so moving to the background does not remount it.
    <>
      <p className="plus-sr-only" role="status">
        {spoken}
      </p>
      {/* Behind another page, only the away question's timer bar shows. */}
      {background && question && (
        <div className="plus-root plus-root-background" ref={root}>
          {timerBar}
        </div>
      )}
      {!background && (
        <div className={`plus-root plus-root-${view}`} ref={root}>
          <header className="plus-page-header">
            <div>
              <h1>{view === "plan" ? text.plan : text.focus}</h1>
              <div className="plus-subtitle">
                <CalendarDays size={13} />
                {data
                  ? view === "plan"
                    ? weekLabel(data.days[0]?.date ?? data.plan.week, language)
                    : readableDate(focusDate || data.focus.date, language)
                  : ""}
                {data && <span> · {data.plan.timezone}</span>}
              </div>
            </div>
            <div className="plus-header-actions">
              {view === "focus" && (
                <label className="plus-completed-toggle">
                  <input
                    type="checkbox"
                    checked={showCompleted}
                    onChange={(event) => setShowCompleted(event.target.checked)}
                  />
                  {text.completed}
                </label>
              )}
              <button
                className="plus-icon plus-refresh"
                aria-label={text.refresh}
                disabled={waiting > 0}
                onClick={refresh}
              >
                <RefreshCw
                  size={17}
                  className={
                    waiting || weekLoading || reading ? "plus-spin" : ""
                  }
                />
              </button>
            </div>
          </header>
          {notices}
          {!data && !error && (
            <p className="plus-muted" role="status">
              {text.loading}
            </p>
          )}
          {data && (
            <fieldset className="plus-content-fieldset">
              {view === "plan" ? (
                <>
                  <WeeklyGoals
                    plan={data.plan}
                    language={language}
                    busy={busy}
                    run={run}
                    actions={planActions}
                    renderGoalPicker={renderGoalPicker}
                  />
                  <PlanView
                    plan={data.plan}
                    days={data.days}
                    focusTasks={data.focus.tasks}
                    timer={data.focus.timer}
                    currentDate={data.plan.today}
                    onWeekChange={changeWeek}
                    language={language}
                    busy={busy || weekLoading}
                    pending={pendingCards}
                    run={run}
                    actions={planActions}
                    renderGoalPicker={renderGoalPicker}
                    editTask={openTask}
                    completeReview={(task) => complete(task, "")}
                    completeTask={(task, day) => void complete(task, day)}
                    onOpenTask={onOpenTask}
                    onOpenMail={onOpenMail}
                    onOpenGtd={onOpenGtd}
                    reviewing={review}
                    planView={planView}
                    onPlanView={onPlanView}
                    showStart={showStart}
                    onStartShown={() => setShowStart(false)}
                  />
                </>
              ) : (
                <FocusView
                  plan={data.plan}
                  focus={data.focus}
                  // The quiet line looks at this week's queues; while Plan shows another week, at today's.
                  days={
                    data.days[0]?.date === data.plan.week
                      ? data.days
                      : [data.focus]
                  }
                  onShowStart={() => {
                    setShowStart(true);
                    onViewChange?.("plan");
                  }}
                  language={language}
                  busy={busy}
                  pending={pendingCards}
                  completing={completing}
                  date={focusDate || data.focus.date}
                  onNavigate={(date) => {
                    setFocusDate(date === data.focus.date ? "" : date);
                  }}
                  onOpenGtd={onOpenGtd}
                  actions={planActions}
                  run={run}
                  written={written}
                  showCompleted={showCompleted}
                  onOpenTask={onOpenTask}
                  editTask={openTask}
                  complete={(task) => void complete(task)}
                  onOpenPlan={() => onViewChange?.("plan")}
                  onTimer={commandTimer}
                  idlePause={away.toggle}
                  away={question}
                />
              )}
            </fieldset>
          )}
          {timerBar}
          <dialog
            className="plus-dialog"
            ref={dialog}
            aria-labelledby={selected && data ? dialogTitle : undefined}
            onClose={() => {
              setSelectedId("");
              if (opener.current?.isConnected) opener.current.focus();
              opener.current = null;
            }}
            onCancel={() => setSelectedId("")}
            onClickCapture={swallowSecondClick}
            onMouseDownCapture={swallowSecondClick}
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                dialog.current?.close();
                setSelectedId("");
              }
            }}
          >
            {selected && data && selected.kind === "step" && (
              <StepEditor
                // Not keyed by its pending estimate: a save keeps the panel and its focus.
                key={selected.id}
                task={selected}
                tasks={data.plan.tasks}
                language={language}
                busy={busy || selectedPending}
                pending={selectedPending}
                run={run}
                actions={planActions}
                onOpenTask={onOpenTask}
                titleId={dialogTitle}
                onClose={() => {
                  dialog.current?.close();
                  setSelectedId("");
                }}
              />
            )}
            {selected && data && selected.kind !== "step" && (
              <TaskEditor
                // Once the drag settles, the fields show what the server kept.
                key={`${selected.id}:${selectedPending}`}
                titleId={dialogTitle}
                task={selected}
                tasks={data.plan.tasks}
                dependencies={data.plan.dependencies}
                language={language}
                busy={busy || selectedPending}
                pending={selectedPending}
                run={run}
                actions={planActions}
                todayTaskIds={data.focus.taskIds}
                today={data.plan.today}
                addFocus={(id) => void addFocus(id, data.focus)}
                onOpenTask={onOpenTask}
                onOpenDependency={setSelectedId}
                onClose={() => {
                  dialog.current?.close();
                  setSelectedId("");
                }}
              />
            )}
          </dialog>
        </div>
      )}
      {miniTimer}
    </>
  );
}
