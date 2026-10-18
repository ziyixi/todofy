import { TASK_OPTIONS, type PlanningDraft } from "../task-planning";
import "./task-planning.css";

export function TaskPlanningFields({
  value,
  onChange,
  disabled,
  loading = false,
}: {
  value: PlanningDraft;
  onChange: <K extends keyof PlanningDraft>(
    field: K,
    value: PlanningDraft[K],
  ) => void;
  disabled: boolean;
  loading?: boolean;
}) {
  const option = ([field, , label]: (typeof TASK_OPTIONS)[number]) => (
    <label
      className={`task-option ${field === "singleAction" ? "standalone-option" : ""}`}
      key={field}
      aria-hidden={loading || undefined}
    >
      {loading ? (
        <span className="task-option-placeholder" />
      ) : (
        <>
          <input
            type="checkbox"
            checked={value[field]}
            disabled={disabled}
            onChange={(event) => onChange(field, event.target.checked)}
          />
          <span>{label}</span>
        </>
      )}
    </label>
  );
  return (
    <section
      className="task-planning-fields"
      aria-label="Task planning"
      aria-busy={loading}
    >
      {loading && (
        <span className="visually-hidden" role="status">
          Planning values are not loaded yet.
        </span>
      )}
      <div className="task-planning-selects">
        <label>
          Planning
          {loading ? (
            <span className="planning-control-placeholder" aria-hidden />
          ) : (
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
          )}
        </label>
        <label>
          Context
          {loading ? (
            <span className="planning-control-placeholder" aria-hidden />
          ) : (
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
          )}
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
