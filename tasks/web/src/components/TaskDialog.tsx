import { useRef, useState, type FormEvent } from "react";
import { Check, Trash2 } from "lucide-react";
import type { Catalog, Task, TaskDraft } from "../api";
import { api, describeError } from "../api";
import { Dialog } from "./Dialog";
import { TaskFields } from "./TaskFields";
import { TaskChildren } from "./TaskChildren";
import { TaskPlanningFields } from "./TaskPlanningFields";
import { TaskDependencyFields } from "./TaskDependencyFields";
import { useTaskPlanning } from "../useTaskPlanning";
import { planningChanges, planningDraft } from "../task-planning";
import { scheduledDate, scheduledTime } from "../task-schedule";
import "./color-detail.css";
import "./task-dialog.css";

function taskDraft(task?: Task, defaults?: Partial<TaskDraft>): TaskDraft {
  return {
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
  };
}

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
  /** One write of the task, after which the host reads the list, the catalog and Plan again. */
  onSave: (
    draft: TaskDraft,
    original?: Task,
    requestId?: string,
    planning?: ReturnType<typeof planningChanges>,
  ) => Promise<Task>;
  onDelete: (task: Task) => Promise<void>;
  onOpen: (id: string) => void;
  onComplete: (task: Task) => Promise<string | undefined>;
  /** A write the dialog sent itself (a child, a step, a dependency): the host reads again. */
  onChildAdded: () => void;
}) {
  const [currentTask, setCurrentTask] = useState(task);
  // A create closes once saved; keep its form compact until then.
  const displayTask = task ? currentTask : undefined;
  const [draft, setDraft] = useState<TaskDraft>(() =>
    taskDraft(task, defaults),
  );
  const planning = useTaskPlanning(task);
  const [busy, setBusy] = useState(false);
  const [savedDraft, setSavedDraft] = useState<{
    content: TaskDraft;
    planning: ReturnType<typeof planningDraft>;
  }>();
  // Track draft changes so viewing a property keeps the save confirmation.
  const saveComplete =
    savedDraft?.content === draft && savedDraft?.planning === planning.draft;
  const saveRequestId = useRef(crypto.randomUUID());
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [preview, setPreview] = useState("");
  const [dateText, setDateText] = useState("");
  const isStep = draft.kind === "step";
  const executable = isStep || planning.draft.singleAction;
  const patch = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  async function save() {
    if (!draft.title.trim() || busy) return false;
    setBusy(true);
    setSavedDraft(undefined);
    setError("");
    try {
      // Content and planning are one write of the task, under its etag.
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
        planningChanges(planning.draft, planningDraft(currentTask)),
      );
      setCurrentTask(saved);
      const content = taskDraft(saved);
      const nextPlanning = planningDraft(saved);
      setDraft(content);
      planning.setDraft(nextPlanning);
      saveRequestId.current = crypto.randomUUID();
      if (task) setSavedDraft({ content, planning: nextPlanning });
      else onClose();
      return true;
    } catch (reason) {
      setError(describeError(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void save();
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
        displayTask ? (isStep ? "Step details" : "Task details") : "Add task"
      }
      onClose={onClose}
      className={
        displayTask
          ? "task-dialog task-detail-dialog"
          : "task-dialog quick-add-dialog"
      }
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
          task={displayTask}
          draft={draft}
          catalog={catalog}
          busy={busy}
          dateText={dateText}
          preview={preview}
          patch={patch}
          onDescriptionDone={save}
          setDraft={setDraft}
          setDateText={setDateText}
          setPreview={setPreview}
          previewDate={previewDate}
          setDate={setDate}
          setTime={setTime}
          finish={finish}
          onOpen={onOpen}
          executable={executable}
          leadDays={planning.draft.leadDays}
          onLeadChange={(value) => planning.patch("leadDays", value)}
        >
          {!isStep && (
            <TaskPlanningFields
              value={planning.draft}
              onChange={planning.patch}
              disabled={busy || Boolean(currentTask?.completed)}
            />
          )}
          {displayTask && (
            <>
              {!isStep && (
                <TaskChildren
                  task={displayTask}
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
                task={displayTask}
                busy={busy}
                onOpen={onOpen}
                onSaved={(saved) => {
                  // A dependency write is a write of this task: its etag changes, and the drafts stay.
                  setCurrentTask(saved);
                  onChildAdded();
                }}
              />
            </>
          )}
        </TaskFields>
        <footer className="dialog-footer">
          {displayTask && (
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
          <span
            className="spacer task-save-status"
            role="status"
            aria-live="polite"
          >
            <span className="visually-hidden">
              {saveComplete ? "Saved" : ""}
            </span>
          </span>
          <button type="button" className="secondary-button" onClick={onClose}>
            {task ? "Close" : "Cancel"}
          </button>
          <button
            className="primary-button task-save-button"
            aria-label={currentTask ? "Save changes" : undefined}
            disabled={busy || !draft.title.trim()}
          >
            {busy ? (
              "Saving…"
            ) : saveComplete ? (
              <>
                <Check size={14} />
                Saved
              </>
            ) : currentTask ? (
              "Save changes"
            ) : (
              "Add task"
            )}
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
