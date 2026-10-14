import { useState } from "react";
import { X } from "lucide-react";
import type { BoardLane } from "./planning-model";
import "./board-labels.css";

interface Props {
  lanes: BoardLane[];
  onSave: (lanes: BoardLane[]) => void;
  onClose: () => void;
}
const LABEL_CHOICES = [
  "quarter",
  "candiate",
  "focus",
  "committed",
  "quarter_candidates",
  "month_candidates",
  "week_candidates",
];

export function BoardLabels({ lanes, onSave, onClose }: Props) {
  const [draft, setDraft] = useState(() => lanes.map((lane) => ({ ...lane })));
  const [error, setError] = useState("");
  function save() {
    const saved = draft.map((lane) => ({ ...lane, label: lane.label.trim() }));
    const names = new Map<string, string>();
    for (const lane of saved) {
      if (!lane.label) {
        setError(`${lane.title} needs a label.`);
        return;
      }
      const existing = names.get(lane.label.toLowerCase());
      if (existing) {
        setError(`Use different labels for ${existing} and ${lane.title}.`);
        return;
      }
      names.set(lane.label.toLowerCase(), lane.title);
    }
    onSave(saved);
    onClose();
  }
  return (
    <section className="board-labels">
      <header>
        <div>
          <h2>Board labels</h2>
          <p>Choose the label for each planning column.</p>
        </div>
        <button
          type="button"
          className="plus-icon"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="board-label-rows">
          {draft.map((lane) => (
            <label key={lane.id} htmlFor={`board-label-${lane.id}`}>
              <span>{lane.title}</span>
              <input
                id={`board-label-${lane.id}`}
                value={lane.label}
                list="board-label-choices"
                autoComplete="off"
                spellCheck={false}
                aria-required="true"
                onChange={(event) => {
                  setDraft(
                    draft.map((item) =>
                      item.id === lane.id
                        ? { ...item, label: event.target.value }
                        : item,
                    ),
                  );
                  setError("");
                }}
              />
            </label>
          ))}
        </div>
        <datalist id="board-label-choices">
          {LABEL_CHOICES.map((label) => (
            <option key={label} value={label} />
          ))}
        </datalist>
        {error && (
          <p className="board-label-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <span>
            Demo settings reset on reload. Your Todoist tasks and labels stay
            unchanged.
          </span>
          <button type="submit" className="plus-button plus-primary">
            Save
          </button>
        </footer>
      </form>
    </section>
  );
}
