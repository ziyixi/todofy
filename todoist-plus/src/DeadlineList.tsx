import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { displayedTitle } from "./domain";
import {
  deadlineRows,
  deadlineTitle,
  isDue,
  rowStatus,
  spokenDeadline,
  type DeadlineRow,
  type StatusText,
} from "./deadlines";
import { words } from "./i18n";
import { pendingTask } from "./plan-updates";
import type {
  Language,
  PlanningTask,
  PlusActions,
  RunOperation,
} from "./model";

/**
 * A status whose "days past" part alone is drawn in --plus-danger. The deadline's full date is its
 * tooltip, and screen readers hear the part of it the status does not already say.
 */
export function Status({
  status,
  deadline,
  language,
}: {
  status: StatusText;
  deadline: string;
  language: Language;
}) {
  return (
    <span
      className="planning-row-status"
      title={deadline ? deadlineTitle(deadline, language) : undefined}
    >
      {status.text}
      {status.danger && (
        <span className="planning-danger-text">{status.danger}</span>
      )}
      {deadline && (
        <span className="plus-sr-only">
          {spokenDeadline(status, deadline, language)}
        </span>
      )}
    </span>
  );
}

interface Props {
  tasks: PlanningTask[];
  today: string;
  language: Language;
  busy: boolean;
  /** Cards whose drag is not yet confirmed; their tasks still carry the old etag. */
  pending?: ReadonlySet<string>;
  run: RunOperation;
  actions: PlusActions;
  /** Whether the account has the literal `active` label that "Mark in progress" writes. */
  canMarkActive: boolean;
  /**
   * The open or closed choice this visit, set by the owner's toggle or by acting on a row;
   * undefined follows the default.
   */
  open?: boolean;
  onToggle: (open: boolean) => void;
  editTask: (task: PlanningTask) => void;
  /** Opens the task's editor at its start-ahead choice; writes nothing. */
  chooseLead: (task: PlanningTask) => void;
}

/**
 * Tasks with a deadline that need a look: in progress, past, in their start window or without a
 * start-ahead choice, earliest first. Each row is its title and one status; its one text action
 * shows on hover or keyboard focus.
 */
export function DeadlineList({
  tasks,
  today,
  language,
  busy,
  pending,
  run,
  actions,
  canMarkActive,
  open,
  onToggle,
  editTask,
  chooseLead,
}: Props) {
  const text = words(language);
  const list = useRef<HTMLDetailsElement>(null);
  const [announcement, setAnnouncement] = useState("");
  // After a confirmed mark, focus moves on from that row.
  const [focusAfter, setFocusAfter] = useState("");
  const rows = deadlineRows(tasks, today);
  // Opens by itself when something should have started.
  const shown = open ?? rows.some((row) => isDue(row.state));
  // Once the write controls are enabled again: the next row's action, or the summary, also when
  // the owner closed the list meanwhile.
  useEffect(() => {
    if (!focusAfter || busy || !list.current) return;
    const items = list.current.open
      ? [...list.current.querySelectorAll<HTMLElement>("li")]
      : [];
    const index = items.findIndex((item) => item.dataset.taskId === focusAfter);
    const next = items
      .slice(index + 1)
      .map((item) => item.querySelector<HTMLElement>(".planning-row-action"))
      .find(Boolean);
    (next ?? list.current.querySelector<HTMLElement>("summary"))?.focus();
    setFocusAfter("");
  }, [focusAfter, busy]);
  if (!rows.length) return null;

  // Acting on a row keeps the list open for the visit, so a row that stops being due stays in
  // view, with focus and the editor's way back inside an open list.
  const keepOpen = () => onToggle(true);
  async function markActive(task: PlanningTask) {
    const title = displayedTitle(task.title);
    keepOpen();
    if (await run(() => actions.updateTask(task, { active: true }))) {
      setAnnouncement(`${text.markedActive}: ${title}`);
      setFocusAfter(task.id);
    }
  }
  function action({ task, state }: DeadlineRow) {
    const title = displayedTitle(task.title);
    if (isDue(state) && canMarkActive)
      return (
        <button
          className="planning-row-action"
          // A card whose drag waits still carries its old etag, so its write waits too.
          disabled={busy || (pending?.has(pendingTask(task.id)) ?? false)}
          aria-label={`${text.markActive}: ${title}`}
          onClick={() => void markActive(task)}
        >
          {text.markActive}
        </button>
      );
    if (state.kind === "noLead")
      return (
        // Opening the editor writes nothing.
        <button
          className="planning-row-action"
          aria-label={`${text.missingLead}: ${title}`}
          onClick={() => {
            keepOpen();
            chooseLead(task);
          }}
        >
          {text.missingLead}
        </button>
      );
    return null;
  }
  return (
    <>
      <details
        ref={list}
        className="planning-attention planning-deadlines"
        open={shown}
        // Only the owner's own toggle counts; React setting `open` fires the event as well.
        onToggle={(event) => {
          if (event.currentTarget.open !== shown)
            onToggle(event.currentTarget.open);
        }}
      >
        <summary>
          <ChevronRight size={14} aria-hidden="true" />
          {text.deadlines} · {rows.length}
        </summary>
        <ul className="planning-rows" aria-label={text.deadlines}>
          {rows.map((row) => {
            const title = displayedTitle(row.task.title);
            const status = rowStatus(row, today, language);
            return (
              <li key={row.task.id} data-task-id={row.task.id}>
                <button
                  className="planning-row-title"
                  onClick={() => {
                    keepOpen();
                    editTask(row.task);
                  }}
                >
                  {title}
                </button>
                <Status
                  status={status}
                  deadline={row.task.deadline}
                  language={language}
                />
                <span className="planning-row-actions">{action(row)}</span>
              </li>
            );
          })}
        </ul>
      </details>
      {/* Outside the list, so it is read even while the list is closed. */}
      <p className="plus-sr-only" role="status">
        {announcement}
      </p>
    </>
  );
}
