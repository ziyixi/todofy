import { useState, type FormEvent } from "react";
import { ExternalLink, Pencil, Trash2 } from "lucide-react";
import type { GoalProgress as Progress } from "@ziyixi/proto/tasks/ui/v1/goals_pb";
import { api, describeError } from "../api";
import { dateLabel, todayDate } from "../dates";
import { Dialog } from "./Dialog";

export function goalDate(time?: { seconds: bigint }, timeZone?: string) {
  if (!time) return "";
  const zone = timeZone || undefined;
  return dateLabel(
    todayDate(new Date(Number(time.seconds) * 1000), zone),
    todayDate(new Date(), zone),
  );
}

export function GoalProgress({
  keyResultId,
  entries,
  nextPage,
  loading,
  timeZone,
  onMore,
  onChanged,
}: {
  keyResultId: string;
  entries: readonly Progress[];
  nextPage: string;
  loading: boolean;
  timeZone: string;
  onMore: () => void;
  onChanged: () => Promise<void>;
}) {
  const [editor, setEditor] = useState<{ entry?: Progress }>();
  const [deleting, setDeleting] = useState<Progress>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleteRequest, setDeleteRequest] = useState("");
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError("");
    try {
      await api.deleteGoalProgress({
        name: deleting.name,
        etag: deleting.etag,
        requestId: deleteRequest,
      });
      await onChanged();
      setDeleting(undefined);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="goal-progress" aria-labelledby="goal-progress-heading">
      <h3 id="goal-progress-heading">Recent progress</h3>
      {!entries.length && (
        <p className="goal-muted" role={loading ? "status" : undefined}>
          {loading
            ? "Loading progress…"
            : "No progress recorded yet. Add a note when you have something to report."}
        </p>
      )}
      <ol className="goal-progress-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <div className="goal-progress-date">
              <time>{goalDate(entry.createTime, timeZone)}</time>
              <div className="goal-progress-actions">
                <button
                  className="icon-button"
                  aria-label={`Edit progress from ${goalDate(entry.createTime, timeZone)}`}
                  onClick={() => setEditor({ entry })}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Delete progress from ${goalDate(entry.createTime, timeZone)}`}
                  onClick={() => {
                    setError("");
                    setDeleteRequest(crypto.randomUUID());
                    setDeleting(entry);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
            <p className="goal-preserve-lines">{entry.note}</p>
            {entry.evidenceUrl && (
              <a
                className="goal-evidence"
                href={entry.evidenceUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink size={13} />
                View evidence
              </a>
            )}
          </li>
        ))}
      </ol>
      {nextPage && (
        <button className="text-button" onClick={onMore} disabled={loading}>
          {loading ? "Loading…" : "More progress"}
        </button>
      )}
      <button
        className="primary-button goal-record-progress"
        onClick={() => setEditor({})}
      >
        Record progress
      </button>
      <p className="goal-footnote">
        Task completion is recorded separately. Confirm results here.
      </p>
      {editor && (
        <ProgressEditor
          keyResultId={keyResultId}
          entry={editor.entry}
          onClose={() => setEditor(undefined)}
          onSaved={onChanged}
        />
      )}
      {deleting && (
        <Dialog
          title="Delete progress note?"
          onClose={() => setDeleting(undefined)}
        >
          <p className="goal-muted">
            This removes the note and its evidence link.
          </p>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <footer className="goal-form-actions">
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => setDeleting(undefined)}
            >
              Cancel
            </button>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? "Deleting…" : "Delete note"}
            </button>
          </footer>
        </Dialog>
      )}
    </section>
  );
}

function ProgressEditor({
  keyResultId,
  entry,
  onClose,
  onSaved,
}: {
  keyResultId: string;
  entry?: Progress;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [note, setNote] = useState(entry?.note ?? "");
  const [evidenceUrl, setEvidenceUrl] = useState(entry?.evidenceUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requestId] = useState(() => crypto.randomUUID());
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const goalProgress = {
        name: entry?.name,
        keyResultId,
        note: note.trim(),
        evidenceUrl,
      };
      if (entry)
        await api.updateGoalProgress({
          goalProgress,
          requestId,
          etag: entry.etag,
          updateMask: { paths: ["note", "evidence_url"] },
        });
      else await api.createGoalProgress({ goalProgress, requestId });
      await onSaved();
      onClose();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={entry ? "Edit progress" : "Record progress"}
      className="goal-editor"
      onClose={onClose}
    >
      <form className="goal-form" onSubmit={(event) => void save(event)}>
        <label>
          Progress note
          <textarea
            data-autofocus
            required
            rows={5}
            maxLength={4000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <label>
          Evidence link (optional)
          <input
            type="url"
            maxLength={2000}
            placeholder="https://"
            value={evidenceUrl}
            onChange={(event) => setEvidenceUrl(event.target.value)}
          />
        </label>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <footer className="goal-form-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="primary-button" disabled={busy || !note.trim()}>
            {busy ? "Saving…" : "Save progress"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
