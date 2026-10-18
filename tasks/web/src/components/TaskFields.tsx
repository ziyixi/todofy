import { useState, type ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";
import type { Catalog, Task, TaskDraft } from "../api";
import { LabelPicker } from "./LabelPicker";
import { TaskDescription } from "./TaskDescription";
import { ProjectPicker } from "./ProjectPicker";
import { PriorityPicker } from "./PriorityPicker";
import { SchedulePicker } from "./SchedulePicker";
import { StartAheadPicker } from "./StartAheadPicker";
interface Props {
  children?: ReactNode;
  executable: boolean;
  planningLoading: boolean;
  leadDays: number;
  onLeadChange: (days: number) => void;
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
  executable,
  planningLoading,
  leadDays,
  onLeadChange,
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
  const [openProperty, setOpenProperty] = useState<string | null>(null);
  const propertyOpenChange = (name: string) => (open: boolean) =>
    setOpenProperty((current) =>
      open ? name : current === name ? null : current,
    );
  const labelsField = (
    <LabelPicker
      labels={catalog.labels}
      selectedIds={draft.labelIds}
      onChange={(ids) => patch("labelIds", ids)}
      disabled={busy}
      open={openProperty === "labels"}
      onOpenChange={propertyOpenChange("labels")}
    />
  );
  return (
    <div className="task-edit-body">
      <div className="task-edit-main">
        {task?.parentId && (
          <button
            type="button"
            className="text-button parent-link"
            aria-label="Open parent task"
            onClick={() => onOpen(task.parentId)}
          >
            {task.parentTitle || "Parent task"}
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
        <ProjectPicker
          catalog={catalog}
          projectId={draft.projectId}
          sectionId={draft.sectionId}
          disabled={busy}
          open={openProperty === "project"}
          onOpenChange={propertyOpenChange("project")}
          onChange={(projectId, sectionId) =>
            setDraft((current) => ({
              ...current,
              projectId,
              sectionId,
              parentId: current.projectId === projectId ? current.parentId : "",
            }))
          }
        />
        <SchedulePicker
          label="Date"
          open={openProperty === "date"}
          onOpenChange={propertyOpenChange("date")}
          value={draft.dueDate}
          disabled={busy}
          timeZone={draft.dueTimezone || catalog.timeZone}
          onChange={(value) => {
            if (!value) {
              patch("recurrence", "");
              setDateText("");
              setPreview("");
            }
            return setDate(value);
          }}
          text={dateText}
          onTextChange={setDateText}
          onParse={previewDate}
          preview={preview}
          time={
            draft.dueDatetime
              ? new Date(draft.dueDatetime).toLocaleTimeString("sv-SE", {
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: draft.dueTimezone || catalog.timeZone || undefined,
                })
              : ""
          }
          onTimeChange={executable ? setTime : undefined}
          recurrence={draft.recurrence}
          onRecurrenceChange={(value) => {
            patch("recurrence", value);
            setPreview("");
          }}
        />
        <SchedulePicker
          label="Deadline"
          open={openProperty === "deadline"}
          onOpenChange={propertyOpenChange("deadline")}
          value={draft.deadline}
          disabled={busy}
          timeZone={catalog.timeZone}
          onChange={(value) => {
            patch("deadline", value);
            if (!value) onLeadChange(0);
          }}
        />
        <StartAheadPicker
          key={planningLoading ? "loading" : "ready"}
          days={leadDays}
          deadline={draft.deadline}
          disabled={
            busy ||
            planningLoading ||
            Boolean(task?.completed) ||
            !draft.deadline
          }
          onChange={onLeadChange}
        />
        <PriorityPicker
          value={draft.priority}
          disabled={busy}
          open={openProperty === "priority"}
          onOpenChange={propertyOpenChange("priority")}
          onChange={(value) => patch("priority", value)}
        />
        {labelsField}
        <label className="task-effort-field">
          <span className="property-heading">Effort</span>
          <select
            aria-label="Effort"
            value={draft.effort}
            disabled={busy}
            onChange={(event) => patch("effort", event.target.value)}
          >
            <option value="">Not set</option>
            <option value="deep">Deep work</option>
            <option value="shallow">Shallow work</option>
          </select>
        </label>
        {executable && (
          <label className="task-effort-field">
            <span className="property-heading">Estimate</span>
            <input
              aria-label="Duration (minutes)"
              type="number"
              min={0}
              max={1440}
              step={5}
              value={draft.durationMinutes || ""}
              placeholder="Minutes"
              disabled={busy}
              onChange={(event) =>
                patch("durationMinutes", Number(event.target.value))
              }
            />
          </label>
        )}
      </aside>
    </div>
  );
}
