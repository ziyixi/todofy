import { useId } from "react";
import { Play, Repeat2 } from "lucide-react";
import { words } from "./i18n";
import type { Language } from "./model";
import "./execution-fields.css";

export type ExecutionMode = "steps" | "standalone" | "quick";

export interface ExecutionFieldsProps {
  mode: ExecutionMode;
  routine: boolean;
  onModeChange: (mode: ExecutionMode) => void;
  onRoutineChange: (routine: boolean) => void;
  disabled: boolean;
  language?: Language;
}

export function ExecutionFields({
  mode,
  routine,
  onModeChange,
  onRoutineChange,
  disabled,
  language = "en",
}: ExecutionFieldsProps) {
  const id = useId();
  const text = words(language);
  const modes = [
    ["steps", text.executionSteps, text.executionStepsHint],
    ["standalone", text.executionStandalone, text.executionStandaloneHint],
    ["quick", text.executionQuick, text.executionQuickHint],
  ] as const;
  return (
    <section className="task-execution">
      <fieldset
        className="task-execution-mode"
        role="radiogroup"
        aria-label={text.execution}
        aria-describedby={`${id}-hint`}
        disabled={disabled}
      >
        <legend>
          <Play size={18} aria-hidden="true" />
          {text.execution}
        </legend>
        <div className="task-execution-options">
          {modes.map(([value, label]) => (
            <label className="task-execution-option" key={value}>
              <input
                type="radio"
                name={id}
                value={value}
                checked={mode === value}
                disabled={disabled}
                onChange={() => onModeChange(value)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <p className="task-execution-hint" id={`${id}-hint`}>
          {modes.find(([value]) => value === mode)?.[2]}
        </p>
      </fieldset>
      <label className="task-execution-routine">
        <span>
          <Repeat2 size={17} aria-hidden="true" />
          {text.executionRoutine}
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={routine}
          disabled={disabled}
          onChange={(event) => onRoutineChange(event.target.checked)}
        />
      </label>
    </section>
  );
}
