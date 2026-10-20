import { useState, type CSSProperties } from "react";
import { useDraggable } from "@dnd-kit/react";
import { GripVertical } from "lucide-react";
import { displayedTitle, effectiveArea } from "./domain";
import { dragHandle } from "./drag-announcements";
import { FullTitle, markCut } from "./FullTitle";
import { areaColor } from "./planning-outcomes";
import {
  CompleteTaskButton,
  type CompletePlanningTask,
} from "./CompleteTaskButton";
import { words } from "./i18n";
import type { FocusState, Language, PlanningTask } from "./model";

/** Quick cards shown before "more". */
const QUICK_SHOWN = 6;

interface Props {
  /** Week's Quick tasks (weekly-review.ts quickTray). */
  tasks: PlanningTask[];
  /** The plan's tasks, which give each card its area. */
  planTasks: PlanningTask[];
  timer?: FocusState["timer"];
  language: Language;
  busy: boolean;
  /** The ID of the drag instructions, which every handle names. */
  dragHint: string;
  editTask: (task: PlanningTask) => void;
  completeTask: CompletePlanningTask;
}
/**
 * The native Quick / Ops filter's tasks, as a quiet line under Next steps: equal-width one-line
 * cards on the step cards' surface that drag into a day exactly as a step does. "N more" follows
 * the heading's count, so it never takes a card's place. Nothing shows without one.
 */
export function QuickTasks({
  tasks,
  planTasks,
  timer,
  language,
  busy,
  dragHint,
  editTask,
  completeTask,
}: Props) {
  const text = words(language);
  // Shown in full only on request, for this visit.
  const [expanded, setExpanded] = useState(false);
  if (!tasks.length) return null;
  const hidden = tasks.length - QUICK_SHOWN;
  return (
    <section className="planning-quick" aria-label={text.quickTasks}>
      <div className="planning-quick-heading">
        <h3>
          {text.quickTasks}
          <span>{tasks.length}</span>
        </h3>
        {hidden > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <button
              className="planning-quick-more"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? text.showFewer : text.moreItems(hidden)}
            </button>
          </>
        )}
      </div>
      <ul>
        {(expanded ? tasks : tasks.slice(0, QUICK_SHOWN)).map((task) => (
          <QuickCard
            key={task.id}
            task={task}
            planTasks={planTasks}
            timing={timer?.taskId === task.id}
            language={language}
            busy={busy}
            dragHint={dragHint}
            editTask={editTask}
            completeTask={completeTask}
          />
        ))}
      </ul>
    </section>
  );
}

function QuickCard({
  task,
  planTasks,
  timing,
  language,
  busy,
  dragHint,
  editTask,
  completeTask,
}: {
  task: PlanningTask;
  planTasks: PlanningTask[];
  /** Its session is running or paused, so it cannot move. */
  timing: boolean;
  language: Language;
  busy: boolean;
  dragHint: string;
  editTask: Props["editTask"];
  completeTask: CompletePlanningTask;
}) {
  const title = displayedTitle(task.title);
  const text = words(language);
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
      style={{ "--area-color": areaColor(task, planTasks) } as CSSProperties}
    >
      <button
        ref={handleRef}
        className="planning-drag-handle"
        {...dragHandle(language, dragHint)}
        disabled={busy || timing}
        title={
          timing
            ? language === "zh"
              ? "先结束当前计时再移动"
              : "Stop the current session before moving this step"
            : undefined
        }
        aria-label={`${text.dragQuick}: ${title}`}
      >
        <GripVertical size={14} />
      </button>
      <button
        className="planning-quick-title"
        onClick={() => editTask(task)}
        onPointerEnter={markCut}
        onFocus={markCut}
      >
        <FullTitle text={title} />
        {/* The edge colour says the area; screen readers hear it. */}
        <span className="plus-sr-only">
          {`${language === "zh" ? "，" : ", "}${text[effectiveArea(task, planTasks)]}`}
        </span>
      </button>
      <CompleteTaskButton
        task={task}
        language={language}
        disabled={busy}
        onComplete={() => completeTask(task)}
      />
    </li>
  );
}
