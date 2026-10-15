import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { extensionActions } from "./client";
import { words } from "./i18n";
import { todoistTaskUrl } from "./domain";
import { applyConfirmed, rereadsAfter } from "./plan-updates";
import { TaskEditor } from "./TaskEditor";
import type { Language, PlanState, PlusData, RunOperation } from "./model";

export function NativeTaskTools({
  taskId,
  language,
  onReady,
  onUnavailable,
}: {
  taskId: string;
  language: Language;
  onReady?: (plan?: PlanState) => void;
  onUnavailable?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PlusData>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Changes when a write starts or ends; an overlapping read may predate the write.
  const writes = useRef(0);
  const text = words(language);
  const read = useCallback(async () => {
    const version = writes.current;
    try {
      const next = await extensionActions.load();
      if (version !== writes.current) return;
      setData(next);
      onReady?.(next.plan);
    } catch (failure) {
      onUnavailable?.();
      setError(failure instanceof Error ? failure.message : text.lastError);
    }
  }, [text.lastError, onReady, onUnavailable]);
  useEffect(() => {
    if (open) void read();
  }, [open, read]);
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
          {data && !data.plan.configured && (
            <p className="plus-muted">{text.setup}</p>
          )}
          {task && data?.plan.configured && (
            <TaskEditor
              task={task}
              tasks={data.plan.tasks}
              language={language}
              busy={busy}
              run={run}
              actions={extensionActions}
              todayTaskIds={data.focus.taskIds}
              addFocus={(id) => {
                if (!data.focus.taskIds.includes(id))
                  void run(() =>
                    extensionActions.updateQueue(
                      [...data.focus.taskIds, id],
                      data.focus,
                    ),
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
