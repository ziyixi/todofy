import { Check, Play, Pause, Square } from "lucide-react";
import { findStep, minutesLabel, type Outcome } from "./planning-model";
import {
  formatPrototypeTime,
  type PrototypeStopwatch,
} from "./usePrototypeTimer";
import "./prototype-timer.css";

interface Props {
  outcomes: Outcome[];
  ids: string[];
  stopwatch: PrototypeStopwatch;
  onSave: (outcome: Outcome) => void;
  onEdit: (id: string) => void;
  onPlan: () => void;
}

export function PrototypeFocus({
  outcomes,
  ids,
  stopwatch,
  onSave,
  onEdit,
  onPlan,
}: Props) {
  const activeStep = stopwatch.timer
    ? findStep(outcomes, stopwatch.timer.taskId)
    : undefined;
  const activeTitle = activeStep?.step.title ?? "Current session";
  const timerRunning = stopwatch.timer?.status === "running";
  return (
    <section className="planning-today">
      <button className="planning-adjust" onClick={onPlan}>
        Adjust plan
      </button>
      {stopwatch.timer && (
        <div className="prototype-timer-strip">
          <div className="prototype-timer-strip-title">
            <strong>{activeTitle}</strong>
            {activeStep && <small>{activeStep.outcome.title}</small>}
          </div>
          <div className="prototype-stopwatch">
            <span>{timerRunning ? "Running" : "Paused"}</span>
            <output aria-label={`Elapsed: ${activeTitle}`}>
              {formatPrototypeTime(stopwatch.seconds)}
            </output>
          </div>
          <div className="prototype-timer-controls">
            <button
              aria-label={timerRunning ? "Pause session" : "Resume session"}
              onClick={timerRunning ? stopwatch.pause : stopwatch.resume}
            >
              {timerRunning ? <Pause size={16} /> : <Play size={16} />}
              <span>{timerRunning ? "Pause" : "Resume"}</span>
            </button>
            <button aria-label="Stop session" onClick={stopwatch.stop}>
              <Square size={14} />
              <span>Stop</span>
            </button>
          </div>
        </div>
      )}
      {ids.map((id) => {
        const value = findStep(outcomes, id);
        if (!value) return null;
        const { outcome, step } = value;
        const active = stopwatch.timer?.taskId === id;
        const running = active && stopwatch.timer?.status === "running";
        let action = "Start";
        if (active) action = running ? "Pause" : "Resume";
        function toggleTimer() {
          if (!active) stopwatch.start(id);
          else if (running) stopwatch.pause();
          else stopwatch.resume();
        }
        return (
          <div
            className={`planning-today-step ${step.done ? "completed" : ""} ${active ? "is-timing" : ""}`}
            key={id}
          >
            <button
              className="planning-complete"
              aria-label={`Complete: ${step.title}`}
              onClick={() => {
                if (active) stopwatch.stop();
                onSave({
                  ...outcome,
                  steps: outcome.steps.map((item) =>
                    item.id === id ? { ...item, done: !item.done } : item,
                  ),
                });
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
            <div className="prototype-timer-controls">
              <button
                className="prototype-timer-toggle"
                aria-label={`${action}: ${step.title}`}
                disabled={step.done || Boolean(stopwatch.timer && !active)}
                title={
                  stopwatch.timer && !active
                    ? "Stop the current session first."
                    : action
                }
                onClick={toggleTimer}
              >
                {running ? <Pause size={16} /> : <Play size={16} />}
                <span>{action}</span>
              </button>
            </div>
          </div>
        );
      })}
      <p className="planning-demo-note">
        Local demo. No timer or task is sent to Todoist or FlowDay.
      </p>
    </section>
  );
}
