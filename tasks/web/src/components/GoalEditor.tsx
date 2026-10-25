import { useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { KeyResult, Objective } from "@ziyixi/proto/tasks/ui/v1/goals_pb";
import { api, describeError } from "../api";
import { Dialog } from "./Dialog";

type SavedGoal = Objective | KeyResult;
interface EditorProps {
  year: number;
  objectives: readonly Objective[];
  objective?: Objective;
  keyResult?: KeyResult;
  kind: "objective" | "keyResult";
  onClose: () => void;
  onSaved: (goal: SavedGoal) => Promise<void>;
}

/** A draft belongs to this opening of the editor; background reads never replace the owner's typing. */
export function GoalEditor({
  year,
  objectives,
  objective,
  keyResult,
  kind,
  onClose,
  onSaved,
}: EditorProps) {
  const item = kind === "objective" ? objective : keyResult;
  const [title, setTitle] = useState(item?.title ?? "");
  const [description, setDescription] = useState(objective?.description ?? "");
  const [objectiveId, setObjectiveId] = useState(
    keyResult?.objectiveId ?? objective?.id ?? objectives[0]?.id ?? "",
  );
  const [resultKind, setResultKind] = useState(keyResult?.kind || "outcome");
  const [floorText, setFloorText] = useState(keyResult?.floorText ?? "");
  const [targetText, setTargetText] = useState(keyResult?.targetText ?? "");
  const [notes, setNotes] = useState(keyResult?.notes ?? "");
  const [milestones, setMilestones] = useState(
    () =>
      keyResult?.milestones.map((milestone) => ({
        id: milestone.id,
        title: milestone.title,
        completed: milestone.completed,
      })) ?? [],
  );
  const [sourceUrl, setSourceUrl] = useState(item?.sourceUrl ?? "");
  const [archived, setArchived] = useState(item?.archived ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requestId] = useState(() => crypto.randomUUID());
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      let saved: SavedGoal;
      if (kind === "objective") {
        const values = {
          name: objective?.name,
          title: title.trim(),
          description,
          sourceUrl,
          archived,
        };
        saved = objective
          ? await api.updateObjective({
              objective: values,
              etag: objective.etag,
              requestId,
              updateMask: {
                paths: ["title", "description", "source_url", "archived"],
              },
            })
          : await api.createObjective({
              objective: { ...values, year, sortOrder: objectives.length },
              requestId,
            });
      } else {
        const values = {
          name: keyResult?.name,
          title: title.trim(),
          objectiveId,
          kind: resultKind,
          floorText,
          targetText,
          notes,
          milestones,
          sourceUrl,
          archived,
        };
        saved = keyResult
          ? await api.updateKeyResult({
              keyResult: values,
              etag: keyResult.etag,
              requestId,
              updateMask: {
                paths: [
                  "title",
                  "objective_id",
                  "kind",
                  "floor_text",
                  "target_text",
                  "notes",
                  "milestones",
                  "source_url",
                  "archived",
                ],
              },
            })
          : await api.createKeyResult({ keyResult: values, requestId });
      }
      await onSaved(saved);
      onClose();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={`${item ? "Edit" : "Add"} ${kind === "objective" ? "objective" : "key result"}`}
      className="goal-editor"
      onClose={onClose}
    >
      <form className="goal-form" onSubmit={(event) => void save(event)}>
        <label>
          Title
          <input
            data-autofocus
            required
            maxLength={300}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {kind === "objective" ? (
          <label>
            Description
            <textarea
              rows={3}
              maxLength={2000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        ) : (
          <>
            <div className="goal-form-pair">
              <label>
                Objective
                <select
                  required
                  value={objectiveId}
                  onChange={(event) => setObjectiveId(event.target.value)}
                >
                  {objectives.map((value) => (
                    <option key={value.id} value={value.id}>
                      {value.title}
                      {value.archived ? " · Archived" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Kind
                <select
                  value={resultKind}
                  onChange={(event) => setResultKind(event.target.value)}
                >
                  <option value="outcome">Outcome</option>
                  <option value="routine">Routine</option>
                  <option value="exploration">Exploration</option>
                </select>
              </label>
            </div>
            <label>
              Floor
              <textarea
                rows={2}
                maxLength={2000}
                value={floorText}
                onChange={(event) => setFloorText(event.target.value)}
              />
            </label>
            <label>
              Ceiling
              <textarea
                rows={2}
                maxLength={2000}
                value={targetText}
                onChange={(event) => setTargetText(event.target.value)}
              />
            </label>
            <label>
              Notes
              <textarea
                rows={3}
                maxLength={8000}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </label>
            {resultKind === "outcome" && (
              <fieldset className="goal-milestone-fields">
                <legend>Milestones</legend>
                {milestones.map((milestone, index) => (
                  <div key={milestone.id || `new-${index}`}>
                    <input
                      aria-label={`Milestone ${index + 1}`}
                      required
                      maxLength={300}
                      value={milestone.title}
                      onChange={(event) =>
                        setMilestones((current) =>
                          current.map((value, position) =>
                            position === index
                              ? { ...value, title: event.target.value }
                              : value,
                          ),
                        )
                      }
                    />
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`Remove milestone ${index + 1}`}
                      onClick={() =>
                        setMilestones((current) =>
                          current.filter((_, position) => position !== index),
                        )
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
                {milestones.length < 20 && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      setMilestones((current) => [
                        ...current,
                        { id: "", title: "", completed: false },
                      ])
                    }
                  >
                    <Plus size={14} />
                    Add milestone
                  </button>
                )}
              </fieldset>
            )}
          </>
        )}
        <label>
          Source link
          <input
            type="url"
            maxLength={2000}
            placeholder="https://"
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
          />
        </label>
        {item && (
          <label className="goal-checkbox">
            <input
              type="checkbox"
              checked={archived}
              onChange={(event) => setArchived(event.target.checked)}
            />
            Archived
          </label>
        )}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <footer className="goal-form-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="primary-button" disabled={busy || !title.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

export function GoalFocusEditor({
  keyResult,
  onClose,
  onSaved,
}: {
  keyResult: KeyResult;
  onClose: () => void;
  onSaved: (value: KeyResult) => Promise<void>;
}) {
  const [start, setStart] = useState(keyResult.focusStartMonth);
  const [end, setEnd] = useState(keyResult.focusEndMonth);
  const [text, setText] = useState(keyResult.focusText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requestId] = useState(() => crypto.randomUUID());
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const saved = await api.updateKeyResult({
        keyResult: {
          name: keyResult.name,
          focusStartMonth: start,
          focusEndMonth: end,
          focusText: text,
        },
        etag: keyResult.etag,
        requestId,
        updateMask: {
          paths: ["focus_start_month", "focus_end_month", "focus_text"],
        },
      });
      await onSaved(saved);
      onClose();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Adjust current focus"
      className="goal-editor"
      onClose={onClose}
    >
      <form className="goal-form" onSubmit={(event) => void save(event)}>
        <div className="goal-form-pair">
          <label>
            From
            <input
              data-autofocus
              type="month"
              required={Boolean(text || end)}
              min={`${keyResult.year}-01`}
              max={`${keyResult.year}-12`}
              value={start}
              onChange={(event) => setStart(event.target.value)}
            />
          </label>
          <label>
            Through
            <input
              type="month"
              required={Boolean(text || start)}
              min={start || `${keyResult.year}-01`}
              max={`${keyResult.year}-12`}
              value={end}
              onChange={(event) => setEnd(event.target.value)}
            />
          </label>
        </div>
        <label>
          Current focus
          <textarea
            rows={3}
            required={Boolean(start || end)}
            maxLength={1000}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setStart("");
            setEnd("");
            setText("");
          }}
        >
          Clear focus
        </button>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <footer className="goal-form-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="primary-button" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
