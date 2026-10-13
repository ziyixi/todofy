import {
  ChevronDown,
  ChevronRight,
  Flag,
  MoreHorizontal,
  Plus,
  Star,
} from "lucide-react";
import { useState } from "react";
import {
  displayedTitle,
  effectiveArea,
  topLevelChoices,
  topLevelBets,
} from "./domain";
import { words } from "./i18n";
import type {
  Area,
  Language,
  PlanState,
  PlanningTask,
  PlusActions,
} from "./model";

interface Props {
  plan: PlanState;
  language: Language;
  busy: boolean;
  run: (operation: () => Promise<void>) => Promise<boolean>;
  actions: PlusActions;
  editTask: (task: PlanningTask) => void;
  addFocus: (id: string) => void;
}
export function PlanView({
  plan,
  language,
  busy,
  run,
  actions,
  editTask,
  addFocus,
}: Props) {
  const [area, setArea] = useState<Area>("work");
  const [monthlyOpen, setMonthlyOpen] = useState(false);
  const [attentionOpen, setAttentionOpen] = useState(true);
  const text = words(language);
  const tasks = topLevelChoices(plan.tasks, area);
  const committed = tasks.filter((task) => task.stage === "committed");
  const bets = topLevelBets(plan.tasks, area);
  const attention = plan.tasks.filter(
    (task) =>
      effectiveArea(task, plan.tasks) === area &&
      (task.mustStart || task.missingLead),
  );
  const limit = area === "work" ? 5 : area === "personal" ? 3 : undefined;
  const selected = tasks.filter((task) => task.stage === "weekly");
  const candidateTotal = (["work", "personal", "unassigned"] as const)
    .flatMap((value) => topLevelChoices(plan.tasks, value))
    .filter((task) => task.stage === "weekly").length;

  function row(task: PlanningTask) {
    const childCount = plan.tasks.filter(
      (child) => child.parentId === task.id,
    ).length;
    return (
      <li key={task.id} className="plus-plan-row">
        <button
          className={`plus-bet-toggle ${task.bet ? "active" : ""}`}
          aria-label={`${task.bet ? text.unbet : text.bet}: ${displayedTitle(task.title)}`}
          disabled={busy}
          onClick={() =>
            void run(() => actions.updateTask(task, { bet: !task.bet }))
          }
        >
          <Star size={17} fill={task.bet ? "currentColor" : "none"} />
        </button>
        <button className="plus-task-main" onClick={() => editTask(task)}>
          <span>{displayedTitle(task.title)}</span>
          <small>
            {childCount
              ? `${childCount} ${text.steps.toLowerCase()}`
              : task.estimatedMinutes
                ? `${task.estimatedMinutes} ${text.minutes}`
                : ""}
            {task.deadline && (
              <span className={task.mustStart ? "plus-warning" : ""}>
                {" "}
                · {text.deadline} {task.deadline}
              </span>
            )}
          </small>
        </button>
        <div className="plus-row-actions">
          <select
            aria-label={`${text.mode}: ${displayedTitle(task.title)}`}
            value={task.stage}
            disabled={busy}
            onChange={(event) =>
              void run(() =>
                actions.updateTask(task, {
                  stage: event.target.value as PlanningTask["stage"],
                }),
              )
            }
          >
            {(["none", "monthly", "weekly", "committed"] as const).map(
              (stage) => (
                <option key={stage} value={stage}>
                  {text[stage]}
                </option>
              ),
            )}
          </select>
          <button
            className="plus-icon"
            aria-label={`${childCount ? text.chooseStep : text.addFocus}: ${displayedTitle(task.title)}`}
            title={childCount ? text.chooseStep : text.addFocus}
            disabled={busy}
            onClick={() => (childCount ? editTask(task) : addFocus(task.id))}
          >
            <Plus size={17} />
          </button>
          <button
            className="plus-icon"
            aria-label={`${text.details}: ${displayedTitle(task.title)}`}
            onClick={() => editTask(task)}
          >
            <MoreHorizontal size={18} />
          </button>
        </div>
      </li>
    );
  }

  return (
    <>
      <div
        className="plus-tabs"
        role="tablist"
        aria-label={text.work + "/" + text.personal}
      >
        {(
          [
            "work",
            "personal",
            ...(plan.tasks.some(
              (task) =>
                effectiveArea(task, plan.tasks) === "unassigned" &&
                (task.stage !== "none" ||
                  task.bet ||
                  task.mustStart ||
                  task.missingLead),
            )
              ? ["unassigned"]
              : []),
          ] as Area[]
        ).map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={area === value}
            onClick={() => setArea(value)}
          >
            {text[value]}
          </button>
        ))}
      </div>
      {area === "unassigned" && <p className="plus-muted">{text.assignArea}</p>}
      <div className="plus-bets">
        <Star size={16} />
        <strong>{text.bets}</strong>
        <span
          className={
            area !== "unassigned" && bets.length > 1
              ? "plus-warning"
              : "plus-muted"
          }
        >
          {bets.length}
          {area !== "unassigned" && " / 1"}
        </span>
        <span className="plus-bet-titles">
          {bets.length ? (
            bets.map((task) => (
              <button key={task.id} onClick={() => editTask(task)}>
                {displayedTitle(task.title)}
              </button>
            ))
          ) : (
            <span className="plus-muted">
              {language === "zh"
                ? "本周最想推进的一件事"
                : "One thing to move forward this week"}
            </span>
          )}
        </span>
      </div>
      {area !== "unassigned" && bets.length > 1 && (
        <p className="plus-warning">{text.softLimit}</p>
      )}
      {attention.length > 0 && (
        <section className="plus-attention">
          <button
            className="plus-disclosure"
            onClick={() => setAttentionOpen(!attentionOpen)}
            aria-expanded={attentionOpen}
          >
            {attentionOpen ? (
              <ChevronDown size={15} />
            ) : (
              <ChevronRight size={15} />
            )}
            <Flag size={14} />
            {text.attention}
            <span>{attention.length}</span>
          </button>
          {attentionOpen && (
            <ul>
              {attention.map((task) => (
                <li key={task.id}>
                  <button onClick={() => editTask(task)}>
                    {displayedTitle(task.title)}
                  </button>
                  <span>
                    {task.mustStart ? text.mustStart : text.missingLead}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <section>
        <div className="plus-section-title">
          <h2>{text.committed}</h2>
          <span
            className={
              limit !== undefined && committed.length > limit
                ? "plus-warning"
                : ""
            }
          >
            {committed.length}
            {limit !== undefined && ` / ${limit}`}
          </span>
        </div>
        {limit !== undefined && committed.length > limit && (
          <p className="plus-warning">{text.softLimit}</p>
        )}
        <ul className="plus-task-list">{committed.map(row)}</ul>
        {!committed.length && <p className="plus-empty">{text.noTasks}</p>}
      </section>
      <section>
        <div className="plus-section-title">
          <h2>{text.weekly}</h2>
          <span className={candidateTotal > 10 ? "plus-warning" : ""}>
            {selected.length} · {candidateTotal}/10{" "}
            {language === "zh" ? "合计" : "total"}
          </span>
        </div>
        <ul className="plus-task-list">{selected.map(row)}</ul>
        {!selected.length && <p className="plus-empty">{text.noTasks}</p>}
      </section>
      <section>
        <button
          className="plus-disclosure plus-monthly"
          onClick={() => setMonthlyOpen(!monthlyOpen)}
          aria-expanded={monthlyOpen}
        >
          {monthlyOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <h2>{text.monthly}</h2>
          <span>{tasks.filter((task) => task.stage === "monthly").length}</span>
        </button>
        {monthlyOpen && (
          <ul className="plus-task-list">
            {tasks.filter((task) => task.stage === "monthly").map(row)}
          </ul>
        )}
      </section>
      <p className="plus-footer-note">{text.reset}</p>
    </>
  );
}
