import { useState } from "react";
import { Star, X } from "lucide-react";
import { LANES, minutesLabel, type Outcome } from "./planning-model";

interface Props {
  outcome: Outcome;
  onSave: (outcome: Outcome) => void;
  onClose: () => void;
}

export function PlanningDetails({ outcome, onSave, onClose }: Props) {
  const [draft, setDraft] = useState(outcome);
  return (
    <section className="planning-details">
      <header>
        <span className="planning-context">{outcome.context}</span>
        <button className="plus-icon" aria-label="Close" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <input
        className="planning-title-input"
        aria-label="Task title"
        value={draft.title}
        onChange={(event) => setDraft({ ...draft, title: event.target.value })}
      />
      <div className="planning-detail-fields">
        <label>
          Planning
          <select
            value={draft.lane}
            onChange={(event) =>
              setDraft({
                ...draft,
                lane: event.target.value as Outcome["lane"],
              })
            }
          >
            {LANES.map((lane) => (
              <option key={lane.id} value={lane.id}>
                {lane.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select
            value={draft.priority}
            onChange={(event) =>
              setDraft({ ...draft, priority: Number(event.target.value) })
            }
          >
            <option value={4}>P1</option>
            <option value={3}>P2</option>
            <option value={2}>P3</option>
            <option value={1}>P4</option>
          </select>
        </label>
        <button
          className={`planning-bet-button ${draft.bet ? "selected" : ""}`}
          aria-pressed={Boolean(draft.bet)}
          onClick={() => setDraft({ ...draft, bet: !draft.bet })}
        >
          <Star size={15} fill={draft.bet ? "currentColor" : "none"} /> This
          week's bet
        </button>
      </div>
      <h3>
        Next steps <span>{draft.steps.length}</span>
      </h3>
      <ul className="planning-detail-steps">
        {draft.steps.map((step) => (
          <li key={step.id}>
            <span>{step.title}</span>
            <select
              aria-label={`Estimate: ${step.title}`}
              value={step.minutes}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  steps: draft.steps.map((item) =>
                    item.id === step.id
                      ? { ...item, minutes: Number(event.target.value) }
                      : item,
                  ),
                })
              }
            >
              {[15, 30, 45, 60, 90, 120].map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutesLabel(minutes)}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
      {draft.deadline && (
        <p className="planning-detail-deadline">Deadline · {draft.deadline}</p>
      )}
      <footer>
        <span>Changes stay in this local demo.</span>
        <button
          className="plus-button plus-primary"
          onClick={() => {
            onSave(draft);
            onClose();
          }}
        >
          Save
        </button>
      </footer>
    </section>
  );
}
