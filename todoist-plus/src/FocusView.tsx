import {
  ArrowDown,
  ArrowUp,
  Check,
  GripVertical,
  Pause,
  Play,
  Plus,
  X,
} from "lucide-react";
import { useState } from "react";
import { displayedTitle, executionChoices, moveTask } from "./domain";
import { words } from "./i18n";
import type {
  FocusState,
  Language,
  PlanState,
  PlanningTask,
  PlusActions,
} from "./model";

interface Props {
  plan: PlanState;
  focus: FocusState;
  language: Language;
  busy: boolean;
  run: (operation: () => Promise<void>) => Promise<boolean>;
  actions: PlusActions;
  editTask: (task: PlanningTask) => void;
  addFocus: (id: string) => void;
  complete: (task: PlanningTask) => void;
}
export function FocusView({
  plan,
  focus,
  language,
  busy,
  run,
  actions,
  editTask,
  addFocus,
  complete,
}: Props) {
  const text = words(language);
  const [dragging, setDragging] = useState("");
  const [chooser, setChooser] = useState(false);
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const queue = focus.taskIds
    .filter((id) => !focus.completedTaskIds.includes(id))
    .map(
      (id): PlanningTask =>
        byId.get(id) ?? {
          id,
          title:
            focus.flowTasks[id]?.title ??
            (id.startsWith("__flowday_misc__")
              ? language === "zh"
                ? "杂项时间"
                : "Miscellaneous time"
              : text.missingTask),
          estimatedMinutes: focus.flowTasks[id]?.estimatedMinutes,
          parentId: "",
          projectId: "",
          labels: [],
          area: "unassigned",
          stage: "none",
          bet: false,
          deadline: "",
          leadDays: 0,
          due: "",
          etag: "",
          mustStart: false,
          missingLead: false,
        },
    );
  const choices = executionChoices(plan.tasks).filter(
    (task) => !focus.taskIds.includes(task.id),
  );
  const estimated = queue.reduce(
    (sum, task) =>
      sum + (focus.estimates[task.id] ?? task.estimatedMinutes ?? 0),
    0,
  );
  const unknown = queue.filter(
    (task) => !(focus.estimates[task.id] ?? task.estimatedMinutes),
  ).length;
  return (
    <>
      <div className="plus-focus-summary">
        <span>
          {queue.length} {text.steps.toLowerCase()}
        </span>
        <span>
          {estimated} {text.minutes} {text.planned}
        </span>
        {unknown > 0 && (
          <span>
            {unknown} {text.unknown.toLowerCase()}
          </span>
        )}
        <button
          className="plus-text-button"
          onClick={() => setChooser(!chooser)}
        >
          <Plus size={15} />
          {text.choose}
        </button>
      </div>
      <ul className="plus-task-list plus-focus-list">
        {queue.map((task) => {
          const timer =
            focus.timer?.taskId === task.id ? focus.timer : undefined;
          const parent = byId.get(task.parentId);
          const native = byId.has(task.id);
          return (
            <li
              key={task.id}
              className={`plus-focus-row ${timer ? "is-timing" : ""}`}
              draggable={!busy}
              onDragStart={() => setDragging(task.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (!dragging || dragging === task.id) return;
                const ids = [...focus.taskIds];
                ids.splice(ids.indexOf(dragging), 1);
                ids.splice(ids.indexOf(task.id), 0, dragging);
                setDragging("");
                void run(() => actions.updateQueue(ids, focus));
              }}
            >
              <GripVertical size={15} className="plus-drag-handle" />
              {native && (
                <button
                  className="plus-checkbox"
                  aria-label={`${text.complete}: ${displayedTitle(task.title)}`}
                  disabled={busy}
                  onClick={() => complete(task)}
                >
                  <Check size={13} />
                </button>
              )}
              <button
                className="plus-task-main"
                disabled={!native}
                onClick={() => editTask(task)}
              >
                <span>{displayedTitle(task.title)}</span>
                {parent && <small>{displayedTitle(parent.title)}</small>}
                {!native && (
                  <small>
                    {focus.flowTasks[task.id]?.local ||
                    task.id.startsWith("__flowday_")
                      ? text.local
                      : text.missingTask}
                  </small>
                )}
              </button>
              {native ? (
                <label className="plus-inline-estimate">
                  <span className="plus-sr-only">
                    {text.estimate}: {displayedTitle(task.title)}
                  </span>
                  <select
                    aria-label={`${text.estimate}: ${displayedTitle(task.title)}`}
                    value={
                      focus.estimates[task.id] ?? task.estimatedMinutes ?? 0
                    }
                    disabled={busy}
                    onChange={(event) =>
                      void run(() =>
                        actions.updateEstimate(
                          task.id,
                          Number(event.target.value),
                        ),
                      )
                    }
                  >
                    <option value={0}>{text.unknown}</option>
                    {[
                      15,
                      30,
                      45,
                      60,
                      90,
                      120,
                      ...(task.estimatedMinutes &&
                      ![15, 30, 45, 60, 90, 120].includes(task.estimatedMinutes)
                        ? [task.estimatedMinutes]
                        : []),
                    ].map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {minutes} {text.minutes}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <>
                  <span className="plus-muted">
                    {task.estimatedMinutes
                      ? `${task.estimatedMinutes} ${text.minutes}`
                      : text.unknown}
                  </span>
                  {plan.flowdayUrl && (
                    <a
                      className="plus-text-button"
                      href={plan.flowdayUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {text.openFlowday}
                    </a>
                  )}
                </>
              )}
              {native && (
                <button
                  className="plus-icon plus-play"
                  aria-label={`${timer?.status === "running" ? text.pause : timer ? text.resume : text.start}: ${displayedTitle(task.title)}`}
                  disabled={busy || Boolean(focus.timer && !timer)}
                  onClick={() =>
                    void run(() =>
                      actions.timer(
                        timer?.status === "running"
                          ? "pause"
                          : timer
                            ? "resume"
                            : "start",
                        task.id,
                        focus,
                      ),
                    )
                  }
                >
                  {timer?.status === "running" ? (
                    <Pause size={16} />
                  ) : (
                    <Play size={16} />
                  )}
                </button>
              )}
              <div className="plus-focus-tools">
                <button
                  className="plus-icon"
                  aria-label={`${text.up}: ${displayedTitle(task.title)}`}
                  disabled={busy || focus.taskIds.indexOf(task.id) === 0}
                  onClick={() =>
                    void run(() =>
                      actions.updateQueue(
                        moveTask(focus.taskIds, task.id, -1),
                        focus,
                      ),
                    )
                  }
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  className="plus-icon"
                  aria-label={`${text.down}: ${displayedTitle(task.title)}`}
                  disabled={
                    busy ||
                    focus.taskIds.indexOf(task.id) === focus.taskIds.length - 1
                  }
                  onClick={() =>
                    void run(() =>
                      actions.updateQueue(
                        moveTask(focus.taskIds, task.id, 1),
                        focus,
                      ),
                    )
                  }
                >
                  <ArrowDown size={13} />
                </button>
                <button
                  className="plus-icon"
                  aria-label={`${text.remove}: ${displayedTitle(task.title)}`}
                  disabled={busy || Boolean(timer)}
                  onClick={() =>
                    void run(() =>
                      actions.updateQueue(
                        focus.taskIds.filter((id) => id !== task.id),
                        focus,
                      ),
                    )
                  }
                >
                  <X size={13} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {!queue.length && (
        <p className="plus-empty plus-focus-empty">{text.noFocus}</p>
      )}
      {(chooser || !queue.length) && (
        <section>
          <div className="plus-section-title">
            <h2>{text.available}</h2>
          </div>
          <ul className="plus-task-list">
            {choices.map((task) => (
              <li key={task.id} className="plus-available-row">
                <button
                  className="plus-task-main"
                  onClick={() => editTask(task)}
                >
                  <span>{displayedTitle(task.title)}</span>
                  <small>
                    {byId.get(task.parentId)?.title ??
                      (task.labels.includes("quick") ? "Quick / Ops" : "")}
                  </small>
                </button>
                <button
                  className="plus-text-button"
                  disabled={busy}
                  onClick={() => addFocus(task.id)}
                >
                  <Plus size={15} />
                  {text.addFocus}
                </button>
              </li>
            ))}
          </ul>
          {!choices.length && (
            <p className="plus-empty">{text.emptyCandidate}</p>
          )}
        </section>
      )}
      {focus.completedTaskIds.length > 0 && (
        <p className="plus-footer-note">
          {focus.completedTaskIds.length} {text.completed.toLowerCase()}
        </p>
      )}
    </>
  );
}
