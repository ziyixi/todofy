import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { extensionActions } from "./client";
import { words } from "./i18n";
import { todoistTaskUrl } from "./domain";
import { applyConfirmed, REREAD_AFTER_MS, rereadsAfter } from "./plan-updates";
import { TaskEditor } from "./TaskEditor";
import type {
  Language,
  PlanMetadata,
  PlusData,
  PlusSnapshot,
  RunOperation,
} from "./model";

export function NativeTaskTools({
  taskId,
  language,
  onReady,
  onUnavailable,
  snapshot,
  onSnapshot,
}: {
  taskId: string;
  language: Language;
  onReady?: (plan?: PlanMetadata) => void;
  onUnavailable?: () => void;
  /** Data from the last Plus visit on this page, if any. */
  snapshot?: PlusSnapshot;
  onSnapshot?: (snapshot: PlusSnapshot) => void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PlusData>();
  const [busy, setBusy] = useState(false);
  // Older remembered data is shown at once, but writes wait for the complete re-read.
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  // Changes when a write starts or ends; an overlapping read may predate the write.
  const writes = useRef(0);
  const readAt = useRef(0);
  const text = words(language);
  const read = useCallback(async () => {
    const version = writes.current;
    try {
      const next = await extensionActions.load();
      if (version !== writes.current) return;
      readAt.current = Date.now();
      setData(next);
      setStale(false);
      onReady?.(next.plan);
    } catch (failure) {
      onUnavailable?.();
      setError(failure instanceof Error ? failure.message : text.lastError);
    }
  }, [text.lastError, onReady, onUnavailable]);
  useEffect(() => {
    if (data) onSnapshot?.({ data, readAt: readAt.current });
  }, [data, onSnapshot]);
  function show() {
    const remembered = data ? { data, readAt: readAt.current } : snapshot;
    if (!remembered) return void read();
    readAt.current = remembered.readAt;
    setData(remembered.data);
    onReady?.(remembered.data.plan);
    if (
      Date.now() - remembered.readAt >= REREAD_AFTER_MS ||
      // A task created or changed in Todoist since then needs its own current version.
      !remembered.data.plan.tasks.some((task) => task.id === taskId)
    ) {
      setStale(true);
      void read();
      return;
    }
    // Recently read tasks need only the current account settings.
    void extensionActions
      .readPlan()
      .then((plan) => {
        setData((current) => current && applyConfirmed(current, plan));
        onReady?.(plan);
      })
      .catch((failure) => {
        onUnavailable?.();
        setError(failure instanceof Error ? failure.message : text.lastError);
      });
  }
  const run: RunOperation = async (operation) => {
    if (busy) return false;
    writes.current++;
    setBusy(true);
    setError("");
    let reread = false;
    try {
      const confirmed = await operation();
      setData((current) => current && applyConfirmed(current, confirmed));
      reread = rereadsAfter(confirmed);
      return true;
    } catch (failure) {
      onUnavailable?.();
      setError(failure instanceof Error ? failure.message : text.lastError);
      // The task may have changed in Todoist (a version mismatch); never reuse this data.
      readAt.current = 0;
      reread = true;
      return false;
    } finally {
      writes.current++;
      setBusy(false);
      if (reread) void read();
    }
  };
  const task = data?.plan.tasks.find((item) => item.id === taskId);
  return (
    <div className="plus-native-tools plus-root">
      <button
        className="plus-disclosure"
        aria-expanded={open}
        onClick={() => {
          if (open) onReady?.();
          else show();
          setOpen(!open);
        }}
      >
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        {text.details}
      </button>
      {open && (
        <>
          {error && (
            <p role="alert" className="plus-error">
              {error}
            </p>
          )}
          {!data && !error && <p className="plus-muted">{text.loading}</p>}
          {stale && (
            <p className="plus-muted" role="status">
              {text.updating}
            </p>
          )}
          {data && !data.plan.configured && (
            <p className="plus-muted">{text.setup}</p>
          )}
          {data?.plan.configured && !task && !stale && (
            <p className="plus-muted">{text.missingTask}</p>
          )}
          {task && data?.plan.configured && (
            <TaskEditor
              task={task}
              tasks={data.plan.tasks}
              language={language}
              busy={busy || stale}
              run={run}
              actions={extensionActions}
              todayTaskIds={data.focus.taskIds}
              addFocus={(id) => {
                if (!data.focus.taskIds.includes(id))
                  void run(() =>
                    extensionActions.addToDay(id, data.focus.date),
                  );
              }}
              onOpenTask={(id) => location.assign(todoistTaskUrl(id))}
            />
          )}
        </>
      )}
    </div>
  );
}
