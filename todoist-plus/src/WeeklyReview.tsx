import { useEffect, useRef, useState, type ReactNode } from "react";
import { ListChecks, X } from "lucide-react";
import { useAnnouncement } from "./announce";
import { BET_AREAS, saveBet, weeklyBet } from "./bets";
import { BetText } from "./BetText";
import { addDays, displayedTitle, taskIndex } from "./domain";
import { deadlineStatus } from "./deadlines";
import { waitingTasks } from "./dependencies";
import { betWords, words } from "./i18n";
import { pendingTask } from "./plan-updates";
import { LeadSelect } from "./TaskEditor";
import { weekLabel } from "./PlanningCalendar";
import {
  inboxToClarify,
  isLastDay,
  isoWeek,
  oldestUntouched,
  readProgress,
  saveProgress,
  SOMEDAY_LABELS,
  unscheduledCommitments,
  untouchedDays,
  untouchedText,
  weekChoices,
  withoutLead,
  type ReviewProgress,
} from "./weekly-review";
import type {
  FlowDayPlan,
  Language,
  PlanState,
  PlanningTask,
  PlusActions,
  RunOperation,
} from "./model";

/** Someday items shown at once; keeping or moving one brings the next. */
const SOMEDAY_SHOWN = 10;

interface Props {
  plan: PlanState;
  days: FlowDayPlan[];
  /** The account's today, which says whether this is the week's last day. */
  today: string;
  language: Language;
  busy: boolean;
  pending?: ReadonlySet<string>;
  run: RunOperation;
  actions: PlusActions;
  editTask: (task: PlanningTask) => void;
  onShowWaiting: () => void;
  /** Week at this commitment, the first with nothing planned. */
  onPlanSteps: (commitmentId: string) => void;
  completeReview: (task: PlanningTask) => Promise<boolean>;
  /** Opens Plus's Mailbox, which lists the mail of line 1. */
  onOpenMailbox?: () => void;
  onClose: () => void;
}

/**
 * Five weekly review lines with counts and jump targets, and a sixth while deadlines lack a
 * start-ahead choice. It only guides: every write is one of the owner's existing single-task
 * actions, made when clicked, or on Sunday next week's two Bets. Ticks are kept per ISO week in
 * this browser.
 */
export function WeeklyReview({
  plan,
  days,
  today,
  language,
  busy,
  pending,
  run,
  actions,
  editTask,
  onShowWaiting,
  onPlanSteps,
  completeReview,
  onOpenMailbox,
  onClose,
}: Props) {
  const text = words(language);
  const zh = language === "zh";
  const week = isoWeek(plan.week);
  const [progress, setProgress] = useState<ReviewProgress>(() =>
    readProgress(week),
  );
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
  function update(next: ReviewProgress) {
    setProgress(next);
    saveProgress(week, next);
  }
  const waits = (task: PlanningTask) =>
    busy || (pending?.has(pendingTask(task.id)) ?? false);

  const inbox = inboxToClarify(plan);
  const waiting = waitingTasks(plan);
  const oldestWait = waiting[0] && untouchedDays(waiting[0]);
  const noLead = withoutLead(plan.tasks);
  const unscheduled = unscheduledCommitments(plan, days);
  // Still to look at this week: neither kept nor already in this month.
  const someday = oldestUntouched(plan.tasks, SOMEDAY_LABELS).filter(
    (task) => task.stage !== "monthly" && !progress.kept.includes(task.id),
  );
  const sunday = isLastDay(plan.week, today);
  const nextWeek = addDays(plan.week, 7);
  const chosen = new Set(plan.nextWeekTaskIds);
  const commitments = sunday ? weekChoices(plan) : [];
  const toKeep = commitments.filter((task) => !chosen.has(task.id));
  const reviewTask = plan.reviewTaskId
    ? taskIndex(plan.tasks).get(plan.reviewTaskId)
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
            update({
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
          plan.inboxProjectId ? (
            <>
              <span className="weekly-review-count">{inbox.length}</span>
              <button className="weekly-review-jump" onClick={onOpenMailbox}>
                {zh ? "打开" : "Open"}
              </button>
            </>
          ) : (
            <span className="weekly-review-note">
              {zh ? "Todofy 没有设置邮件项目" : "Todofy has no mail project"}
            </span>
          ),
        )}
        {line(
          2,
          text.waiting,
          <>
            <span className="weekly-review-count">{waiting.length}</span>
            {oldestWait !== undefined && (
              <span className="weekly-review-note">
                {zh
                  ? `最久 ${oldestWait} 天未变动`
                  : `oldest untouched ${oldestWait} days`}
              </span>
            )}
            {waiting.length > 0 && (
              <button className="weekly-review-jump" onClick={onShowWaiting}>
                {zh ? "查看" : "Show"}
              </button>
            )}
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
                          if (
                            await run(() =>
                              actions.updateTask(task, { stage: "monthly" }),
                            )
                          )
                            done(4, index, `${moved}: ${title}`);
                        }}
                      >
                        {move}
                      </button>
                      <button
                        data-review-action
                        aria-label={`${keep}: ${title}`}
                        onClick={() => {
                          update({
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
        {sunday ? (
          line(
            5,
            zh ? "下周承诺与目标" : "Next week's commitments and goals",
            <>
              <span className="weekly-review-note">{text.sundayRule}</span>
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
                              // Sends the commitment again; for a stage the task already shows,
                              // Todofy changes no label.
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
              {/* Next week's Bets, written here only: Monday's "Keep" is the one way to carry one on. */}
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
                  </li>
                ))}
              </ul>
            </>,
          )
        ) : (
          // Nothing to tick before Sunday: only where the choice will be.
          <li className="weekly-review-later">
            <div className="weekly-review-line">
              <strong>
                {zh ? "下周承诺与目标" : "Next week's commitments and goals"}
              </strong>
              <span className="weekly-review-note">
                {zh
                  ? "周日可在这里选留到下周的承诺，并写下周目标"
                  : "On Sunday, choose commitments to keep and write next week's goals here"}
              </span>
            </div>
          </li>
        )}
      </ol>
      <p className="plus-sr-only" role="status">
        {announcement}
      </p>
      <footer>
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
            {plan.reviewTaskId
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
