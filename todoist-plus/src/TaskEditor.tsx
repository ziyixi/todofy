import { useRef, useState } from "react";
import { Check, ExternalLink, Plus, X } from "lucide-react";
import { displayedTitle, formattedMinutes, startDate } from "./domain";
import { words } from "./i18n";
import { PendingMark } from "./StatusMarks";
import type {
  Language,
  PlanningTask,
  PlusActions,
  RunOperation,
  StepDraft,
} from "./model";

interface Props {
  task: PlanningTask;
  tasks: PlanningTask[];
  language: Language;
  busy: boolean;
  /** The task's own drag is not yet confirmed. */
  pending?: boolean;
  run: RunOperation;
  actions: PlusActions;
  todayTaskIds: readonly string[];
  addFocus: (id: string) => void;
  onOpenTask: (id: string) => void;
  onClose?: () => void;
}

export function TaskEditor({
  task,
  tasks,
  language,
  busy,
  pending = false,
  run,
  actions,
  todayTaskIds,
  addFocus,
  onOpenTask,
  onClose,
}: Props) {
  const text = words(language);
  const [lines, setLines] = useState("");
  const [minutes, setMinutes] = useState("");
  const [deadline, setDeadline] = useState(task.deadline);
  const [lead, setLead] = useState(task.leadDays);
  const [stage, setStage] = useState(task.stage);
  const [area, setArea] = useState(task.area);
  const requestId = useRef(crypto.randomUUID());
  const children = tasks.filter((item) => item.parentId === task.id);
  const plannedToday = new Set(todayTaskIds);
  const drafts: StepDraft[] = lines
    .split("\n")
    .map((title) => title.trim())
    .filter(Boolean)
    .map((title) => ({
      title,
      ...(minutes ? { estimatedMinutes: Number(minutes) } : {}),
    }));
  const start = startDate(deadline, lead);
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

  async function addSteps() {
    if (!drafts.length) return;
    if (await run(() => actions.createSteps(task, drafts, requestId.current))) {
      setLines("");
      requestId.current = crypto.randomUUID();
    }
  }

  return (
    <section className="plus-task-editor" aria-label={text.details}>
      <header className="plus-editor-header">
        <h2>
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
            onChange={(event) => setStage(event.target.value as typeof stage)}
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
            onChange={(event) => setArea(event.target.value as typeof area)}
            disabled={busy}
          >
            {(["unassigned", "work", "personal"] as const).map((value) => (
              <option key={value} value={value}>
                {text[value]}
              </option>
            ))}
          </select>
        </label>
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
        <button
          className="plus-button"
          disabled={busy || (stage === task.stage && area === task.area)}
          // Only what changed: a stage left as shown is not written again with a new area.
          onClick={() =>
            void run(() =>
              actions.updateTask(task, {
                ...(stage !== task.stage ? { stage } : {}),
                ...(area !== task.area ? { area } : {}),
              }),
            )
          }
        >
          {text.save}
        </button>
      </div>
      <div className="plus-section-title">
        <h3>{text.steps}</h3>
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
              {child.estimatedMinutes
                ? `${child.estimatedMinutes} ${text.minutes}`
                : text.unknown}
            </span>
            <button
              className="plus-icon"
              title={plannedToday.has(child.id) ? text.inToday : text.addFocus}
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
          </li>
        ))}
      </ul>
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
        {["", "15", "30", "60", "90"].map((value) => (
          <button
            key={value}
            className={minutes === value ? "selected" : ""}
            onClick={() => setMinutes(value)}
            disabled={busy}
          >
            {value ? `${value} ${text.minutes}` : text.unknown}
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
            busy ||
            !drafts.length ||
            (minutes !== "" &&
              (!Number.isInteger(Number(minutes)) ||
                Number(minutes) < 1 ||
                Number(minutes) > 1440))
          }
          onClick={() => void addSteps()}
        >
          <Plus size={15} />
          {text.addSteps}
        </button>
      </div>
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
            onChange={(event) => setDeadline(event.target.value)}
          />
        </label>
        <label>
          {text.lead}
          <select
            value={lead}
            onChange={(event) => setLead(Number(event.target.value))}
            disabled={busy}
          >
            {[0, 1, 3, 7, 14, 30].map((value) => (
              <option key={value} value={value}>
                {value
                  ? `${value} ${language === "zh" ? "天" : "days"}`
                  : text.noLead}
              </option>
            ))}
          </select>
        </label>
        <button
          className="plus-button"
          disabled={
            busy || (deadline === task.deadline && lead === task.leadDays)
          }
          onClick={() =>
            void run(() => actions.updateLead(task, deadline, lead))
          }
        >
          {text.save}
        </button>
      </div>
      {start && (
        <p className="plus-muted">
          {text.starts}: {start}
        </p>
      )}
    </section>
  );
}
