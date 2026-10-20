import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Plus, X } from "lucide-react";
import {
  DEFAULT_STEP_MINUTES,
  displayedTitle,
  formattedMinutes,
  hasPlanningFlag,
  isSchedulable,
  STEP_MINUTES,
  validMinutes,
} from "./domain";
import { detailStatus } from "./deadlines";
import { TaskDependencies } from "./TaskDependencies";
import { words } from "./i18n";
import { PARKED_LABEL } from "./planning-outcomes";
import { PendingMark } from "./StatusMarks";
import { ACTIVE_LABEL } from "./weekly-review";
import type {
  Language,
  PlanningTask,
  PlusActions,
  PlanUpdate,
  RunOperation,
  StepDraft,
  TaskDependency,
} from "./model";

const NATIVE_OPTION_GROUPS = [
  {
    en: "Action",
    zh: "行动",
    options: [
      ["singleAction", "task", "Schedule as a step", "可作为步骤安排"],
      ["quick", "quick", "Quick action", "快速行动"],
      ["routine", "routine", "Routine", "日常事务"],
    ],
  },
  {
    en: "Status",
    zh: "状态",
    options: [
      ["waiting", "waiting", "Waiting", "等待中"],
      ["onHold", "onhold", "On hold", "暂缓"],
    ],
  },
] as const;

/** Native start-ahead accepts a calendar-day count; legacy hosts retain their saved presets. */
export function LeadSelect({
  value,
  language,
  disabled,
  label,
  onChange,
  customAllowed = false,
}: {
  value: number;
  language: Language;
  disabled: boolean;
  /** The accessible name where no visible label wraps it. */
  label?: string;
  onChange: (days: number) => void;
  customAllowed?: boolean;
}) {
  if (customAllowed)
    return (
      <span className="plus-lead-custom">
        <input
          type="number"
          min={0}
          max={365}
          step={1}
          value={value || ""}
          placeholder={words(language).noLead}
          aria-label={label}
          disabled={disabled}
          onChange={(event) => {
            const days = Number(event.target.value);
            if (Number.isInteger(days) && days >= 0 && days <= 365)
              onChange(days);
          }}
        />
        <span>{language === "zh" ? "天" : "days"}</span>
      </span>
    );
  return (
    <select
      className="plus-lead-select"
      aria-label={label}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      disabled={disabled}
    >
      {[0, 1, 3, 7, 14, 30].map((days) => (
        <option key={days} value={days}>
          {days
            ? `${days} ${language === "zh" ? "天" : days === 1 ? "day" : "days"}`
            : words(language).noLead}
        </option>
      ))}
    </select>
  );
}

export interface TaskEditorProps {
  task: PlanningTask;
  tasks: PlanningTask[];
  /** Every dependency, for the "Depends on" section. */
  dependencies: readonly TaskDependency[];
  language: Language;
  busy: boolean;
  /** The task's own drag is not yet confirmed. */
  pending?: boolean;
  run: RunOperation;
  actions: PlusActions;
  todayTaskIds: readonly string[];
  /** The account's today, for the deadline's status. */
  today: string;
  addFocus: (id: string) => void;
  onOpenTask: (id: string) => void;
  /** Opens a task the "Depends on" section names; its Todoist page (onOpenTask) when absent. */
  onOpenDependency?: (id: string) => void;
  onClose?: () => void;
  /** The heading's ID, which names the dialog. */
  titleId?: string;
}

export function TaskEditor({
  task,
  tasks,
  dependencies,
  language,
  busy,
  pending = false,
  run,
  actions,
  todayTaskIds,
  today,
  addFocus,
  onOpenTask,
  onOpenDependency,
  onClose,
  titleId,
}: TaskEditorProps) {
  const text = words(language);
  const [lines, setLines] = useState("");
  // New steps' time: every step gets one, 30 minutes unless another is chosen.
  const [minutes, setMinutes] = useState(String(DEFAULT_STEP_MINUTES));
  // Only edited fields have drafts. Everything else follows the refreshed task.
  const [planning, setPlanning] = useState<{
    base: PlanningTask;
    stage?: PlanningTask["stage"];
    area?: PlanningTask["area"];
  }>();
  const [timing, setTiming] = useState<{
    base: PlanningTask;
    deadline?: string;
    leadDays?: number;
  }>();
  const savedStage = task.explicitStage ?? task.stage;
  const stage = planning?.stage ?? savedStage;
  const area = planning?.area ?? task.area;
  const deadline = timing?.deadline ?? task.deadline;
  const lead = timing?.leadDays ?? task.leadDays;
  const planningChanged = stage !== savedStage || area !== task.area;
  const timingChanged = deadline !== task.deadline || lead !== task.leadDays;
  const planningConflict = Boolean(
    planning &&
    ((stage !== savedStage &&
      (planning.base.explicitStage ?? planning.base.stage) !== savedStage) ||
      (area !== task.area && planning.base.area !== task.area)),
  );
  const timingConflict = Boolean(
    timing &&
    ((deadline !== task.deadline && timing.base.deadline !== task.deadline) ||
      (lead !== task.leadDays && timing.base.leadDays !== task.leadDays)),
  );
  // A read may already contain the owner's choice. Once confirmed, it is no longer a draft.
  useEffect(() => {
    setPlanning((current) => {
      if (!current || current.base.id !== task.id) return undefined;
      const stage = current.stage === savedStage ? undefined : current.stage;
      const area = current.area === task.area ? undefined : current.area;
      if (stage === current.stage && area === current.area) return current;
      return stage === undefined && area === undefined
        ? undefined
        : { ...current, stage, area };
    });
    setTiming((current) => {
      if (!current || current.base.id !== task.id) return undefined;
      const deadline =
        current.deadline === task.deadline ? undefined : current.deadline;
      const leadDays =
        current.leadDays === task.leadDays ? undefined : current.leadDays;
      if (deadline === current.deadline && leadDays === current.leadDays)
        return current;
      return deadline === undefined && leadDays === undefined
        ? undefined
        : { ...current, deadline, leadDays };
    });
  }, [task.id, savedStage, task.area, task.deadline, task.leadDays]);
  const [announcement, setAnnouncement] = useState("");
  const requestId = useRef(crypto.randomUUID());
  const children = tasks.filter((item) => item.parentId === task.id);
  const plannedToday = new Set(todayTaskIds);
  const drafts: StepDraft[] = lines
    .split("\n")
    .map((title) => title.trim())
    .filter(Boolean)
    .map((title) => ({ title, estimatedMinutes: Number(minutes) }));
  // From the fields as shown, so a date being chosen already says where it stands.
  const status = detailStatus(task, deadline, lead, today, language);
  const active = hasPlanningFlag(task, ACTIVE_LABEL);
  // Set aside: a stage or "in progress" chosen here takes it out of Parked too, as a drag out of
  // that lane does; otherwise the card would stay there, whatever its stage.
  const parked = hasPlanningFlag(task, PARKED_LABEL);
  const estimateValues = [
    ...new Set([
      15,
      30,
      45,
      60,
      90,
      120,
      ...(task.estimatedMinutes ? [task.estimatedMinutes] : []),
    ]),
  ].sort((a, b) => a - b);

  function changePlanning(change: {
    stage?: PlanningTask["stage"];
    area?: PlanningTask["area"];
  }) {
    const next = {
      ...planning,
      base: {
        ...(planning?.base ?? task),
        // A field first edited after a refresh starts from what the owner now sees.
        ...(planning?.stage === undefined
          ? { stage: task.stage, explicitStage: task.explicitStage }
          : {}),
        ...(planning?.area === undefined ? { area: task.area } : {}),
      },
      ...change,
    };
    if (next.stage === savedStage) delete next.stage;
    if (next.area === task.area) delete next.area;
    setPlanning(
      next.stage === undefined && next.area === undefined ? undefined : next,
    );
  }
  function changeTiming(change: { deadline?: string; leadDays?: number }) {
    const next = {
      ...timing,
      base: {
        ...(timing?.base ?? task),
        ...(timing?.deadline === undefined ? { deadline: task.deadline } : {}),
        ...(timing?.leadDays === undefined ? { leadDays: task.leadDays } : {}),
      },
      ...change,
    };
    if (next.deadline === task.deadline) delete next.deadline;
    if (next.leadDays === task.leadDays) delete next.leadDays;
    setTiming(
      next.deadline === undefined && next.leadDays === undefined
        ? undefined
        : next,
    );
  }
  async function savePlanning() {
    if (busy || !planningChanged || planningConflict) return;
    if (
      await run(() =>
        actions.updateTask(task, {
          ...(stage !== savedStage ? { stage } : {}),
          ...(stage !== savedStage && stage !== "none" && parked
            ? { parked: false }
            : {}),
          ...(area !== task.area ? { area } : {}),
        }),
      )
    )
      setPlanning(undefined);
  }
  async function saveTiming() {
    if (busy || !timingChanged || timingConflict) return;
    if (await run(() => actions.updateLead(task, deadline, lead)))
      setTiming(undefined);
  }

  async function toggleActive() {
    const title = displayedTitle(task.title);
    const update =
      parked && !active ? { active: true, parked: false } : { active: !active };
    if (await run(() => actions.updateTask(task, update)))
      setAnnouncement(
        `${active ? text.unmarkedActive : text.markedActive}: ${title}`,
      );
  }

  async function addSteps() {
    if (!drafts.length) return;
    // Only App's re-read shows the new steps: the write confirms nothing to merge.
    const saved = await run(async () => {
      await actions.createSteps(task, drafts, requestId.current);
    });
    if (saved) {
      setLines("");
      requestId.current = crypto.randomUUID();
    }
  }

  return (
    <section className="plus-task-editor" aria-label={text.details}>
      <header className="plus-editor-header">
        <h2 id={titleId}>
          {displayedTitle(task.title)}
          {pending && <PendingMark language={language} />}
        </h2>
        {onClose && (
          <button
            className="plus-icon"
            aria-label={text.close}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        )}
      </header>
      <p className="plus-muted plus-native-note">
        {text.native}{" "}
        <button
          className="plus-text-button"
          onClick={() => onOpenTask(task.id)}
        >
          {text.open}
          <ExternalLink size={12} />
        </button>
      </p>
      <div className="plus-editor-planning">
        <label>
          {text.mode}
          <select
            value={stage}
            onChange={(event) =>
              changePlanning({ stage: event.target.value as typeof stage })
            }
            disabled={busy}
          >
            {(
              ["none", "quarterly", "monthly", "weekly", "committed"] as const
            ).map((value) => (
              <option key={value} value={value}>
                {text[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {text.work} / {text.personal}
          <select
            value={area}
            onChange={(event) =>
              changePlanning({ area: event.target.value as typeof area })
            }
            disabled={busy}
          >
            {(["unassigned", "work", "personal"] as const).map((value) => (
              <option key={value} value={value}>
                {text[value]}
              </option>
            ))}
          </select>
        </label>
        {isSchedulable(task) && (
          <label>
            {text.estimate}
            <select
              aria-label={`${text.estimate}: ${displayedTitle(task.title)}`}
              value={task.estimatedMinutes ?? 0}
              disabled={busy}
              onChange={(event) => {
                // Read now: a queued write runs after the select shows its saved value again.
                const minutes = Number(event.target.value);
                void run(() => actions.updateEstimate(task.id, minutes));
              }}
            >
              <option value={0}>{text.unknown}</option>
              {estimateValues.map((value) => (
                <option key={value} value={value}>
                  {formattedMinutes(value)}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          className="plus-button"
          disabled={busy || !planningChanged || planningConflict}
          onClick={() => void savePlanning()}
        >
          {text.save}
        </button>
      </div>
      {planningConflict && (
        <div role="alert" className="plus-muted">
          <p>{text.taskChanged}</p>
          <button
            className="plus-button"
            disabled={busy}
            onClick={() =>
              setPlanning((current) => current && { ...current, base: task })
            }
          >
            {text.keepMyChanges}
          </button>{" "}
          <button
            className="plus-button"
            disabled={busy}
            onClick={() => setPlanning(undefined)}
          >
            {text.useLatestValues}
          </button>
        </div>
      )}
      {task.planningFlags !== undefined && (
        <section
          className="plus-task-options"
          aria-label={language === "zh" ? "任务选项" : "Task options"}
        >
          <h3>{language === "zh" ? "任务选项" : "Task options"}</h3>
          <div className="plus-task-option-groups">
            {NATIVE_OPTION_GROUPS.map((group) => (
              <fieldset className="plus-task-option-group" key={group.en}>
                <legend>{language === "zh" ? group.zh : group.en}</legend>
                <div>
                  {group.options
                    .filter(
                      ([field]) =>
                        field !== "singleAction" || task.kind !== "step",
                    )
                    .map(([field, flag, en, zh]) => (
                      <label
                        key={field}
                        className={
                          field === "singleAction"
                            ? "plus-task-option-standalone"
                            : undefined
                        }
                      >
                        <input
                          type="checkbox"
                          checked={hasPlanningFlag(task, flag)}
                          disabled={
                            busy ||
                            (field === "singleAction" &&
                              hasPlanningFlag(task, "quick"))
                          }
                          title={
                            field === "singleAction" &&
                            hasPlanningFlag(task, "quick")
                              ? "Quick actions are always standalone"
                              : undefined
                          }
                          onChange={(event) => {
                            const update: PlanUpdate = {
                              [field]: event.target.checked,
                            };
                            void run(() => actions.updateTask(task, update));
                          }}
                        />
                        <span>{language === "zh" ? zh : en}</span>
                      </label>
                    ))}
                </div>
              </fieldset>
            ))}
          </div>
        </section>
      )}
      <div className="plus-section-title">
        <h3>
          {task.kind
            ? language === "zh"
              ? "子任务与步骤"
              : "Subtasks & steps"
            : text.steps}
        </h3>
        <span>
          {children.length} {text.remaining}
        </span>
      </div>
      {children.length === 0 && <p className="plus-muted">{text.noChildren}</p>}
      <ul className="plus-steps">
        {children.map((child) => (
          <li key={child.id}>
            <button
              className="plus-child-title"
              onClick={() => onOpenTask(child.id)}
            >
              {displayedTitle(child.title)}
            </button>
            <span className="plus-muted">
              {!isSchedulable(child) &&
                (language === "zh" ? "子任务" : "Subtask")}
              {isSchedulable(child) &&
                (child.estimatedMinutes
                  ? `${child.estimatedMinutes} ${text.minutes}`
                  : text.unknown)}
            </span>
            {isSchedulable(child) && (
              <button
                className="plus-icon"
                title={
                  plannedToday.has(child.id) ? text.inToday : text.addFocus
                }
                aria-label={`${plannedToday.has(child.id) ? text.inToday : text.addFocus}: ${displayedTitle(child.title)}`}
                disabled={busy || plannedToday.has(child.id)}
                onClick={() => addFocus(child.id)}
              >
                {plannedToday.has(child.id) ? (
                  <Check size={16} />
                ) : (
                  <Plus size={16} />
                )}
              </button>
            )}
          </li>
        ))}
      </ul>
      {task.kind !== "step" && (
        <>
          <label className="plus-sr-only" htmlFor="plus-step-lines">
            {text.addSteps}
          </label>
          <textarea
            id="plus-step-lines"
            value={lines}
            onChange={(event) => setLines(event.target.value)}
            placeholder={text.stepPlaceholder}
            rows={3}
            disabled={busy}
          />
          <div className="plus-estimate-presets">
            <span>{text.estimate}</span>
            {STEP_MINUTES.map((value) => (
              <button
                key={value}
                className={minutes === String(value) ? "selected" : ""}
                aria-pressed={minutes === String(value)}
                onClick={() => setMinutes(String(value))}
                disabled={busy}
              >
                {`${value} ${text.minutes}`}
              </button>
            ))}
            <input
              className="plus-custom-minutes"
              type="number"
              min="1"
              max="1440"
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
              aria-label={text.estimate}
            />
          </div>
          {Number(minutes) >= 120 && (
            <p className="plus-warning">{text.longStep}</p>
          )}
          <div className="plus-editor-actions">
            <button
              className="plus-button plus-primary"
              disabled={
                busy || !drafts.length || !validMinutes(Number(minutes || NaN))
              }
              onClick={() => void addSteps()}
            >
              <Plus size={15} />
              {text.addSteps}
            </button>
          </div>
        </>
      )}
      <div className="plus-section-title">
        <h3>{text.deadline}</h3>
      </div>
      <div className="plus-deadline-fields">
        <label>
          {text.deadline}
          <input
            type="date"
            value={deadline}
            disabled={busy}
            onChange={(event) => changeTiming({ deadline: event.target.value })}
          />
        </label>
        <label>
          {text.lead}
          <LeadSelect
            value={lead}
            customAllowed={Boolean(task.kind)}
            language={language}
            disabled={busy}
            onChange={(leadDays) => changeTiming({ leadDays })}
          />
        </label>
        <button
          className="plus-button"
          disabled={busy || !timingChanged || timingConflict}
          onClick={() => void saveTiming()}
        >
          {text.save}
        </button>
        {/* Each click saves the progress choice through the current source. */}
        {task.deadline && (
          <button
            className="plus-button"
            disabled={busy}
            onClick={() => void toggleActive()}
          >
            {active ? text.unmarkActive : text.markActive}
          </button>
        )}
      </div>
      {timingConflict && (
        <div role="alert" className="plus-muted">
          <p>{text.taskChanged}</p>
          <button
            className="plus-button"
            disabled={busy}
            onClick={() =>
              setTiming((current) => current && { ...current, base: task })
            }
          >
            {text.keepMyChanges}
          </button>{" "}
          <button
            className="plus-button"
            disabled={busy}
            onClick={() => setTiming(undefined)}
          >
            {text.useLatestValues}
          </button>
        </div>
      )}
      {status && (
        <p className="plus-muted">
          {status.text}
          {status.danger && (
            <span className="planning-danger-text">{status.danger}</span>
          )}
        </p>
      )}
      <TaskDependencies
        task={task}
        tasks={tasks}
        dependencies={dependencies}
        language={language}
        busy={busy}
        run={run}
        actions={actions}
        onOpen={onOpenDependency ?? onOpenTask}
        announce={setAnnouncement}
      />
      <p className="plus-sr-only" role="status">
        {announcement}
      </p>
    </section>
  );
}
