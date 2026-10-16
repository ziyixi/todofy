import { useEffect, useRef, useState } from "react";
import { effectiveArea } from "./domain";
import { planningOutcomes } from "./planning-outcomes";
import { boardLanes } from "./review-lanes";
import { ReviewBoard } from "./ReviewBoard";
import { PlanningWeek } from "./PlanningWeek";
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
  completeReview: (task: PlanningTask) => Promise<boolean>;
  /** Opened from the review task's link: start with the weekly review. */
  reviewing?: boolean;
  /** Opened from Focus's quiet line: Review, with Start now focused. */
  showStart?: boolean;
  onStartShown?: () => void;
}
/**
 * Where a jump lands: a lane of the Review board, or else the first card there in that state
 * (its own stage lane keeps it); Week's runway line.
 */
const JUMPS = {
  start: [
    '.review-lane[data-lane="start"]',
    '.review-draggable[data-state="start"] .planning-outcome-card',
  ],
  waiting: [
    '.review-lane[data-lane="waiting"]',
    '.review-draggable[data-state="waiting"] .planning-outcome-card',
  ],
  runway: [".planning-runway"],
};
export function PlanView(props: PlanViewProps) {
  const { plan, language, editTask, onLabels } = props;
  const [mode, setMode] = useState<"review" | "week">("review");
  const [area, setArea] = useState<Area | "all">("all");
  const [reviewing, setReviewing] = useState(Boolean(props.reviewing));
  // A jump focuses its target and scrolls it into view once; Week mounts at the first unplanned
  // commitment.
  const [jump, setJump] = useState<keyof typeof JUMPS>();
  const section = useRef<HTMLElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const text = words(language);
  useEffect(() => {
    if (props.reviewing) setReviewing(true);
  }, [props.reviewing]);
  /** Review with every area shown, so the lane a jump looks for is on the board. */
  function showLane(lane: "start" | "waiting") {
    setMode("review");
    setArea("all");
    setJump(lane);
  }
  const { showStart, onStartShown } = props;
  useEffect(() => {
    if (!showStart) return;
    showLane("start");
    onStartShown?.();
  }, [showStart, onStartShown]);
  useEffect(() => {
    if (!jump) return;
    const target = JUMPS[jump]
      .map((selector) => section.current?.querySelector<HTMLElement>(selector))
      .find(Boolean);
    target?.focus({ preventScroll: true });
    // jsdom has no layout, and so no scrollIntoView.
    target?.scrollIntoView?.({ block: "nearest" });
    setJump(undefined);
  }, [jump]);
  const lanes = boardLanes(plan, props.currentDate);
  const commitments = planningOutcomes(plan.tasks, plan.managedLabels).filter(
    (task) => task.stage === "committed",
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
          onShowWaiting={() => showLane("waiting")}
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
                ...(Object.values(lanes).some((cards) =>
                  cards.some(
                    (task) => effectiveArea(task, plan.tasks) === "unassigned",
                  ),
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
          <ReviewBoard {...props} lanes={lanes} area={area} />
        </>
      ) : (
        <PlanningWeek {...props} startAtUnplanned={jump === "runway"} />
      )}
      <p className="planning-reset-note">{text.reset}</p>
    </section>
  );
}
