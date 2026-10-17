import { ArrowLeft } from "lucide-react";
import { formattedMinutes, taskIndex } from "./domain";
import { unplannedDue, unplannedText } from "./deadlines";
import { FocusBlock } from "./FocusBlock";
import { pendingStep } from "./plan-updates";
import { words } from "./i18n";
import type {
  FlowDayPlan,
  FocusState,
  Language,
  PlanState,
  PlanningTask,
} from "./model";

interface Props {
  plan: PlanState;
  focus: FocusState;
  /** The queues the quiet deadline line looks in: this week's, or only today's. */
  days?: readonly FlowDayPlan[];
  /** Opens Plan › Review with Start now focused. */
  onShowStart?: () => void;
  language: Language;
  busy: boolean;
  /** Day cards whose queue write is not yet confirmed. */
  pending?: ReadonlySet<string>;
  /** Completed task IDs that wait for the re-read showing the result. */
  completing?: ReadonlySet<string>;
  editTask: (task: PlanningTask) => void;
  complete: (task: PlanningTask) => void;
  onOpenPlan: () => void;
  onTimer: (
    action: "start" | "pause" | "resume" | "stop",
    taskId: string,
  ) => void;
}

export function FocusView({
  plan,
  focus,
  days = [focus],
  onShowStart,
  language,
  busy,
  pending,
  completing,
  editTask,
  complete,
  onOpenPlan,
  onTimer,
}: Props) {
  const text = words(language);
  const byId = taskIndex(plan.tasks);
  const queue = focus.taskIds.filter(
    (id) => !focus.completedTaskIds.includes(id),
  );
  const minutesOf = (id: string) =>
    focus.estimates[id] ??
    byId.get(id)?.estimatedMinutes ??
    focus.flowTasks[id]?.estimatedMinutes ??
    0;
  const totalMinutes = queue.reduce((sum, id) => sum + minutesOf(id), 0);
  const unknown = queue.filter((id) => !minutesOf(id)).length;
  let stepLabel = language === "zh" ? "个步骤" : "steps";
  if (language === "en" && queue.length === 1) stepLabel = "step";
  // A hint only: something that should have started has nothing planned this week.
  const due = unplannedDue(plan.tasks, days, focus.date, plan.dependencies);
  const openPlan = (
    <button className="plus-button" onClick={onOpenPlan}>
      <ArrowLeft size={15} />
      {language === "zh" ? "调整计划" : "Adjust plan"}
    </button>
  );
  return (
    <>
      <div className="plus-focus-summary">
        <strong>{formattedMinutes(totalMinutes)}</strong>
        <span>
          {queue.length} {stepLabel}
        </span>
        {unknown > 0 && (
          <span>
            {unknown} {text.unknown.toLowerCase()}
          </span>
        )}
        {queue.length > 0 && openPlan}
      </div>
      {due.past + due.window > 0 && (
        <button
          className="planning-runway plus-focus-runway"
          title={text.showInPlan}
          onClick={onShowStart}
        >
          {unplannedText(due, language)}
        </button>
      )}
      {queue.length > 0 ? (
        <ol
          className="plus-focus-stack"
          aria-label={language === "zh" ? "今天的步骤" : "Today's steps"}
        >
          {queue.map((id, index) => (
            <FocusBlock
              key={id}
              taskId={id}
              task={byId.get(id)}
              plan={plan}
              focus={focus}
              language={language}
              busy={busy}
              settling={Boolean(
                completing?.has(id) ||
                pending?.has(pendingStep(focus.date, id)),
              )}
              onTimer={onTimer}
              editTask={editTask}
              complete={complete}
              index={index}
              minutes={minutesOf(id)}
            />
          ))}
        </ol>
      ) : (
        <section className="plus-focus-empty">
          <p>
            {language === "zh"
              ? "今天还没有安排步骤。"
              : "No steps planned for today."}
          </p>
          {openPlan}
        </section>
      )}
      {focus.completedTaskIds.length > 0 && (
        <p className="plus-footer-note">
          {focus.completedTaskIds.length}{" "}
          {language === "zh" ? "已完成" : "completed today"}
        </p>
      )}
    </>
  );
}
