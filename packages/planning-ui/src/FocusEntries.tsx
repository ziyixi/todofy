import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Plus, X } from "lucide-react";
import {
  clockTime,
  effectiveArea,
  formattedMinutes,
  taskIndex,
  validMinutes,
} from "./domain";
import { words } from "./i18n";
import { pendingEntry } from "./plan-updates";
import { LoggedTime, PendingMark } from "./StatusMarks";
import type {
  Area,
  DeletedEntry,
  FocusEntry,
  FocusState,
  FocusTaskInfo,
  Language,
  PlanState,
  PlusActions,
  SavedEntry,
} from "./model";

/**
 * A record write through the App's write queue: `pending` names what waits, and the confirmed
 * record merges wherever the day's records are shown.
 */
export type RecordWrite = (
  pending: string,
  write: () => Promise<SavedEntry | DeletedEntry>,
) => Promise<boolean>;

/**
 * The area of time added by hand to `taskId`: its own (or inherited) area when Plan lists it; else
 * that of its latest record; else its parent's when Plan lists the parent; else none. A completed
 * step has left Plan's list, and its earlier records keep the area it had.
 */
export function recordArea(
  taskId: string,
  plan: PlanState,
  info: FocusTaskInfo | undefined,
  records: readonly FocusEntry[],
): Area {
  const byId = taskIndex(plan.tasks);
  const task = byId.get(taskId);
  if (task) return effectiveArea(task, plan.tasks);
  const latest = records.filter((entry) => entry.taskId === taskId).at(-1);
  if (latest) return latest.area;
  const parent = info?.parentId ? byId.get(info.parentId) : undefined;
  return parent ? effectiveArea(parent, plan.tasks) : "unassigned";
}

/** The margin the popover keeps from the window's edges. */
const EDGE = 16;

interface Props {
  taskId: string;
  title: string;
  /** The day the records count on. */
  date: string;
  /** The task's records on that day, first to last. */
  records: FocusEntry[];
  /** Focus, when the task's session counts on that day: its time so far is logged too. */
  session?: FocusState;
  /** The area added time is counted in (recordArea). */
  area: Area;
  /** The account's time zone, which a session's start time is shown in. */
  timezone: string;
  language: Language;
  busy: boolean;
  /** Records whose write is not yet confirmed (pendingEntry). */
  pending?: ReadonlySet<string>;
  actions: Pick<PlusActions, "addEntry" | "updateEntry" | "deleteEntry">;
  write: RecordWrite;
}

/**
 * A Focus card's logged time: a quiet button that opens the day's records of the task, to change,
 * add or delete. While the task's session counts on the day, the time ticks as a clock.
 */
export function FocusLogged(props: Props) {
  const { records, session, title, language } = props;
  const text = words(language);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const timeId = useId();
  const titleId = useId();
  const saved = records.reduce((sum, entry) => sum + entry.seconds, 0);
  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) button.current?.focus();
  }
  return (
    <>
      <button
        ref={button}
        type="button"
        className="plus-focus-logged"
        aria-haspopup="dialog"
        aria-expanded={open}
        // Its name is the time, then whose it is: "35m logged (Draft API)".
        aria-labelledby={`${timeId} ${titleId}`}
        // A press while the records are open keeps focus in them, so the click closes them.
        onMouseDown={(event) => {
          if (open) event.preventDefault();
        }}
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        <span id={timeId}>
          {saved || session ? (
            <LoggedTime
              seconds={saved}
              session={session}
              clock={Boolean(session)}
              label={text.logged}
            />
          ) : (
            text.logTime
          )}
        </span>
        <span id={titleId} hidden>
          {language === "zh" ? `（${title}）` : `(${title})`}
        </span>
      </button>
      {open && <Records {...props} onClose={close} />}
    </>
  );
}

/**
 * The records popover. It is not modal: Tab moves through it and out of it, and focus leaving it,
 * a click outside or Escape closes it. Nothing pressed inside it starts a card's drag.
 */
function Records({
  taskId,
  title,
  date,
  records,
  area,
  timezone,
  language,
  busy,
  pending,
  actions,
  write,
  onClose,
}: Props & {
  onClose: (refocus: boolean) => void;
}) {
  const text = words(language);
  const popover = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const heading = useId();
  const [status, setStatus] = useState("");
  const [adding, setAdding] = useState(false);
  // An added record closes its row; focus goes back to "Add time".
  const [added, setAdded] = useState(0);
  // Where the column's edge leaves too little room on the right (a phone), it moves left, before
  // it is drawn, so it never leaves the window or makes the page scroll sideways.
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const box = popover.current?.getBoundingClientRect();
    if (!box?.width) return;
    const room = document.documentElement.clientWidth - EDGE - box.right;
    if (room < 0) setShift(Math.max(room, EDGE - box.left));
  }, []);
  useEffect(() => {
    popover.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (added) addButton.current?.focus();
  }, [added]);
  const total = records.reduce((sum, entry) => sum + entry.seconds, 0);
  return (
    <div
      ref={popover}
      className="plus-focus-entries"
      style={shift ? { left: shift } : undefined}
      role="dialog"
      aria-labelledby={heading}
      tabIndex={-1}
      data-no-drag
      // Focus leaving it closes it, to wherever focus went; the button that opened it included.
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        onClose(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
      }}
    >
      <header>
        <h3 id={heading}>
          {text.timeRecords} · {title}
        </h3>
        <button
          type="button"
          className="plus-icon"
          aria-label={text.close}
          onClick={() => onClose(true)}
        >
          <X size={14} />
        </button>
      </header>
      {records.length > 0 ? (
        <ul>
          {records.map((entry) => (
            <RecordRow
              key={entry.id}
              entry={entry}
              timezone={timezone}
              language={language}
              busy={busy}
              waiting={pending?.has(pendingEntry(entry.id)) ?? false}
              onSave={(seconds) =>
                write(pendingEntry(entry.id), () =>
                  actions.updateEntry(entry, seconds),
                ).then((saved) => {
                  if (saved) setStatus(text.saved);
                  return saved;
                })
              }
              onDelete={() => {
                // The row leaves once Tasks confirms; focus stays in the popover meanwhile.
                popover.current?.focus({ preventScroll: true });
                void write(pendingEntry(entry.id), () =>
                  actions.deleteEntry(entry),
                ).then((deleted) => {
                  if (deleted) setStatus(text.deleted);
                });
              }}
            />
          ))}
        </ul>
      ) : (
        <p className="plus-muted">{text.noRecords}</p>
      )}
      <footer>
        <span>
          {text.total} {formattedMinutes(total / 60)}
        </span>
        {adding ? (
          <AddRecord
            language={language}
            busy={busy}
            waiting={
              pending?.has(pendingEntry(`new:${taskId}:${date}`)) ?? false
            }
            onCancel={() => {
              setAdding(false);
              setAdded((count) => count + 1);
            }}
            onAdd={(seconds) =>
              write(pendingEntry(`new:${taskId}:${date}`), () =>
                actions.addEntry({ taskId, date, seconds, area }),
              ).then((saved) => {
                if (!saved) return;
                setStatus(text.saved);
                setAdding(false);
                setAdded((count) => count + 1);
              })
            }
          />
        ) : (
          <button
            ref={addButton}
            type="button"
            className="plus-text-button"
            onClick={() => setAdding(true)}
          >
            <Plus size={13} />
            {text.addTime}
          </button>
        )}
      </footer>
      <span className="plus-sr-only" role="status">
        {status}
      </span>
    </div>
  );
}

/** Whole minutes in a field: Enter or leaving it saves a change, Escape puts the saved value back. */
function minutesKeys(
  event: KeyboardEvent<HTMLInputElement>,
  changed: boolean,
  submit: () => void,
  restore: () => void,
) {
  if (event.key === "Enter") {
    event.preventDefault();
    submit();
  } else if (event.key === "Escape" && changed) {
    // The first Escape only restores; the next one closes the popover.
    event.preventDefault();
    restore();
  }
}

function RecordRow({
  entry,
  timezone,
  language,
  busy,
  waiting,
  onSave,
  onDelete,
}: {
  entry: FocusEntry;
  timezone: string;
  language: Language;
  busy: boolean;
  /** Its change or deletion is not yet confirmed. */
  waiting: boolean;
  onSave: (seconds: number) => Promise<boolean>;
  onDelete: () => void;
}) {
  const text = words(language);
  const saved = String(entry.seconds / 60);
  const [draft, setDraft] = useState(saved);
  // A confirmed change, here or in another view, replaces the field.
  useEffect(() => setDraft(saved), [saved]);
  const minutes = Number(draft);
  const valid = validMinutes(minutes);
  const time =
    entry.source === "timer" && entry.startedAt
      ? clockTime(entry.startedAt, timezone, language)
      : undefined;
  function save() {
    if (!valid || draft === saved || waiting) return;
    // A refused change puts the saved value back, as the error banner says.
    void onSave(minutes * 60).then((ok) => {
      if (!ok) setDraft(saved);
    });
  }
  return (
    <li className={waiting ? "is-pending" : undefined}>
      <span className="plus-focus-entry-time">{time ?? "—"}</span>
      <input
        className="plus-custom-minutes"
        type="number"
        min={1}
        max={1440}
        step={1}
        value={draft}
        readOnly={busy || waiting}
        aria-invalid={!valid || undefined}
        aria-label={time ? text.minutesAt(time) : text.minutesAdded}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) =>
          minutesKeys(event, draft !== saved, save, () => setDraft(saved))
        }
        onBlur={() => {
          if (valid && draft !== saved) save();
          else setDraft(saved);
        }}
      />
      <span className="plus-muted">{text.minutes}</span>
      {waiting && <PendingMark language={language} />}
      <button
        type="button"
        className="plus-icon"
        aria-label={text.deleteRecord}
        disabled={busy || waiting}
        onClick={onDelete}
      >
        <X size={13} />
      </button>
    </li>
  );
}

function AddRecord({
  language,
  busy,
  waiting,
  onAdd,
  onCancel,
}: {
  language: Language;
  busy: boolean;
  waiting: boolean;
  onAdd: (seconds: number) => void;
  onCancel: () => void;
}) {
  const text = words(language);
  const [draft, setDraft] = useState("15");
  const minutes = Number(draft);
  const valid = validMinutes(minutes);
  const add = () => {
    if (valid && !busy && !waiting) onAdd(minutes * 60);
  };
  return (
    <span className="plus-focus-entry-add">
      <input
        className="plus-custom-minutes"
        type="number"
        min={1}
        max={1440}
        step={1}
        value={draft}
        autoFocus
        readOnly={busy || waiting}
        aria-invalid={!valid || undefined}
        aria-label={text.addTime}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            add();
          } else if (event.key === "Escape") {
            // Closes this row; the next Escape closes the popover.
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <span className="plus-muted">{text.minutes}</span>
      {waiting && <PendingMark language={language} />}
      <button
        type="button"
        className="plus-button"
        disabled={!valid || busy || waiting}
        onClick={add}
      >
        {text.addRecord}
      </button>
    </span>
  );
}
