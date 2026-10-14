import { Check, Play, Pause } from "lucide-react";
import { findStep, minutesLabel, type Outcome } from "./planning-model";

interface Props {
  outcomes: Outcome[];
  ids: string[];
  running: string;
  onRunning: (id: string) => void;
  onSave: (outcome: Outcome) => void;
  onEdit: (id: string) => void;
  onPlan: () => void;
}

export function PrototypeFocus({
  outcomes,
  ids,
  running,
  onRunning,
  onSave,
  onEdit,
  onPlan,
}: Props) {
  return (
    <section className="planning-today">
      <button className="planning-adjust" onClick={onPlan}>
        Adjust plan
      </button>
      {ids.map((id) => {
        const value = findStep(outcomes, id);
        if (!value) return null;
        const { outcome, step } = value;
        return (
          <div
            className={`planning-today-step ${step.done ? "completed" : ""}`}
            key={id}
          >
            <button
              className="planning-complete"
              aria-label={`Complete: ${step.title}`}
              onClick={() => {
                onSave({
                  ...outcome,
                  steps: outcome.steps.map((item) =>
                    item.id === id ? { ...item, done: !item.done } : item,
                  ),
                });
                if (running === id) onRunning("");
              }}
            >
              <Check size={14} />
            </button>
            <button
              className="planning-today-title"
              onClick={() => onEdit(outcome.id)}
            >
              <strong>{step.title}</strong>
              <small>
                {outcome.title} · {minutesLabel(step.minutes)}
              </small>
            </button>
            <button
              className="plus-icon"
              aria-label={`${running === id ? "Pause" : "Start"}: ${step.title}`}
              disabled={step.done}
              onClick={() => onRunning(running === id ? "" : id)}
            >
              {running === id ? <Pause size={17} /> : <Play size={17} />}
            </button>
          </div>
        );
      })}
      <p className="planning-demo-note">
        Local demo. No timer or task is sent to Todoist or FlowDay.
      </p>
    </section>
  );
}
