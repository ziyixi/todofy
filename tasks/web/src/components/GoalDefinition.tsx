import type { ReactNode } from "react";
import { Check, Circle, ExternalLink } from "lucide-react";
import type { MessageInitShape } from "@ziyixi/proto/protobuf";
import {
  KeyResultSchema,
  type KeyResult,
} from "@ziyixi/proto/tasks/ui/v1/goals_pb";
import { goalDate } from "./GoalProgress";

export function GoalDefinition({
  goal,
  objectiveTitle,
  timeZone,
  saving,
  onUpdate,
  children,
}: {
  goal: KeyResult;
  objectiveTitle?: string;
  timeZone: string;
  saving: boolean;
  onUpdate: (
    values: MessageInitShape<typeof KeyResultSchema>,
    paths: string[],
  ) => Promise<void>;
  children: ReactNode;
}) {
  const confirmed = goal.milestones.filter((item) => item.completed).length;
  return (
    <article className="goal-definition">
      <p className="goal-objective-caption">
        {objectiveTitle}
        {(goal.archived || goal.objectiveArchived) && (
          <span className="goal-archived">Archived</span>
        )}
        {goal.sourceUrl && (
          <a
            className="goal-evidence"
            href={goal.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={13} />
            Source
          </a>
        )}
      </p>
      <h2>{goal.title}</h2>
      {goal.kind !== "exploration" && (goal.floorText || goal.targetText) && (
        <dl
          className={`goal-bounds ${!goal.floorText || !goal.targetText ? "goal-single-bound" : ""}`}
        >
          {goal.floorText && (
            <div>
              <dt>Floor</dt>
              <dd>{goal.floorText}</dd>
            </div>
          )}
          {goal.targetText && (
            <div>
              <dt>Ceiling</dt>
              <dd>{goal.targetText}</dd>
            </div>
          )}
        </dl>
      )}
      {goal.notes && (
        <p className="goal-notes goal-preserve-lines">{goal.notes}</p>
      )}
      {goal.kind === "outcome" ? (
        <section
          className="goal-outcomes"
          aria-labelledby="goal-outcomes-heading"
        >
          <div className="goal-section-heading">
            <h3 id="goal-outcomes-heading">Result progress</h3>
            <span>
              {confirmed} {confirmed === 1 ? "milestone" : "milestones"} confirmed
            </span>
          </div>
          <p className="goal-muted">Confirm milestones from actual results.</p>
          {goal.milestones.length ? (
            <ul className="goal-milestones">
              {goal.milestones.map((milestone) => (
                <li key={milestone.id}>
                  <button
                    className={`complete-button ${milestone.completed ? "is-completed" : ""}`}
                    disabled={saving}
                    aria-label={`${milestone.completed ? "Reopen" : "Confirm"} milestone ${milestone.title}`}
                    onClick={() =>
                      void onUpdate(
                        {
                          milestones: goal.milestones.map((value) =>
                            value.id === milestone.id
                              ? {
                                  ...value,
                                  completed: !value.completed,
                                }
                              : value,
                          ),
                        },
                        ["milestones"],
                      )
                    }
                  >
                    {milestone.completed ? (
                      <Check size={13} />
                    ) : (
                      <Circle size={21} />
                    )}
                  </button>
                  <span>{milestone.title}</span>
                  <time>
                    {goalDate(milestone.completeTime, timeZone) || "—"}
                  </time>
                </li>
              ))}
            </ul>
          ) : (
            <p className="goal-muted goal-no-milestones">
              No milestones defined.
            </p>
          )}
          <label className="goal-checkbox goal-result-completion">
            <input
              type="checkbox"
              checked={goal.completed}
              disabled={saving}
              onChange={(event) =>
                void onUpdate({ completed: event.target.checked }, [
                  "completed",
                ])
              }
            />
            Result confirmed complete
          </label>
        </section>
      ) : (
        <section className="goal-outcomes">
          <h3>{goal.kind === "routine" ? "Routine" : "Exploration"}</h3>
          <p className="goal-muted">
            {goal.kind === "routine"
              ? "Record how this routine is going and what needs adjustment."
              : "Keep notes on what you tried, learned and want to explore next."}
          </p>
        </section>
      )}
      {children}
    </article>
  );
}
