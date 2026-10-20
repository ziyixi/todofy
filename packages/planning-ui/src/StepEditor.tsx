import { useState } from "react";
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
 * A Step's planning panel. A step takes its stage and area from its outcome, so its only planning
 * fact is how long it takes: four presets and a typed number of minutes. Every other field is in
 * the task's own dialog (Open task). A choice shows at once and the step's cards wait until Tasks
 * saves it; the presets are only aria-disabled meanwhile, so focus stays on the one pressed.
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
  const saved = task.estimatedMinutes;
  const preset = STEP_MINUTES.some((value) => value === saved);
  // Only typed minutes have a draft; otherwise the field shows a saved value no preset has.
  const [draft, setDraft] = useState<string>();
  const [status, announce] = useAnnouncement();
  const shown = draft ?? (saved !== undefined && !preset ? String(saved) : "");
  const invalid = draft !== undefined && !validMinutes(Number(draft || NaN));

  async function save(minutes: number) {
    if (busy || minutes === saved) return;
    const done = await run(() => actions.updateEstimate(task.id, minutes), {
      pending: [pendingTask(task.id)],
      predict: predictEstimate(task.id, minutes),
    });
    if (done) announce(text.estimateSaved(`${minutes} ${text.minutes}`));
  }
  /** Enter or leaving the field: a changed, valid value saves; leaving drops an invalid one. */
  function saveTyped(leaving: boolean) {
    if (draft === undefined || busy) return;
    const minutes = Number(draft || NaN);
    if (validMinutes(minutes)) {
      setDraft(undefined);
      void save(minutes);
    } else if (leaving) setDraft(undefined);
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
            aria-disabled={busy || undefined}
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
          aria-disabled={busy || undefined}
          readOnly={busy}
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
      <p className="plus-sr-only" role="status">
        {status}
      </p>
    </section>
  );
}
