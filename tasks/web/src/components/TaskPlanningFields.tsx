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
      <div className="task-option-chips" aria-label="Task options">
        {TASK_OPTIONS.map(([field, , label]) => (
          <label className={value[field] ? "selected" : ""} key={field}>
            <input
              type="checkbox"
              checked={value[field]}
              disabled={disabled}
              onChange={(event) => onChange(field, event.target.checked)}
            />
            {label}
          </label>
        ))}
      </div>
    </section>
  );
}
