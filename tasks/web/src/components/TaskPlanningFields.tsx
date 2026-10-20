import { TASK_OPTIONS, type PlanningDraft } from "../task-planning";
import "./task-planning.css";

export function TaskPlanningFields({
  value,
  onChange,
  disabled,
}: {
  value: PlanningDraft;
  onChange: <K extends keyof PlanningDraft>(
    field: K,
    value: PlanningDraft[K],
  ) => void;
  disabled: boolean;
}) {
  const option = ([field, , label]: (typeof TASK_OPTIONS)[number]) => (
    <label
      className={`task-option ${field === "singleAction" ? "standalone-option" : ""}`}
      key={field}
    >
      <input
        type="checkbox"
        checked={value[field]}
        disabled={disabled || (field === "singleAction" && value.quick)}
        title={
          field === "singleAction" && value.quick
            ? "Quick actions are always standalone"
            : undefined
        }
        onChange={(event) => onChange(field, event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
  return (
    <section className="task-planning-fields" aria-label="Task planning">
      <div className="task-planning-selects">
        <label>
          Planning
          <select
            aria-label="Planning stage"
            value={value.stage}
            disabled={disabled}
            onChange={(event) => onChange("stage", event.target.value)}
          >
            <option value="none">Not planned</option>
            <option value="quarterly">Quarter</option>
            <option value="monthly">Month</option>
            <option value="weekly">Week</option>
            <option value="committed">Committed</option>
          </select>
        </label>
        <label>
          Context
          <select
            aria-label="Task context"
            value={value.area}
            disabled={disabled}
            onChange={(event) => onChange("area", event.target.value)}
          >
            <option value="unassigned">Not set</option>
            <option value="work">Work</option>
            <option value="personal">Personal</option>
          </select>
        </label>
      </div>
      <div className="task-option-groups" aria-label="Task options">
        <fieldset className="task-option-group">
          <legend>Action</legend>
          <div className="task-option-grid">
            {TASK_OPTIONS.filter(([field]) =>
              ["singleAction", "quick", "routine"].includes(field),
            ).map(option)}
          </div>
        </fieldset>
        <fieldset className="task-option-group">
          <legend>Status</legend>
          <div className="task-option-grid">
            {TASK_OPTIONS.filter(
              ([field]) =>
                !["singleAction", "quick", "routine"].includes(field),
            ).map(option)}
          </div>
        </fieldset>
      </div>
    </section>
  );
}
