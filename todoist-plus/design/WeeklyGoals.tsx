import { useState } from "react";
import { Pencil, Target } from "lucide-react";
import { type Area, CURRENT_WEEK } from "./planning-model";
import "./weekly-goals.css";

interface Props {
  goals: Record<Area, string>;
  onSave: (goals: Record<Area, string>) => void;
}

export function WeeklyGoals({ goals, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(goals);
  return (
    <section className="planning-weekly-goals" aria-label="Weekly goals">
      <header>
        <h2>
          <Target size={15} /> Weekly bets <span>Week of {CURRENT_WEEK}</span>
        </h2>
        {!editing && (
          <button
            aria-label="Edit weekly goals"
            onClick={() => {
              setDraft(goals);
              setEditing(true);
            }}
          >
            <Pencil size={13} /> Edit
          </button>
        )}
      </header>
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSave({
              work: draft.work.trim(),
              personal: draft.personal.trim(),
            });
            setEditing(false);
          }}
        >
          <div className="planning-weekly-goal-fields">
            {(["work", "personal"] as const).map((area) => (
              <label key={area}>
                {area === "work" ? "Work goal" : "Personal goal"}
                <input
                  value={draft[area]}
                  maxLength={160}
                  onChange={(event) =>
                    setDraft({ ...draft, [area]: event.target.value })
                  }
                />
              </label>
            ))}
          </div>
          <div className="planning-goal-actions">
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="plus-button plus-primary" type="submit">
              Save goals
            </button>
          </div>
        </form>
      ) : (
        <div className="planning-weekly-goal-fields">
          {(["work", "personal"] as const).map((area) => (
            <div className="planning-weekly-goal" key={area}>
              <span>{area === "work" ? "Work" : "Personal"}</span>
              <strong>
                {goals[area] || "Choose one outcome for this week"}
              </strong>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
