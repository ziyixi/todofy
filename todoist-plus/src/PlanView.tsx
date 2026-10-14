import { ChevronDown, ChevronRight, Flag, Star } from "lucide-react";
import { useState } from "react";
import {
  displayedTitle,
  effectiveArea,
  topLevelBets,
  topLevelChoices,
} from "./domain";
import { TaskFamily } from "./TaskFamily";
import { WeekPlanner } from "./WeekPlanner";
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

interface Props {
  plan: PlanState;
  days: FlowDayPlan[];
  flowTasks: FocusState["flowTasks"];
  timer?: FocusState["timer"];
  currentDate: string;
  language: Language;
  busy: boolean;
  run: RunOperation;
  actions: PlusActions;
  editTask: (task: PlanningTask) => void;
  onWeekChange: (weekStart: string) => void;
}

export function PlanView({
  plan,
  days,
  flowTasks,
  timer,
  currentDate,
  language,
  busy,
  run,
  actions,
  editTask,
  onWeekChange,
}: Props) {
  const [area, setArea] = useState<Area>("work");
  const [monthlyOpen, setMonthlyOpen] = useState(false);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const text = words(language);
  const tasks = topLevelChoices(plan.tasks, area);
  const committed = tasks.filter((task) => task.stage === "committed");
  const selected = tasks.filter((task) => task.stage === "weekly");
  const bets = topLevelBets(plan.tasks, area);
  const attention = plan.tasks.filter(
    (task) =>
      effectiveArea(task, plan.tasks) === area &&
      (task.mustStart || task.missingLead),
  );
  const limit = area === "work" ? 5 : area === "personal" ? 3 : undefined;
  const candidateTotal = (["work", "personal", "unassigned"] as const)
    .flatMap((value) => topLevelChoices(plan.tasks, value))
    .filter((task) => task.stage === "weekly").length;
  const families = (items: PlanningTask[]) => (
    <ul className="plus-family-list">
      {items.map((task) => (
        <TaskFamily
          key={task.id}
          task={task}
          tasks={plan.tasks}
          days={days}
          currentDate={currentDate}
          language={language}
          busy={busy}
          timer={timer}
          actions={actions}
          run={run}
          editTask={editTask}
        />
      ))}
    </ul>
  );
  return (
    <WeekPlanner
      plan={plan}
      days={days}
      flowTasks={flowTasks}
      timer={timer}
      currentDate={currentDate}
      language={language}
      busy={busy}
      actions={actions}
      run={run}
      editTask={editTask}
      onWeekChange={onWeekChange}
    >
      <div
        className="plus-pool-tabs"
        role="tablist"
        aria-label={`${text.work}/${text.personal}`}
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
      <div className="plus-pool-bets">
        <Star size={14} />
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
        <div>
          {bets.length ? (
            bets.map((task) => (
              <button key={task.id} onClick={() => editTask(task)}>
                {displayedTitle(task.title)}
              </button>
            ))
          ) : (
            <span className="plus-muted">
              {language === "zh"
                ? "这周最想推进的一件事"
                : "One outcome for this week"}
            </span>
          )}
        </div>
      </div>
      <section className="plus-pool-section">
        <header>
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
        </header>
        {limit !== undefined && committed.length > limit && (
          <p className="plus-family-long">{text.softLimit}</p>
        )}
        {families(committed)}
        {!committed.length && <p className="plus-pool-empty">{text.noTasks}</p>}
      </section>
      <section className="plus-pool-section">
        <header>
          <h2>{text.weekly}</h2>
          <span className={candidateTotal > 10 ? "plus-warning" : ""}>
            {selected.length} · {candidateTotal}/10{" "}
            {language === "zh" ? "合计" : "total"}
          </span>
        </header>
        {families(selected)}
        {!selected.length && <p className="plus-pool-empty">{text.noTasks}</p>}
      </section>
      {attention.length > 0 && (
        <section className="plus-pool-section">
          <button
            className="plus-pool-disclosure"
            onClick={() => setAttentionOpen(!attentionOpen)}
            aria-expanded={attentionOpen}
          >
            {attentionOpen ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )}
            <Flag size={13} />
            <h2>{text.attention}</h2>
            <span>{attention.length}</span>
          </button>
          {attentionOpen && (
            <ul className="plus-pool-attention" aria-label={text.attention}>
              {attention.map((task) => (
                <li key={task.id}>
                  <button onClick={() => editTask(task)}>
                    {displayedTitle(task.title)}
                  </button>
                  <small>
                    {task.mustStart ? text.mustStart : text.missingLead}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <section className="plus-pool-section">
        <button
          className="plus-pool-disclosure"
          onClick={() => setMonthlyOpen(!monthlyOpen)}
          aria-expanded={monthlyOpen}
        >
          {monthlyOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <h2>{text.monthly}</h2>
          <span>{tasks.filter((task) => task.stage === "monthly").length}</span>
        </button>
        {monthlyOpen &&
          families(tasks.filter((task) => task.stage === "monthly"))}
      </section>
      <p className="plus-pool-footer">{text.reset}</p>
    </WeekPlanner>
  );
}
