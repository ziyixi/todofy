import { useState } from "react";
import { useDraggable } from "@dnd-kit/react";
import { GripVertical } from "lucide-react";
import { displayedTitle } from "./domain";
import { words } from "./i18n";
import type { FocusState, Language, PlanningTask } from "./model";

/** Quick cards shown before "more". */
const QUICK_SHOWN = 6;

interface Props {
  /** Week's Quick tasks (weekly-review.ts quickTray). */
  tasks: PlanningTask[];
  timer?: FocusState["timer"];
  language: Language;
  busy: boolean;
  editTask: (task: PlanningTask) => void;
}
/**
 * The native Quick / Ops filter's tasks, as a quiet line under Next steps: one-line cards on the
 * step cards' surface that drag into a day exactly as a step does. Nothing shows without one.
 */
export function QuickTasks({ tasks, timer, language, busy, editTask }: Props) {
  const text = words(language);
  // Shown in full only on request, for this visit.
  const [expanded, setExpanded] = useState(false);
  if (!tasks.length) return null;
  const hidden = tasks.length - QUICK_SHOWN;
  return (
    <section className="planning-quick" aria-label={text.quickTasks}>
      <h3 className="planning-quick-heading">
        {text.quickTasks}
        <span>{tasks.length}</span>
      </h3>
      <ul>
        {(expanded ? tasks : tasks.slice(0, QUICK_SHOWN)).map((task) => (
          <QuickCard
            key={task.id}
            task={task}
            timing={timer?.taskId === task.id}
            language={language}
            busy={busy}
            editTask={editTask}
          />
        ))}
        {hidden > 0 && (
          <li className="planning-quick-more">
            <button
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? text.showFewer : text.moreItems(hidden)}
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}

function QuickCard({
  task,
  timing,
  language,
  busy,
  editTask,
}: {
  task: PlanningTask;
  /** Its session is running or paused, so it cannot move. */
  timing: boolean;
  language: Language;
  busy: boolean;
  editTask: Props["editTask"];
}) {
  const title = displayedTitle(task.title);
  const { ref, handleRef, isDragSource } = useDraggable({
    id: `quick:${task.id}`,
    type: "planning-step",
    disabled: busy || timing,
    data: { taskId: task.id, title },
  });
  return (
    <li
      ref={ref}
      className={`planning-quick-card ${isDragSource ? "is-dragging" : ""}`}
    >
      <button
        ref={handleRef}
        className="planning-drag-handle"
        disabled={busy || timing}
        title={
          timing
            ? language === "zh"
              ? "先结束当前计时再移动"
              : "Stop the current session before moving this step"
            : undefined
        }
        aria-label={`${words(language).dragQuick}: ${title}`}
      >
        <GripVertical size={14} />
      </button>
      <button
        className="planning-quick-title"
        title={title}
        onClick={() => editTask(task)}
      >
        {title}
      </button>
    </li>
  );
}
