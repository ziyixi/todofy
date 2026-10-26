import { useEffect, useRef, useState, type ReactNode } from "react";
import { ListChecks, X } from "lucide-react";
import { useAnnouncement } from "./announce";
import { BET_AREAS, saveBet, weeklyBet } from "./bets";
import { BetText } from "./BetText";
import { BetGoal } from "./BetGoal";
import { addDays, displayedTitle, hasPlanningFlag, taskIndex } from "./domain";
import { deadlineStatus } from "./deadlines";
import { planVisibility } from "./plan-visibility";
import { betWords, words } from "./i18n";
import { pendingTask } from "./plan-updates";
import { PARKED_LABEL } from "./planning-outcomes";
import { LeadSelect } from "./TaskEditor";
import { weekLabel } from "./PlanningCalendar";
import {
  isLastDay,
  oldestUntouched,
  SOMEDAY_LABELS,
  unscheduledCommitments,
  untouchedText,
  weekChoices,
  withoutLead,
  type ReviewProgress,
} from "./weekly-review";
import type {
  DayPlan,
  Language,
  PlanState,
  PlanningTask,
  PlusActions,
  RunOperation,
  RenderGoalPicker,
  WeeklyReviewFacts,
} from "./model";

/** Someday items shown at once; keeping or moving one brings the next. */
const SOMEDAY_SHOWN = 10;

interface Props {
  plan: PlanState;
  days: DayPlan[];
  /** The account's today, which says whether this is the week's last day. */
  today: string;
  language: Language;
  busy: boolean;
  pending?: ReadonlySet<string>;
  run: RunOperation;
  actions: PlusActions;
  renderGoalPicker?: RenderGoalPicker;
  editTask: (task: PlanningTask) => void;
  /** This week's ticked lines and kept someday tasks, which PlanView remembers. */
  progress: ReviewProgress;
  onProgress: (progress: ReviewProgress) => void;
  /** Week at this commitment, the first with nothing planned, with its Add steps input open. */
  onPlanSteps: (commitmentId: string) => void;
  completeReview: (task: PlanningTask) => Promise<boolean>;
  /** Opens the host's Mail page, which lists the mail of line 1. */
  onOpenMail?: () => void;
  /** Opens the host's GTD page, the trend of the Inbox and the open tasks. */
  onOpenGtd?: () => void;
  onClose: () => void;
}

/**
 * Four weekly review lines with counts and jump targets, and another while deadlines lack a
 * start-ahead choice. It only guides: every write is one of the owner's existing single-task
 * actions, made when clicked, or on Saturday next week's two Bets.
 */
export function WeeklyReview({
  plan: completePlan,
  days,
  today,
  language,
  busy,
  pending,
  run,
  actions,
  renderGoalPicker,
  editTask,
  progress,
  onProgress,
  onPlanSteps,
  completeReview,
  onOpenMail,
  onOpenGtd,
  onClose,
}: Props) {
  const plan = { ...completePlan, tasks: planVisibility(completePlan).tasks };
  const text = words(language);
  const zh = language === "zh";
  const [reviewDone, setReviewDone] = useState(false);
  // The two item lists stay folded until asked for.
  const [shown, setShown] = useState<ReadonlySet<number>>(new Set());
  // What the last action did, read out by screen readers.
  const [announcement, setAnnouncement] = useAnnouncement();
  // After an item's action, focus goes to the action now at the same place in that line's list,
  // or to the line itself once none is left, instead of falling back to the page.
  const [focusAt, setFocusAt] = useState<{ line: number; index: number }>();
  const section = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const waits = (task: PlanningTask) =>
    busy || (pending?.has(pendingTask(task.id)) ?? false);

  const noLead = withoutLead(plan.tasks);
  const unscheduled = unscheduledCommitments(plan, days);
  // Still to look at this week: neither kept nor already in this month.
  const someday = oldestUntouched(plan.tasks, SOMEDAY_LABELS).filter(
    (task) => task.stage !== "monthly" && !progress.kept.includes(task.id),
  );
  const saturday = isLastDay(plan.week, today);
  const nextWeek = addDays(plan.week, 7);
  const chosen = new Set(plan.nextWeekTaskIds);
  const commitments = saturday ? weekChoices(plan) : [];
  const toKeep = commitments.filter((task) => !chosen.has(task.id));
  // The review task Tasks created and the mail still pending in Todofy, read from Tasks when it opens.
  const [facts, setFacts] = useState<WeeklyReviewFacts>();
  useEffect(() => {
    let current = true;
    actions.readWeeklyReview?.(plan.week).then(
      (read) => {
        if (current) setFacts(read);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [actions, plan.week]);
  const reviewTask = facts?.reviewTaskId
    ? taskIndex(plan.tasks).get(facts.reviewTaskId)
    : undefined;

  useEffect(() => {
    const review = section.current;
    if (!focusAt || !review) return;
    // Only where focus was lost or is still in the review; never pulled back from elsewhere.
    const active = (review.getRootNode() as Document | ShadowRoot)
      .activeElement;
    if (active && active !== document.body && !review.contains(active)) {
      setFocusAt(undefined);
      return;
    }
    const row = review.querySelector(`[data-review-line="${focusAt.line}"]`);
    // An item's own action, or its start-ahead select.
    const items = [
      ...(row?.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(
        "[data-review-action], .plus-lead-select",
      ) ?? []),
    ];
    const target =
      items[Math.min(focusAt.index, items.length - 1)] ??
      row?.querySelector<HTMLElement>(".weekly-review-jump") ??
      row?.querySelector<HTMLElement>("input") ??
      // A line with nothing left to do is gone.
      heading.current;
    // A running write disables the actions: focus moves once it settles.
    if (
      (target instanceof HTMLButtonElement ||
        target instanceof HTMLSelectElement) &&
      target.disabled
    )
      return;
    target?.focus();
    setFocusAt(undefined);
  }, [focusAt, busy, plan, progress]);
  /** Says what an item's action did and moves focus on in its list. */
  function done(line: number, index: number, message: string) {
    setAnnouncement(message);
    setFocusAt({ line, index });
  }

  function toggle(index: number, label: string) {
    const open = shown.has(index);
    return (
      <button
        className="weekly-review-jump"
        aria-expanded={open}
        onClick={() =>
          setShown((lines) => {
            const next = new Set(lines);
            if (open) next.delete(index);
            else next.add(index);
            return next;
          })
        }
      >
        {open ? (zh ? "收起" : "Hide") : label}
      </button>
    );
  }

  function line(index: number, title: string, body: ReactNode) {
    const ticked = progress.lines.includes(index);
    return (
      <li className={ticked ? "is-ticked" : ""} data-review-line={index}>
        <input
          type="checkbox"
          checked={ticked}
          aria-label={`${zh ? "已看完" : "Reviewed"}: ${title}`}
          onChange={() =>
            onProgress({
              ...progress,
              lines: ticked
                ? progress.lines.filter((value) => value !== index)
                : [...progress.lines, index],
            })
          }
        />
        <div className="weekly-review-line">
          <strong>{title}</strong>
          {body}
        </div>
      </li>
    );
  }

  return (
    <section
      className="weekly-review"
      aria-label={text.weeklyReview}
      ref={section}
    >
      <header>
        <h2 ref={heading} tabIndex={-1}>
          <ListChecks size={15} />
          {text.weeklyReview}
        </h2>
        <span>{weekLabel(plan.week, language)}</span>
        <button className="plus-icon" aria-label={text.close} onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <ol>
        {line(
          1,
          zh ? "邮件待理清" : "Mail to clarify",
          <>
            <span className="weekly-review-count">
              {facts?.mailboxPendingCount ?? "—"}
            </span>
            <button className="weekly-review-jump" onClick={onOpenMail}>
              {zh ? "打开" : "Open"}
            </button>
          </>,
        )}
        {/* Line 6, kept apart from the stored numbers 1-5: only while a deadline has no lead. */}
        {noLead.length > 0 &&
          line(
            6,
            zh
              ? `${noLead.length} 项截止还没设提前量`
              : `${noLead.length} ${noLead.length === 1 ? "deadline has" : "deadlines have"} no start-ahead set`,
            <>
              {toggle(6, zh ? "查看" : "Show")}
              {shown.has(6) && (
                <ul
                  className="weekly-review-items"
                  aria-label={zh ? "截止还没设提前量" : "No start-ahead set"}
                >
                  {noLead.map((task, index) => {
                    const title = displayedTitle(task.title);
                    const deadline = deadlineStatus(task, today, language)!;
                    return (
                      <li key={task.id}>
                        <button
                          className="weekly-review-title"
                          onClick={() => editTask(task)}
                        >
                          {title}
                        </button>
                        <span>
                          {deadline.text}
                          {deadline.danger && (
                            <span className="planning-danger-text">
                              {deadline.danger}
                            </span>
                          )}
                        </span>
                        {/* Choosing writes the lead at once, as the editor's estimate does. */}
                        <LeadSelect
                          value={task.leadDays}
                          language={language}
                          disabled={waits(task)}
                          label={`${text.lead}: ${title}`}
                          onChange={async (days) => {
                            if (
                              await run(() =>
                                actions.updateLead(task, task.deadline, days),
                              )
                            )
                              done(
                                6,
                                index,
                                `${zh ? "已设提前量" : "Start ahead set"}: ${title}`,
                              );
                          }}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </>,
          )}
        {line(
          3,
          zh ? "承诺未安排" : "Commitments not planned",
          <>
            <span className="weekly-review-count">{unscheduled.length}</span>
            {unscheduled.length > 0 && (
              <button
                className="weekly-review-jump"
                onClick={() => onPlanSteps(unscheduled[0]!.id)}
              >
                {zh ? "去安排" : "Plan steps"}
              </button>
            )}
          </>,
        )}
        {line(
          4,
          zh ? "将来 / 也许" : "Someday",
          <>
            <span className="weekly-review-count">{someday.length}</span>
            {someday.length > 0 && toggle(4, zh ? "查看" : "Show")}
            {shown.has(4) && (
              <ul
                className="weekly-review-items"
                aria-label={zh ? "将来 / 也许" : "Someday"}
              >
                {someday.slice(0, SOMEDAY_SHOWN).map((task, index) => {
                  const title = displayedTitle(task.title);
                  const move = zh ? "移到本月" : "Move to this month";
                  const moved = zh ? "已移到本月" : "Moved to this month";
                  const keep = zh ? "保留" : "Keep";
                  return (
                    <li key={task.id}>
                      <button
                        className="weekly-review-title"
                        onClick={() => editTask(task)}
                      >
                        {title}
                      </button>
                      <span>{untouchedText(task, language)}</span>
                      <button
                        disabled={waits(task)}
                        aria-label={`${move}: ${title}`}
                        onClick={async () => {
                          // Into this month takes a parked task out of Parked too.
                          const update = hasPlanningFlag(task, PARKED_LABEL)
                            ? { stage: "monthly" as const, parked: false }
                            : { stage: "monthly" as const };
                          if (await run(() => actions.updateTask(task, update)))
                            done(4, index, `${moved}: ${title}`);
                        }}
                      >
                        {move}
                      </button>
                      <button
                        data-review-action
                        aria-label={`${keep}: ${title}`}
                        onClick={() => {
                          onProgress({
                            ...progress,
                            kept: [...progress.kept, task.id],
                          });
                          done(4, index, `${zh ? "已保留" : "Kept"}: ${title}`);
                        }}
                      >
                        {keep}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>,
        )}
        {saturday ? (
          line(
            5,
            zh ? "下周承诺与目标" : "Next week's commitments and goals",
            <>
              <span className="weekly-review-note">{text.saturdayRule}</span>
              {commitments.length > 0 &&
                toggle(
                  5,
                  zh
                    ? `选要留到下周的承诺（${toKeep.length}）`
                    : `Choose commitments to keep (${toKeep.length})`,
                )}
              {shown.has(5) && (
                <ul
                  className="weekly-review-items"
                  aria-label={zh ? "下周承诺" : "Next week's commitments"}
                >
                  {commitments.map((task) => {
                    const title = displayedTitle(task.title);
                    const keep = zh ? "留到下周" : "Keep for next week";
                    const kept = zh ? "已留到下周" : "Kept for next week";
                    return (
                      <li key={task.id}>
                        <span>{title}</span>
                        {chosen.has(task.id) ? (
                          <span>{kept}</span>
                        ) : (
                          <button
                            data-review-action
                            disabled={waits(task)}
                            aria-label={`${keep}: ${title}`}
                            onClick={async () => {
                              const index = toKeep.indexOf(task);
                              // Sends the commitment again, which on Saturday keeps it for next week.
                              if (
                                await run(() =>
                                  actions.updateTask(task, {
                                    stage: "committed",
                                  }),
                                )
                              )
                                done(5, index, `${kept}: ${title}`);
                            }}
                          >
                            {keep}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {/* Next week's Bets, written here only: Sunday's "Keep" is the one way to carry one on. */}
              <ul
                className="weekly-review-items weekly-review-bets"
                aria-label={zh ? "下周目标" : "Next week's goals"}
              >
                {BET_AREAS.map((area) => (
                  <li key={area}>
                    <span className="weekly-review-bet-area">{text[area]}</span>
                    <BetText
                      bet={weeklyBet(plan.weeklyBets, nextWeek, area)}
                      copy={betWords(language, area, "next")}
                      language={language}
                      disabled={busy}
                      save={(bet) => saveBet(run, actions, bet)}
                      announce={setAnnouncement}
                    />
                    <BetGoal
                      bet={weeklyBet(plan.weeklyBets, nextWeek, area)}
                      language={language}
                      disabled={busy}
                      renderGoalPicker={renderGoalPicker}
                      run={run}
                      actions={actions}
                    />
                  </li>
                ))}
              </ul>
            </>,
          )
        ) : (
          // Nothing to tick before Saturday: only where the choice will be.
          <li className="weekly-review-later">
            <div className="weekly-review-line">
              <strong>
                {zh ? "下周承诺与目标" : "Next week's commitments and goals"}
              </strong>
              <span className="weekly-review-note">
                {zh
                  ? "周六可在这里选留到下周的承诺，并写下周目标"
                  : "On Saturday, choose commitments to keep and write next week's goals here"}
              </span>
            </div>
          </li>
        )}
      </ol>
      <p className="plus-sr-only" role="status">
        {announcement}
      </p>
      <footer>
        {onOpenGtd && (
          <button className="weekly-review-jump" onClick={onOpenGtd}>
            {zh ? "GTD 趋势" : "GTD trends"}
          </button>
        )}
        {reviewTask && !reviewDone ? (
          <button
            className="plus-button plus-primary"
            disabled={waits(reviewTask)}
            onClick={async () => {
              if (!(await completeReview(reviewTask))) return;
              setReviewDone(true);
              setAnnouncement(zh ? "回顾任务已完成" : "Review task completed");
              heading.current?.focus();
            }}
          >
            {zh ? "完成回顾" : "Finish review"}
          </button>
        ) : (
          <span className="weekly-review-note">
            {facts?.reviewTaskId
              ? zh
                ? "回顾任务已完成"
                : "Review task completed"
              : zh
                ? "还没有回顾任务"
                : "No review task yet"}
          </span>
        )}
      </footer>
    </section>
  );
}
