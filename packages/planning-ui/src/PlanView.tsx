import { useEffect, useRef, useState } from "react";
import { effectiveArea } from "./domain";
import { committedOutcomes } from "./planning-outcomes";
import { boardLanes } from "./review-lanes";
import type { CompletePlanningTask } from "./CompleteTaskButton";
import { ReviewBoard } from "./ReviewBoard";
import { PlanningWeek } from "./PlanningWeek";
import { WeeklyReview } from "./WeeklyReview";
import { words } from "./i18n";
import {
  DEFAULT_PLAN_VIEW,
  type PlanViewPatch,
  type PlanViewState,
} from "./plan-view-state";
import type { ReviewProgress } from "./weekly-review";
import type {
  RunOperation,
  Area,
  DayPlan,
  FocusState,
  Language,
  PlanState,
  PlanningTask,
  PlusActions,
} from "./model";

export interface PlanViewProps {
  plan: PlanState;
  days: DayPlan[];
  /** Titles of queued tasks Plan's list leaves out, done steps among them. */
  focusTasks: FocusState["tasks"];
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
  completeReview: (task: PlanningTask) => Promise<boolean>;
  completeTask: CompletePlanningTask;
  /** Opens Tasks' own task dialog, where Week's done steps can be reopened. */
  onOpenTask?: (id: string) => void;
  /** The weekly review's mail line opens the host's Mail page. */
  onOpenMail?: () => void;
  /** The weekly review's GTD link opens the host's GTD page. */
  onOpenGtd?: () => void;
  /** Each new positive value opens the weekly review (the review task's link); a mount with one starts with it. */
  reviewing?: number;
  /** Opened from Focus's quiet line: Review, with Start now focused. */
  showStart?: boolean;
  onStartShown?: () => void;
  /** Plan's remembered view, read once when Plan mounts. */
  planView?: PlanViewState;
  /** Called with the fields of the view that changed, each time the owner changes one. */
  onPlanView?: (patch: PlanViewPatch) => void;
}
/**
 * Where a jump lands: a lane of the Review board, or else the first card there in that state
 * (its own stage lane keeps it); Week's Add steps input.
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
  addStep: [".planning-add-step-input"],
};
/** The remembered view as this week shows it: another week's review starts closed and empty. */
function seededView(stored: PlanViewState, week: string): PlanViewState {
  return stored.review.week === week
    ? stored
    : { ...stored, review: { week, open: false, lines: [], kept: [] } };
}
export function PlanView(props: PlanViewProps) {
  const { plan, language, editTask, onPlanView } = props;
  // Seeded once from the remembered view; the review link and the jumps below apply after it.
  const [seeded] = useState(() =>
    seededView(props.planView ?? DEFAULT_PLAN_VIEW, plan.week),
  );
  const [mode, setMode] = useState(seeded.tab);
  const [area, setArea] = useState(seeded.area);
  const [reviewing, setReviewing] = useState(
    seeded.review.open || Boolean(props.reviewing),
  );
  // The review's ticks and kept items, of the week they were made in.
  const [progress, setProgress] = useState({
    week: seeded.review.week,
    lines: seeded.review.lines,
    kept: seeded.review.kept,
  });
  // Week's selected commitment (absent: the first one) and its own area filter.
  const [commitment, setCommitment] = useState(seeded.commitment);
  const [weekArea, setWeekArea] = useState<Area | "all">("all");
  // Week's Committed folded to its heading line.
  const [folded, setFolded] = useState(seeded.committedFolded);
  // The commitment whose Add steps input is open (not remembered): when the selection changes
  // without the owner, say a re-read shows that commitment no longer committed, none is open.
  const [addingStep, setAddingStep] = useState<string>();
  // A jump focuses its target and scrolls it into view once.
  const [jump, setJump] = useState<keyof typeof JUMPS>();
  const section = useRef<HTMLElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const text = words(language);
  useEffect(() => {
    if (props.reviewing) setReviewing(true);
  }, [props.reviewing]);
  /** Another tab, or Week at another commitment, closes the Add steps input. */
  function showMode(next: "review" | "week") {
    setMode(next);
    setAddingStep(undefined);
  }
  function selectCommitment(id: string) {
    setCommitment(id);
    setAddingStep(undefined);
  }
  /** Review with every area shown, so the lane a jump looks for is on the board. */
  function showLane(lane: "start" | "waiting") {
    showMode("review");
    setArea("all");
    setJump(lane);
  }
  /**
   * Week at one commitment, unfolded with every area shown, so its card is in the grid, and its
   * Add steps input open.
   */
  function planSteps(id: string) {
    setMode("week");
    setWeekArea("all");
    setCommitment(id);
    setFolded(false);
    setAddingStep(id);
    setJump("addStep");
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
  const weekProgress: ReviewProgress =
    progress.week === plan.week
      ? { lines: progress.lines, kept: progress.kept }
      : { lines: [], kept: [] };
  // What the owner sees now; only the fields that differ from the last ones sent are stored.
  const view: PlanViewState = {
    tab: mode,
    area,
    review: { week: plan.week, open: reviewing, ...weekProgress },
    ...(commitment === undefined ? {} : { commitment }),
    committedFolded: folded,
  };
  const lastSent = useRef(seeded);
  // Compared by value: a re-render that shows the same view sends nothing.
  const viewKey = JSON.stringify(view);
  useEffect(() => {
    const sent = lastSent.current;
    const patch: PlanViewPatch = Object.fromEntries(
      Object.entries(view).filter(
        ([key, value]) =>
          JSON.stringify(value) !==
          JSON.stringify(sent[key as keyof PlanViewState]),
      ),
    );
    lastSent.current = view;
    if (Object.keys(patch).length) onPlanView?.(patch);
  }, [viewKey]);
  const lanes = boardLanes(plan, props.currentDate);
  const areas: (Area | "all")[] = [
    "all",
    "work",
    "personal",
    ...(Object.values(lanes).some((cards) =>
      cards.some((task) => effectiveArea(task, plan.tasks) === "unassigned"),
    )
      ? (["unassigned"] as const)
      : []),
  ];
  // A remembered area the filter no longer offers shows every area.
  const shownArea = areas.includes(area) ? area : "all";
  const commitments = committedOutcomes(plan);
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
              onClick={() => showMode(value)}
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
      </div>
      {reviewing && (
        <WeeklyReview
          // Ticks belong to one week; a Monday rollover starts the next week's list.
          key={plan.week}
          progress={weekProgress}
          onProgress={(next) => setProgress({ week: plan.week, ...next })}
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
          onOpenMail={props.onOpenMail}
          onOpenGtd={props.onOpenGtd}
          onShowWaiting={() => showLane("waiting")}
          onPlanSteps={planSteps}
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
            {areas.map((value) => (
              <button
                key={value}
                role="tab"
                aria-selected={shownArea === value}
                // Work and Personal carry the cards' edge colour as a dot: the legend.
                data-area={
                  value === "work" || value === "personal" ? value : undefined
                }
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
          <ReviewBoard {...props} lanes={lanes} area={shownArea} />
        </>
      ) : (
        <PlanningWeek
          {...props}
          selectedId={commitment}
          onSelect={selectCommitment}
          area={weekArea}
          onArea={setWeekArea}
          folded={folded}
          onFold={setFolded}
          addingStep={addingStep}
          onAddingStep={setAddingStep}
        />
      )}
      <p className="planning-reset-note">{text.reset}</p>
    </section>
  );
}
