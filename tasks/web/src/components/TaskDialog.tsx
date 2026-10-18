import { useRef, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import type { Catalog, Task, TaskDraft } from "../api";
import { api, describeError } from "../api";
import { Dialog } from "./Dialog";
import { TaskFields } from "./TaskFields";
import { TaskChildren } from "./TaskChildren";
import { TaskPlanningFields } from "./TaskPlanningFields";
import { TaskDependencyFields } from "./TaskDependencyFields";
import { useTaskPlanning } from "../useTaskPlanning";
import { scheduledDate, scheduledTime } from "../task-schedule";
import "./color-detail.css";

export function TaskDialog({
  task,
  catalog,
  defaults,
  onClose,
  onSave,
  onDelete,
  onOpen,
  onComplete,
  onChildAdded,
}: {
  task?: Task;
  catalog: Catalog;
  defaults?: Partial<TaskDraft>;
  onClose: () => void;
  onSave: (
    draft: TaskDraft,
    original?: Task,
    requestId?: string,
  ) => Promise<Task>;
  onDelete: (task: Task) => Promise<void>;
  onOpen: (id: string) => void;
  onComplete: (task: Task) => Promise<string | undefined>;
  onChildAdded: () => void;
}) {
  const [currentTask, setCurrentTask] = useState(task);
  const [draft, setDraft] = useState<TaskDraft>(() => ({
    title: task?.title ?? "",
    description: task?.description ?? "",
    projectId: task?.projectId ?? "",
    sectionId: task?.sectionId ?? "",
    parentId: task?.parentId ?? "",
    labelIds: task?.labelIds ?? [],
    priority: task?.priority ?? 4,
    dueDate: task?.dueDate ?? "",
    dueDatetime: task?.dueDatetime ?? "",
    dueTimezone: task?.dueTimezone || "",
    deadline: task?.deadline ?? "",
    durationMinutes: task?.durationMinutes ?? 0,
    recurrence: task?.recurrence ?? "",
    kind: task?.kind || "task",
    effort: task?.effort || "",
    ...defaults,
  }));
  const planning = useTaskPlanning(task);
  const [busy, setBusy] = useState(false);
  const saveRequestId = useRef(crypto.randomUUID());
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [preview, setPreview] = useState("");
  const [dateText, setDateText] = useState("");
  const isStep = draft.kind === "step";
  const executable = isStep || planning.draft.singleAction;
  const patch = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.title.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const saved = await onSave(
        {
          ...draft,
          title: draft.title.trim(),
          dueTimezone: draft.dueDatetime
            ? draft.dueTimezone || catalog.timeZone
            : "",
        },
        currentTask,
        saveRequestId.current,
      );
      setCurrentTask(saved);
      saveRequestId.current = crypto.randomUUID();
      if (!saved.completed) await planning.save(saved.id, draft.deadline);
      onChildAdded();
      onClose();
    } catch (reason) {
      setError(
        reason instanceof Error && !("status" in reason)
          ? reason.message
          : describeError(reason),
      );
    } finally {
      setBusy(false);
    }
  }
  async function previewDate() {
    if (!dateText.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.previewDate({
        text: dateText,
        timeZone: catalog.timeZone,
      });
      setDraft((current) => ({
        ...current,
        dueDate: result.dueDate,
        dueDatetime: executable ? result.dueDatetime : "",
        dueTimezone: executable ? result.dueTimezone : "",
        recurrence: result.recurrence,
      }));
      setPreview(`Next: ${result.dueDate}`);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  async function setSchedule(date: string, time: string) {
    if (!date || !time || !executable) {
      setDraft((current) => ({
        ...current,
        dueDate: date,
        dueDatetime: "",
        dueTimezone: "",
      }));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await scheduledDate(
        date,
        time,
        draft.dueTimezone || catalog.timeZone,
      );
      setDraft((current) => ({
        ...current,
        dueDate: result.dueDate,
        dueDatetime: result.dueDatetime,
        dueTimezone: result.dueTimezone,
      }));
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  const setDate = (value: string) =>
    setSchedule(
      value,
      executable
        ? scheduledTime(
            draft.dueDatetime,
            draft.dueTimezone || catalog.timeZone,
          )
        : "",
    );
  const setTime = (value: string) => setSchedule(draft.dueDate, value);
  async function finish() {
    if (!currentTask) return;
    setBusy(true);
    setError("");
    try {
      const message = await onComplete(currentTask);
      if (message) setError(message);
      else onClose();
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!currentTask) return;
    setBusy(true);
    setError("");
    try {
      await onDelete(currentTask);
      onClose();
    } catch (reason) {
      setError(describeError(reason));
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={
        currentTask ? (isStep ? "Step details" : "Task details") : "Add task"
      }
      onClose={onClose}
      className={currentTask ? "task-dialog" : "task-dialog quick-add-dialog"}
    >
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <form
        onSubmit={submit}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }
        }}
      >
        <TaskFields
          task={currentTask}
          draft={draft}
          catalog={catalog}
          busy={busy}
          dateText={dateText}
          preview={preview}
          patch={patch}
          setDraft={setDraft}
          setDateText={setDateText}
          setPreview={setPreview}
          previewDate={previewDate}
          setDate={setDate}
          setTime={setTime}
          finish={finish}
          onOpen={onOpen}
          executable={executable}
          planningLoading={planning.loading || Boolean(planning.error)}
          leadDays={planning.draft.leadDays}
          onLeadChange={(value) => planning.patch("leadDays", value)}
        >
          {!isStep && (
            <>
              <TaskPlanningFields
                value={planning.draft}
                onChange={planning.patch}
                disabled={
                  busy ||
                  planning.loading ||
                  Boolean(planning.error) ||
                  Boolean(currentTask?.completed)
                }
              />
              {planning.loading && (
                <p className="muted" role="status">
                  Reading planning values…
                </p>
              )}
              {planning.error && (
                <p className="error-message" role="alert">
                  Planning unavailable. Other task fields can still be saved.
                  <button
                    type="button"
                    className="text-button"
                    onClick={planning.retry}
                  >
                    Retry planning
                  </button>
                </p>
              )}
            </>
          )}
          {currentTask && (
            <>
              {!isStep && (
                <TaskChildren
                  task={currentTask}
                  timeZone={catalog.timeZone}
                  busy={busy}
                  onBusy={setBusy}
                  onError={setError}
                  onChanged={onChildAdded}
                  onOpen={onOpen}
                  onDelete={onDelete}
                  onComplete={onComplete}
                />
              )}
              <TaskDependencyFields
                task={currentTask}
                busy={busy}
                onOpen={onOpen}
                onChanged={onChildAdded}
              />
            </>
          )}
        </TaskFields>
        <footer className="dialog-footer">
          {currentTask && (
            <button
              type="button"
              className="text-button danger"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={15} />
              Delete
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={busy || planning.loading || !draft.title.trim()}
          >
            {busy ? "Saving…" : currentTask ? "Save changes" : "Add task"}
          </button>
        </footer>
      </form>
      {confirmDelete && (
        <div className="delete-confirm" role="alert">
          <p>Delete this {isStep ? "step" : "task and its children"}?</p>
          <button
            className="secondary-button"
            onClick={() => setConfirmDelete(false)}
          >
            Keep task
          </button>
          <button
            className="danger-button"
            disabled={busy}
            onClick={() => void remove()}
          >
            Delete task
          </button>
        </div>
      )}
    </Dialog>
  );
}
