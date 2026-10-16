import { useEffect, useRef, useState } from "react";
import { effectiveArea } from "./domain";
import { canMarkActive } from "./deadlines";
import { DeadlineList } from "./DeadlineList";
import { planningOutcomes } from "./planning-outcomes";
import { ReviewBoard } from "./ReviewBoard";
import { PlanningWeek } from "./PlanningWeek";
import { WaitingList } from "./WaitingList";
import { WeeklyReview } from "./WeeklyReview";
import { words } from "./i18n";
import type {
  RunOperation,
  Area,
  FlowDayPlan,
  FocusState,
  Language,
  PlanState,
  PlanningTask,
  PlusActions,
} from "./model";

export interface PlanViewProps {
  plan: PlanState;
  days: FlowDayPlan[];
  flowTasks: FocusState["flowTasks"];
  timer?: FocusState["timer"];
  currentDate: string;
  language: Language;
  busy: boolean;
  /** Cards whose drag or removal is not yet confirmed. */
  pending?: ReadonlySet<string>;
  run: RunOperation;
  actions: PlusActions;
  editTask: (task: PlanningTask) => void;
  onWeekChange: (weekStart: string) => void;
  onLabels?: () => void;
  todayTaskIds: readonly string[];
  addFocus: (id: string) => void;
  /** Opens the task's step editor, empty, for a follow-up step. */
  addStep: (task: PlanningTask) => void;
  /** Opens the task's editor at its start-ahead choice. */
  chooseLead: (task: PlanningTask) => void;
  onOpenTask: (id: string) => void;
  completeReview: (task: PlanningTask) => Promise<boolean>;
  /** Opened from the review task's link: start with the weekly review. */
  reviewing?: boolean;
  /** The owner's open or closed choice for Deadlines this visit; undefined follows the default. */
  deadlinesOpen?: boolean;
  onDeadlinesToggle?: (open: boolean) => void;
  /** Opened from Focus's quiet line: Review, with Deadlines open and focused. */
  showDeadlines?: boolean;
  onDeadlinesShown?: () => void;
}
export function PlanView(props: PlanViewProps) {
  const { plan, language, editTask, onLabels } = props;
  const [mode, setMode] = useState<"review" | "week">("review");
  const [area, setArea] = useState<Area | "all">("all");
  const [reviewing, setReviewing] = useState(Boolean(props.reviewing));
  const [waitingOpen, setWaitingOpen] = useState(false);
  // A review jump focuses its target and scrolls it into view once; Week mounts at the first
  // unplanned commitment.
  const [jump, setJump] = useState<"waiting" | "runway" | "deadlines">();
  const section = useRef<HTMLElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const text = words(language);
  useEffect(() => {
    if (props.reviewing) setReviewing(true);
  }, [props.reviewing]);
  const { showDeadlines, onDeadlinesShown } = props;
  useEffect(() => {
    if (!showDeadlines) return;
    setMode("review");
    setJump("deadlines");
    onDeadlinesShown?.();
  }, [showDeadlines, onDeadlinesShown]);
  useEffect(() => {
    if (!jump) return;
    const target = section.current?.querySelector<HTMLElement>(
      {
        waiting: ".planning-waiting > summary",
        runway: ".planning-runway",
        deadlines: ".planning-deadlines > summary",
      }[jump],
    );
    target?.focus({ preventScroll: true });
    // jsdom has no layout, and so no scrollIntoView.
    target?.scrollIntoView?.({ block: "nearest" });
    setJump(undefined);
  }, [jump]);
  const commitments = planningOutcomes(plan.tasks, plan.managedLabels).filter(
    (task) => task.stage === "committed",
  );
  const deadlines = (
    <DeadlineList
      tasks={plan.tasks}
      today={props.currentDate}
      language={language}
      busy={props.busy}
      run={props.run}
      actions={props.actions}
      canMarkActive={canMarkActive(plan)}
      open={props.deadlinesOpen}
      onToggle={(open) => props.onDeadlinesToggle?.(open)}
      editTask={editTask}
      chooseLead={props.chooseLead}
    />
  );
  const count = (area: Area) =>
    commitments.filter((task) => effectiveArea(task, plan.tasks) === area)
      .length;
  return (
    <section className="planning-view" ref={section}>
      <div className="planning-toolbar">
        <div
          className="planning-view-tabs"
          role="tablist"
          aria-label={language === "zh" ? "计划视图" : "Planning view"}
        >
          {(["review", "week"] as const).map((value) => (
            <button
              key={value}
              role="tab"
              aria-selected={mode === value}
              onClick={() => setMode(value)}
            >
              {language === "zh"
                ? value === "review"
                  ? "回顾"
                  : "一周安排"
                : value === "review"
                  ? "Review"
                  : "Week"}
            </button>
          ))}
        </div>
        <span>
          {count("work")}/5 {text.work.toLowerCase()} · {count("personal")}/3{" "}
          {text.personal.toLowerCase()}
        </span>
        <button
          ref={reviewButton}
          className="planning-label-button"
          aria-pressed={reviewing}
          onClick={() => setReviewing(!reviewing)}
        >
          {text.weeklyReview}
        </button>
        {onLabels && (
          <button className="planning-label-button" onClick={onLabels}>
            {text.boardLabels}
          </button>
        )}
      </div>
      {reviewing && (
        <WeeklyReview
          // Ticks belong to one week; a Monday rollover starts the next week's list.
          key={plan.week}
          plan={plan}
          days={props.days}
          today={props.currentDate}
          language={language}
          busy={props.busy}
          pending={props.pending}
          run={props.run}
          actions={props.actions}
          editTask={editTask}
          completeReview={props.completeReview}
          onShowWaiting={() => {
            setMode("review");
            setWaitingOpen(true);
            setJump("waiting");
          }}
          onShowRunway={() => {
            setMode("week");
            setJump("runway");
          }}
          onClose={() => {
            setReviewing(false);
            reviewButton.current?.focus();
          }}
        />
      )}
      {mode === "review" ? (
        <>
          <div
            className="planning-area-filter"
            role="tablist"
            aria-label={language === "zh" ? "事项范围" : "Outcome area"}
          >
            {(
              [
                "all",
                "work",
                "personal",
                ...(plan.tasks.some(
                  (task) =>
                    task.stage !== "none" &&
                    effectiveArea(task, plan.tasks) === "unassigned",
                )
                  ? ["unassigned"]
                  : []),
              ] as (Area | "all")[]
            ).map((value) => (
              <button
                key={value}
                role="tab"
                aria-selected={area === value}
                onClick={() => setArea(value)}
              >
                {value === "all"
                  ? language === "zh"
                    ? "全部"
                    : "All"
                  : text[value]}
              </button>
            ))}
          </div>
          <ReviewBoard {...props} area={area} />
          {/* Daily first: Deadlines above the weekly Waiting row. */}
          {deadlines}
          <WaitingList
            tasks={plan.tasks}
            today={props.currentDate}
            language={language}
            busy={props.busy}
            todayTaskIds={props.todayTaskIds}
            open={waitingOpen}
            onToggle={setWaitingOpen}
            editTask={editTask}
            addStep={props.addStep}
            addFocus={props.addFocus}
            onOpenTask={props.onOpenTask}
          />
        </>
      ) : (
        <>
          <PlanningWeek {...props} startAtUnplanned={jump === "runway"} />
          {deadlines}
        </>
      )}
      <p className="planning-reset-note">{text.reset}</p>
    </section>
  );
}
