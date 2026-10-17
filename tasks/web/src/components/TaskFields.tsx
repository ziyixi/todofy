import type { ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";
import type { Catalog, Task, TaskDraft } from "../api";
import { LabelPicker } from "./LabelPicker";
import { TaskDescription } from "./TaskDescription";
interface Props {
  children?: ReactNode;
  task?: Task;
  draft: TaskDraft;
  catalog: Catalog;
  busy: boolean;
  dateText: string;
  preview: string;
  patch: <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => void;
  setDraft: React.Dispatch<React.SetStateAction<TaskDraft>>;
  setDateText: (value: string) => void;
  setPreview: (value: string) => void;
  previewDate: () => Promise<void>;
  setDate: (value: string) => Promise<void>;
  setTime: (value: string) => Promise<void>;
  finish: () => Promise<void>;
  onOpen: (id: string) => void;
}
export function TaskFields({
  children,
  task,
  draft,
  catalog,
  busy,
  dateText,
  preview,
  patch,
  setDraft,
  setDateText,
  setPreview,
  previewDate,
  setDate,
  setTime,
  finish,
  onOpen,
}: Props) {
  const sections = catalog.sections.filter(
    (section) => section.projectId === draft.projectId,
  );
  const dateField = (
    <label>
      Date
      <input
        type="date"
        value={draft.dueDate}
        disabled={busy}
        onChange={(event) => void setDate(event.target.value)}
      />
    </label>
  );
  const deadlineField = (
    <label>
      Deadline
      <input
        type="date"
        value={draft.deadline}
        onChange={(event) => patch("deadline", event.target.value)}
      />
    </label>
  );
  const labelsField = (
    <LabelPicker
      labels={catalog.labels}
      selectedIds={draft.labelIds}
      onChange={(ids) => patch("labelIds", ids)}
    />
  );
  return (
    <div className="task-edit-body">
      <div className="task-edit-main">
        {task?.parentId && (
          <button
            type="button"
            className="text-button parent-link"
            onClick={() => onOpen(task.parentId)}
          >
            Open parent task
            <ChevronRight size={14} />
          </button>
        )}
        <div className="task-title-row">
          {task && (
            <button
              type="button"
              className={`task-finish priority-${draft.priority}${task.completed ? " is-completed" : ""}`}
              aria-label={task.completed ? "Reopen task" : "Complete task"}
              title={task.completed ? "Reopen task" : "Complete task"}
              disabled={busy}
              onClick={() => void finish()}
            >
              <Check size={13} />
            </button>
          )}
          <label className="visually-hidden" htmlFor="task-title">
            Task name
          </label>
          <textarea
            id="task-title"
            className="title-input"
            autoFocus
            data-autofocus
            placeholder="Task name"
            value={draft.title}
            onChange={(event) => patch("title", event.target.value)}
            rows={task ? 2 : 1}
            maxLength={500}
            required
          />
        </div>
        {task ? (
          <TaskDescription
            value={draft.description}
            onChange={(value) => patch("description", value)}
            busy={busy}
          />
        ) : (
          <>
            <label className="visually-hidden" htmlFor="task-description">
              Description
            </label>
            <textarea
              id="task-description"
              className="description-input"
              placeholder="Description"
              value={draft.description}
              onChange={(event) => patch("description", event.target.value)}
              rows={2}
            />
          </>
        )}
        {children}
      </div>
      <aside className="task-properties">
        <label>
          Project
          <select
            value={draft.projectId}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                projectId: event.target.value,
                sectionId: "",
                parentId: "",
              }))
            }
          >
            <option value="">Inbox</option>
            {catalog.projects
              .filter((project) => !project.archived && !project.inbox)
              .map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
          </select>
        </label>
        {sections.length > 0 && (
          <label>
            Section
            <select
              value={draft.sectionId}
              onChange={(event) => patch("sectionId", event.target.value)}
            >
              <option value="">No section</option>
              {sections.map((section) => (
                <option key={section.id} value={section.id}>
                  {section.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {task && dateField}
        {task && deadlineField}
        <label>
          Priority
          <select
            value={draft.priority}
            onChange={(event) => patch("priority", Number(event.target.value))}
          >
            {[1, 2, 3, 4].map((priority) => (
              <option key={priority} value={priority}>
                Priority {priority}
                {priority === 4 ? " · Normal" : ""}
              </option>
            ))}
          </select>
        </label>
        {task && labelsField}
        <details
          className="advanced-properties"
          open={task && (draft.dueDatetime || draft.recurrence) ? true : undefined}
        >
          <summary>
            {task ? "Schedule options" : "More details"}
            {!task && draft.dueDate ? ` · ${draft.dueDate}` : ""}
            {!task && draft.labelIds.length ? ` · ${draft.labelIds.length} labels` : ""}
          </summary>
          <div className="advanced-fields">
            <label>
              Schedule
              <input
                value={dateText}
                placeholder="Tomorrow or every Tuesday"
                onChange={(event) => setDateText(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="text-button date-preview"
              disabled={busy || !dateText.trim()}
              onClick={() => void previewDate()}
            >
              Preview date
            </button>
            {!task && dateField}
            <label>
              Time
              <input
                type="time"
                value={
                  draft.dueDatetime
                    ? new Date(draft.dueDatetime).toLocaleTimeString("sv-SE", {
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZone:
                          draft.dueTimezone || catalog.timeZone || undefined,
                      })
                    : ""
                }
                onChange={(event) => void setTime(event.target.value)}
                disabled={!draft.dueDate || busy}
              />
            </label>
            {!task && deadlineField}
            <label>
              Duration (minutes)
              <input
                type="number"
                min={0}
                max={1440}
                step={5}
                value={draft.durationMinutes || ""}
                placeholder="Not set"
                onChange={(event) =>
                  patch("durationMinutes", Number(event.target.value))
                }
              />
            </label>
            <label>
              Repeat
              <input
                value={draft.recurrence}
                placeholder="e.g. every Tuesday"
                onChange={(event) => {
                  patch("recurrence", event.target.value);
                  setPreview("");
                }}
              />
            </label>
            {draft.recurrence && (
              <p className="field-hint">
                {preview ||
                  "The server validates the repeat rule when you save."}
              </p>
            )}
            {!task && labelsField}
          </div>
        </details>
      </aside>
    </div>
  );
}
