import { useEffect, useRef, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { useAnnouncement } from "./announce";
import { displayedTitle, STEP_MINUTES, validMinutes } from "./domain";
import { words } from "./i18n";
import { pendingTask, predictEstimate } from "./plan-updates";
import { PendingMark } from "./StatusMarks";
import { TaskBreadcrumb } from "./TaskBreadcrumb";
import type {
  Language,
  PlanningTask,
  PlusActions,
  RunOperation,
} from "./model";

export interface StepEditorProps {
  task: PlanningTask;
  /** The plan's tasks, which give the parents and the area. */
  tasks: PlanningTask[];
  language: Language;
  /** Another write waits, or this step's own: a choice saves nothing then. */
  busy: boolean;
  /** Its estimate is shown but not yet saved. */
  pending?: boolean;
  run: RunOperation;
  actions: PlusActions;
  onOpenTask: (id: string) => void;
  onClose?: () => void;
  /** The heading's ID, which names the dialog. */
  titleId?: string;
}

/**
 * The execution panel for Steps, Standalone and Quick actions: four estimate presets and a typed
 * number of minutes, with deletion after confirmation. Other fields are in the task's own dialog
 * (Open task). A choice shows at once and its cards wait until Tasks saves it; the presets are
 * only aria-disabled meanwhile, so focus stays on the one pressed.
 */
export function StepEditor({
  task,
  tasks,
  language,
  busy,
  pending = false,
  run,
  actions,
  onOpenTask,
  onClose,
  titleId,
}: StepEditorProps) {
  const text = words(language);
  const title = displayedTitle(task.title);
  const deleteLabel = task.kind === "task" ? text.deleteTask : text.deleteStep;
  // Tasks deletes its descendants with it, as the native dialog says.
  const hasChildren = tasks.some((item) => item.parentId === task.id);
  const saved = task.estimatedMinutes;
  const preset = STEP_MINUTES.some((value) => value === saved);
  // Only typed minutes have a draft; otherwise the field shows a saved value no preset has.
  const [draft, setDraft] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteRequest = useRef("");
  const deleteButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const editingDisabled = busy || confirmDelete;
  const [status, announce] = useAnnouncement();
  const shown = draft ?? (saved !== undefined && !preset ? String(saved) : "");
  const invalid = draft !== undefined && !validMinutes(Number(draft || NaN));
  useEffect(() => {
    if (confirmDelete) cancelButton.current?.focus();
    else if (deleteRequest.current) deleteButton.current?.focus();
  }, [confirmDelete]);

  async function save(minutes: number) {
    if (editingDisabled || minutes === saved) return;
    const done = await run(() => actions.updateEstimate(task, minutes), {
      pending: [pendingTask(task.id)],
      predict: predictEstimate(task.id, minutes),
    });
    if (done) announce(text.estimateSaved(`${minutes} ${text.minutes}`));
  }
  /** Enter or leaving the field: a changed, valid value saves; leaving drops an invalid one. */
  function saveTyped(leaving: boolean) {
    if (draft === undefined || editingDisabled) return;
    const minutes = Number(draft || NaN);
    if (validMinutes(minutes)) {
      setDraft(undefined);
      void save(minutes);
    } else if (leaving) setDraft(undefined);
  }

  async function remove() {
    if (busy) return;
    const done = await run(() =>
      actions.deleteTask(task, deleteRequest.current),
    );
    if (done) onClose?.();
  }

  return (
    <section
      className="plus-task-editor plus-step-editor"
      aria-labelledby={titleId}
    >
      <header className="plus-editor-header">
        <h2 id={titleId}>
          {title}
          {pending && <PendingMark language={language} />}
        </h2>
        {onClose && (
          <button
            className="plus-icon"
            aria-label={text.close}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        )}
      </header>
      <p className="plus-muted plus-native-note">
        {text.native}{" "}
        <button
          className="plus-text-button"
          onClick={() => onOpenTask(task.id)}
        >
          {text.open}
          <ExternalLink size={12} />
        </button>
      </p>
      <TaskBreadcrumb task={task} tasks={tasks} language={language} />
      <div
        className="plus-estimate-presets"
        role="group"
        aria-label={`${text.estimate}${language === "zh" ? "：" : ": "}${title}`}
      >
        <span aria-hidden="true">{text.estimate}</span>
        {STEP_MINUTES.map((value) => (
          <button
            key={value}
            type="button"
            className={saved === value ? "selected" : ""}
            aria-pressed={saved === value}
            aria-disabled={editingDisabled || undefined}
            onClick={() => void save(value)}
          >
            {value} {text.minutes}
          </button>
        ))}
        <input
          className="plus-custom-minutes"
          type="number"
          min={1}
          max={1440}
          step={1}
          value={shown}
          aria-label={text.estimate}
          aria-invalid={invalid || undefined}
          aria-disabled={editingDisabled || undefined}
          readOnly={editingDisabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              saveTyped(false);
            } else if (event.key === "Escape" && draft !== undefined) {
              // The first Escape restores the saved value; the next closes the dialog.
              event.preventDefault();
              setDraft(undefined);
            }
          }}
          onBlur={() => saveTyped(true)}
        />
      </div>
      <div className="plus-step-delete-actions">
        {confirmDelete ? (
          <div
            className="plus-step-delete-confirm"
            role="group"
            aria-label={deleteLabel}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              if (!busy) setConfirmDelete(false);
            }}
          >
            <span>
              {hasChildren
                ? text.confirmDeleteChildren(title)
                : text.confirmDeleteStep(title)}
            </span>
            <button
              ref={cancelButton}
              className="plus-button"
              disabled={busy}
              onClick={() => setConfirmDelete(false)}
            >
              {text.cancel}
            </button>
            <button
              className="plus-button plus-step-delete"
              disabled={busy}
              onClick={() => void remove()}
            >
              {text.delete}
            </button>
          </div>
        ) : (
          <button
            ref={deleteButton}
            className="plus-text-button plus-step-delete"
            disabled={busy}
            onClick={() => {
              deleteRequest.current = crypto.randomUUID();
              setConfirmDelete(true);
            }}
          >
            {deleteLabel}
          </button>
        )}
      </div>
      <p className="plus-sr-only" role="status">
        {status}
      </p>
    </section>
  );
}
