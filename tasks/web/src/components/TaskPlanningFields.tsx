import {
  ExecutionFields,
  type ExecutionMode,
} from "@ziyixi/planning-ui/ExecutionFields";
import { ChevronDown, Folder, Target } from "lucide-react";
import type { PlanningDraft } from "../task-planning";
import "./task-planning.css";

export function TaskPlanningFields({
  value,
  onChange,
  onExecutionChange,
  disabled,
}: {
  value: PlanningDraft;
  onChange: <K extends keyof PlanningDraft>(
    field: K,
    value: PlanningDraft[K],
  ) => void;
  onExecutionChange: (mode: ExecutionMode) => void;
  disabled: boolean;
}) {
  const mode = value.quick
    ? "quick"
    : value.singleAction
      ? "standalone"
      : "steps";
  return (
    <section className="task-planning-fields" aria-label="Task planning">
      <div className="task-planning-selects">
        <label>
          <span className="task-planning-label">
            <Target size={16} />
            Planning
          </span>
          <span className="task-planning-select-control">
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
            <ChevronDown size={13} aria-hidden="true" />
          </span>
        </label>
        <label>
          <span className="task-planning-label">
            <Folder size={16} />
            Context
          </span>
          <span className="task-planning-select-control">
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
            <ChevronDown size={13} aria-hidden="true" />
          </span>
        </label>
      </div>
      <ExecutionFields
        mode={mode}
        routine={value.routine}
        onModeChange={onExecutionChange}
        onRoutineChange={(checked) => onChange("routine", checked)}
        disabled={disabled}
      />
    </section>
  );
}
