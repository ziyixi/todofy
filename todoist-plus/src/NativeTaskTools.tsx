import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { extensionActions } from "./client";
import { words } from "./i18n";
import { todoistTaskUrl } from "./domain";
import { TaskEditor } from "./TaskEditor";
import type { FocusState, Language, PlanState, RunOperation } from "./model";

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
  const [data, setData] = useState<{ plan: PlanState; focus: FocusState }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const text = words(language);
  useEffect(() => {
    if (!open) return;
    setBusy(true);
    void extensionActions
      .load()
      .then((next) => {
        setData(next);
        onReady?.(next.plan);
      })
      .catch((failure) => {
        onUnavailable?.();
        setError(failure instanceof Error ? failure.message : text.lastError);
      })
      .finally(() => setBusy(false));
  }, [open, text.lastError, onReady, onUnavailable]);
  const run: RunOperation = async (operation) => {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      const confirmed = await operation();
      if (confirmed) {
        setData((current) => {
          if (!current) return current;
          const today = confirmed.find(
            (day) => day.date === current.focus.date,
          );
          return today
            ? { ...current, focus: { ...current.focus, ...today } }
            : current;
        });
      } else {
        const next = await extensionActions.load();
        setData(next);
        onReady?.(next.plan);
      }
      return true;
    } catch (failure) {
      onUnavailable?.();
      setError(failure instanceof Error ? failure.message : text.lastError);
      return false;
    } finally {
      setBusy(false);
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
          {busy && !data && <p className="plus-muted">{text.loading}</p>}
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
