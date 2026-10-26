import { useCallback, useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  Check,
  ChevronDown,
  Circle,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import { planningWeekStart } from "@ziyixi/planning-ui/domain";
import type { Plan } from "@ziyixi/proto/tasks/ui/v1/plan_pb";
import { api, describeError, type Task } from "../api";

type Completion = (task: Task) => Promise<string | undefined>;

export function GoalRelatedTasks({
  keyResultId,
  keyResultTitle,
  plan,
  refreshRevision,
  onOpenTask,
  onCreateTask,
  onCompleteTask,
}: {
  keyResultId: string;
  keyResultTitle: string;
  plan?: Plan;
  refreshRevision: number;
  onOpenTask: (id: string) => void;
  onCreateTask: (keyResultId: string) => void;
  onCompleteTask: Completion;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [nextPage, setNextPage] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const read = useCallback(
    async (pageToken = "") => {
      const request = ++generation.current;
      setLoading(true);
      setError("");
      try {
        const listed = await api.listTasks({
          view: "all",
          keyResultId,
          pageSize: 30,
          pageToken,
          includeCompleted: true,
        });
        if (request !== generation.current) return;
        setTasks((current) =>
          pageToken
            ? [
                ...current,
                ...listed.tasks.filter(
                  (task) => !current.some((value) => value.id === task.id),
                ),
              ]
            : listed.tasks,
        );
        setNextPage(listed.nextPageToken);
      } catch (reason) {
        if (request === generation.current) setError(describeError(reason));
      } finally {
        if (request === generation.current) setLoading(false);
      }
    },
    [keyResultId],
  );
  useEffect(() => {
    void read();
    return () => {
      generation.current++;
    };
  }, [read, refreshRevision]);
  const bets = plan?.weeklyBets.filter(
    (bet) =>
      bet.weekStart === plan.weekStart &&
      bet.keyResultId === keyResultId &&
      bet.text.trim(),
  );
  return (
    <aside className="goal-related" aria-labelledby="goal-week-heading">
      <section className="goal-week">
        <h2 id="goal-week-heading">Moving this forward this week</h2>
        {plan && (
          <p className="goal-muted">
            Week of{" "}
            {new Intl.DateTimeFormat("en-US", {
              month: "short",
              day: "numeric",
              timeZone: "UTC",
            }).format(
              new Date(`${planningWeekStart(plan.weekStart)}T12:00:00Z`),
            )}
          </p>
        )}
        {bets?.length ? (
          bets.map((bet) => (
            <div className="goal-bet" key={bet.name}>
              <p className="goal-bet-label">
                Weekly Bet · {bet.area === "work" ? "Work" : "Personal"}
              </p>
              <h3>{bet.text}</h3>
              <span className="goal-link-badge">{keyResultTitle}</span>
            </div>
          ))
        ) : (
          <p className="goal-muted goal-no-bet">
            No weekly Bet linked to this result. Choose one in Plan.
          </p>
        )}
      </section>
      <section
        className="goal-related-list"
        aria-labelledby="goal-tasks-heading"
      >
        <div className="goal-section-heading">
          <h3 id="goal-tasks-heading">Tasks supporting this goal</h3>
          <button
            className="icon-button"
            aria-label="Add task for this goal"
            onClick={() => onCreateTask(keyResultId)}
          >
            <Plus size={16} />
          </button>
        </div>
        {error && (
          <p className="error-message" role="alert">
            {error}
            <button className="text-button" onClick={() => void read()}>
              Retry
            </button>
          </p>
        )}
        {loading && !tasks.length && (
          <p className="goal-muted" role="status">
            Loading tasks…
          </p>
        )}
        {!loading && !tasks.length && !error && (
          <p className="goal-muted goal-no-tasks">No linked tasks yet.</p>
        )}
        {tasks.map((task) => (
          <RelatedTask
            key={task.id}
            task={task}
            refreshRevision={refreshRevision}
            onOpenTask={onOpenTask}
            onCompleteTask={onCompleteTask}
          />
        ))}
        {nextPage && (
          <button
            className="text-button"
            disabled={loading}
            onClick={() => void read(nextPage)}
          >
            {loading ? "Loading…" : "More tasks"}
          </button>
        )}
      </section>
      <a className="goal-plan-link" href="#/plan">
        <CalendarDays size={17} />
        Arrange in Plan
      </a>
      <p className="goal-footnote">Everyday tasks can stay unlinked.</p>
    </aside>
  );
}

function TaskCompletion({
  task,
  onComplete,
}: {
  task: Task;
  onComplete: Completion;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={`complete-button priority-${task.priority}`}
      disabled={busy}
      aria-label={`${task.completed ? "Reopen" : "Complete"} ${task.title}`}
      onClick={() => {
        setBusy(true);
        void onComplete(task).finally(() => setBusy(false));
      }}
    >
      {task.completed ? <Check size={13} /> : <Circle size={20} />}
    </button>
  );
}

function RelatedTask({
  task,
  refreshRevision,
  onOpenTask,
  onCompleteTask,
}: {
  task: Task;
  refreshRevision: number;
  onOpenTask: (id: string) => void;
  onCompleteTask: Completion;
}) {
  const [expanded, setExpanded] = useState(false);
  const [steps, setSteps] = useState<Task[]>();
  const [nextPage, setNextPage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const readSteps = useCallback(
    async (pageToken = "") => {
      const request = ++generation.current;
      setLoading(true);
      setError("");
      try {
        const listed = await api.listTasks({
          parentId: task.id,
          pageSize: 30,
          pageToken,
          includeCompleted: true,
        });
        if (request !== generation.current) return;
        const children = listed.tasks.filter((value) => value.kind === "step");
        setSteps((current) =>
          pageToken ? [...(current ?? []), ...children] : children,
        );
        setNextPage(listed.nextPageToken);
      } catch (reason) {
        if (request === generation.current) setError(describeError(reason));
      } finally {
        if (request === generation.current) setLoading(false);
      }
    },
    [task.id],
  );
  useEffect(() => {
    if (expanded) void readSteps();
    return () => {
      generation.current++;
    };
  }, [expanded, readSteps, refreshRevision]);
  const stage =
    task.stage === "committed"
      ? "Committed"
      : task.stage === "weekly"
        ? "Weekly"
        : "";
  return (
    <div className={`goal-task ${task.completed ? "is-completed" : ""}`}>
      <div className="goal-task-row">
        <TaskCompletion task={task} onComplete={onCompleteTask} />
        <button className="goal-task-title" onClick={() => onOpenTask(task.id)}>
          {task.title}
        </button>
        {stage && <span className="goal-stage">{stage}</span>}
        <button
          className="icon-button"
          aria-label={`Open ${task.title}`}
          onClick={() => onOpenTask(task.id)}
        >
          <MoreHorizontal size={16} />
        </button>
      </div>
      {task.childCount > 0 && (
        <button
          className="text-button goal-steps-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronDown size={14} className={expanded ? "is-expanded" : ""} />
          Steps{expanded && <span> · inherit this goal</span>}
        </button>
      )}
      {expanded && (
        <div className="goal-steps">
          {loading && !steps && (
            <p className="goal-muted" role="status">
              Loading steps…
            </p>
          )}
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          {steps?.map((step) => (
            <div
              className={`goal-step ${step.completed ? "is-completed" : ""}`}
              key={step.id}
            >
              <TaskCompletion task={step} onComplete={onCompleteTask} />
              <button
                className="goal-task-title"
                onClick={() => onOpenTask(step.id)}
              >
                {step.title}
              </button>
              <span className="goal-step-estimate">
                {step.durationMinutes
                  ? `${step.durationMinutes}m`
                  : "No estimate"}
              </span>
            </div>
          ))}
          {steps?.length === 0 && !loading && (
            <p className="goal-muted">
              No Steps. Open the task to see its Subtasks.
            </p>
          )}
          {nextPage && (
            <button
              className="text-button"
              disabled={loading}
              onClick={() => void readSteps(nextPage)}
            >
              More children
            </button>
          )}
        </div>
      )}
    </div>
  );
}
