import { useState, type ReactNode } from "react";
import { ExternalLink, ListChecks, X } from "lucide-react";
import { displayedTitle, taskIndex, todoistProjectUrl } from "./domain";
import { words } from "./i18n";
import { pendingTask } from "./plan-updates";
import { untouchedText } from "./WaitingList";
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
  WAITING_LABELS,
  weekChoices,
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
  onShowRunway: () => void;
  completeReview: (task: PlanningTask) => Promise<boolean>;
  onClose: () => void;
}

/**
 * Five weekly review lines with counts and jump targets. It only guides: every write is one of
 * the owner's existing single-task actions, made when clicked. Ticks are kept per ISO week in
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
  onShowRunway,
  completeReview,
  onClose,
}: Props) {
  const text = words(language);
  const zh = language === "zh";
  const week = isoWeek(plan.week);
  const [progress, setProgress] = useState<ReviewProgress>(() =>
    readProgress(week),
  );
  // Choices kept in this visit, until the next read lists them among next week's.
  const [keptNext, setKeptNext] = useState<ReadonlySet<string>>(new Set());
  const [reviewDone, setReviewDone] = useState(false);
  // The two item lists stay folded until asked for.
  const [shown, setShown] = useState<ReadonlySet<number>>(new Set());
  function update(next: ReviewProgress) {
    setProgress(next);
    saveProgress(week, next);
  }
  const waits = (task: PlanningTask) =>
    busy || (pending?.has(pendingTask(task.id)) ?? false);

  const inbox = inboxToClarify(plan);
  const waiting = oldestUntouched(plan.tasks, WAITING_LABELS);
  const oldestWait = waiting[0] && untouchedDays(waiting[0]);
  const unscheduled = unscheduledCommitments(plan, days);
  const someday = oldestUntouched(plan.tasks, SOMEDAY_LABELS).filter(
    (task) => !progress.kept.includes(task.id),
  );
  const sunday = isLastDay(plan.week, today);
  const chosen = new Set([...plan.nextWeekTaskIds, ...keptNext]);
  const commitments = sunday ? weekChoices(plan) : [];
  const toKeep = commitments.filter((task) => !chosen.has(task.id));
  const reviewTask = plan.reviewTaskId
    ? taskIndex(plan.tasks).get(plan.reviewTaskId)
    : undefined;

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
      <li className={ticked ? "is-ticked" : ""}>
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
    <section className="weekly-review" aria-label={text.weeklyReview}>
      <header>
        <h2>
          <ListChecks size={15} />
          {text.weeklyReview}
        </h2>
        <span>{week}</span>
        <button className="plus-icon" aria-label={text.close} onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <ol>
        {line(
          1,
          zh ? "收件箱待理清" : "Inbox to clarify",
          plan.inboxProjectId ? (
            <>
              <span className="weekly-review-count">{inbox.length}</span>
              <a
                className="weekly-review-jump"
                href={todoistProjectUrl(plan.inboxProjectId)}
              >
                {text.open}
                <ExternalLink size={12} />
              </a>
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
        {line(
          3,
          zh ? "承诺无排期" : "Commitments not planned",
          <>
            <span className="weekly-review-count">{unscheduled.length}</span>
            {unscheduled.length > 0 && (
              <button className="weekly-review-jump" onClick={onShowRunway}>
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
                {someday.slice(0, SOMEDAY_SHOWN).map((task) => (
                  <li key={task.id}>
                    <button
                      className="weekly-review-title"
                      onClick={() => editTask(task)}
                    >
                      {displayedTitle(task.title)}
                    </button>
                    <span>{untouchedText(task, language)}</span>
                    {task.stage === "monthly" ? (
                      <span>{zh ? "已在本月" : "In this month"}</span>
                    ) : (
                      <button
                        disabled={waits(task)}
                        onClick={() =>
                          void run(() =>
                            actions.updateTask(task, { stage: "monthly" }),
                          )
                        }
                      >
                        {zh ? "移到本月" : "Move to this month"}
                      </button>
                    )}
                    <button
                      onClick={() =>
                        update({
                          ...progress,
                          kept: [...progress.kept, task.id],
                        })
                      }
                    >
                      {zh ? "保留" : "Keep"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>,
        )}
        {line(
          5,
          zh ? "下周承诺" : "Next week's commitments",
          <>
            <span className="weekly-review-note">{text.sundayRule}</span>
            {commitments.length > 0 &&
              toggle(
                5,
                zh
                  ? `选择留下的（${toKeep.length}）`
                  : `Choose what stays (${toKeep.length})`,
              )}
            {shown.has(5) && (
              <ul
                className="weekly-review-items"
                aria-label={zh ? "下周承诺" : "Next week's commitments"}
              >
                {commitments.map((task) => (
                  <li key={task.id}>
                    <span>{displayedTitle(task.title)}</span>
                    {chosen.has(task.id) ? (
                      <span>{zh ? "已留到下周" : "Kept for next week"}</span>
                    ) : (
                      <button
                        disabled={waits(task)}
                        onClick={async () => {
                          const kept = await run(() =>
                            actions.updateTask(
                              task,
                              task.stage === "committed"
                                ? { stage: "committed" }
                                : { bet: true },
                            ),
                          );
                          if (kept)
                            setKeptNext((ids) => new Set(ids).add(task.id));
                        }}
                      >
                        {zh ? "留到下周" : "Keep for next week"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>,
        )}
      </ol>
      <footer>
        {reviewTask && !reviewDone ? (
          <button
            className="plus-button plus-primary"
            disabled={waits(reviewTask)}
            onClick={async () => {
              if (await completeReview(reviewTask)) setReviewDone(true);
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
