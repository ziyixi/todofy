import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useAnnouncement } from "./announce";
import { DEFAULT_STEP_MINUTES, displayedTitle, STEP_MINUTES } from "./domain";
import { words } from "./i18n";
import { PendingMark } from "./StatusMarks";
import type {
  Language,
  PlanningTask,
  PlusActions,
  RunOperation,
} from "./model";

/** The longest step title the input takes. */
const MAX_TITLE = 500;

interface Props {
  /** The selected commitment, which the new steps go under. */
  outcome: PlanningTask;
  /** PlanView keeps it, so the weekly review's Plan steps can open it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Another write waits, or this input's own: Enter adds nothing then. */
  busy: boolean;
  run: RunOperation;
  actions: PlusActions;
  /** The plan's tasks, which say when a read lists a new step. */
  tasks: readonly PlanningTask[];
  language: Language;
}

/** A step added here, shown as a dimmed card until a read lists it: its title, and its IDs once saved. */
interface NewStep {
  key: number;
  title: string;
  ids?: string[];
}

/**
 * Week › Next steps' last cell: Todoist's own "Add task" row, which opens a one-line input in its
 * place, with the new step's time beside it (30 min unless another is chosen; kept while the cell
 * stays open). Enter adds the title with that time as a sub-task of the selected commitment (one
 * confirm-first AppendTaskSteps), clears the input at once and keeps it open for the next; the
 * title waits as a dimmed card until a read lists the new step. One step saves at a time, and
 * typing never pauses. Esc, Enter with nothing typed, or focus leaving the cell with nothing typed
 * closes it; leaving with text keeps the draft and writes nothing. PlanningWeek keys it by the
 * commitment, so a draft never moves to another one.
 */
export function AddStep({
  outcome,
  open,
  onOpenChange,
  busy,
  run,
  actions,
  tasks,
  language,
}: Props) {
  const text = words(language);
  const [draft, setDraft] = useState("");
  const [minutes, setMinutes] = useState<number>(DEFAULT_STEP_MINUTES);
  const [saving, setSaving] = useState(false);
  const [steps, setSteps] = useState<NewStep[]>([]);
  const [status, announce] = useAnnouncement();
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // One step saves at a time, also for a second Enter that arrives before the re-render.
  const writing = useRef(false);
  // Each title keeps its request ID until it is saved, so that Enter on it again retries it.
  const requests = useRef(new Map<string, string>());
  const keys = useRef(0);
  const mounted = useRef(false);
  // What a save that ends later finds: the draft and whether the input is open by then.
  const now = useRef({ draft, open });
  // Opening focuses the input, except to give a failed title back to an input the owner left.
  const focusOnOpen = useRef(true);
  // Closing by Enter or Esc puts focus back on the Add steps button.
  const refocus = useRef(false);
  const hintId = useId();
  const title = displayedTitle(outcome.title);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    now.current = { draft, open };
  });
  useEffect(() => {
    if (open && focusOnOpen.current) input.current?.focus();
    else if (!open && refocus.current) button.current?.focus();
    focusOnOpen.current = true;
    refocus.current = false;
  }, [open]);

  function close(focusButton: boolean) {
    refocus.current = focusButton;
    setDraft("");
    setMinutes(DEFAULT_STEP_MINUTES);
    onOpenChange(false);
  }
  async function add() {
    const step = draft.trim();
    if (!step) return close(true);
    if (writing.current || busy) return;
    // Another time for the same title is another request.
    const estimatedMinutes = minutes;
    const request = `${outcome.id}|${step}|${estimatedMinutes}`;
    const requestId = requests.current.get(request) ?? crypto.randomUUID();
    requests.current.set(request, requestId);
    const shown = { key: keys.current++, title: step };
    writing.current = true;
    setSaving(true);
    setDraft("");
    setSteps((current) => [...current, shown]);
    let created: string[] = [];
    // Confirm-first; App's re-read after it lists the new step under the commitment.
    const saved = await run(async () => {
      created = await actions.createSteps(
        outcome,
        [{ title: step, estimatedMinutes }],
        requestId,
      );
    });
    writing.current = false;
    if (!mounted.current) return;
    setSaving(false);
    if (saved) {
      requests.current.delete(request);
      setSteps((current) =>
        current.map((item) =>
          item.key === shown.key ? { ...item, ids: created } : item,
        ),
      );
      announce(text.stepAdded(step));
      return;
    }
    // App's banner says why. The title and its time come back to an empty input, with their
    // request ID, so that Enter retries the same request; a new draft typed meanwhile stays, and the
    // title goes.
    setSteps((current) => current.filter((item) => item.key !== shown.key));
    if (now.current.draft) return;
    setDraft(step);
    setMinutes(estimatedMinutes);
    if (!now.current.open) {
      focusOnOpen.current = false;
      onOpenChange(true);
    }
  }

  const listed = new Set(tasks.map((task) => task.id));
  const waiting = steps.filter(
    (step) => !step.ids?.every((id) => listed.has(id)),
  );
  return (
    <>
      {waiting.map((step) => (
        <article
          key={step.key}
          className="planning-tray-step is-pending"
          aria-busy="true"
        >
          {/* Two lines like a step card's, so the swap to it keeps the row's height; the mark
              already says the second one. It follows the title, as on a step card that waits. */}
          <span className="planning-step-title">
            <span>{step.title}</span>
            <small aria-hidden="true">{text.updating}</small>
          </span>
          <PendingMark language={language} />
        </article>
      ))}
      <div
        className={`planning-add-step-cell ${open ? "is-open" : ""}`}
        // Only focus leaving the whole cell counts: choosing a time first keeps it open.
        onBlur={(event) => {
          if (
            open &&
            !event.currentTarget.contains(event.relatedTarget as Node | null) &&
            !draft.trim()
          )
            close(false);
        }}
      >
        {open ? (
          <input
            ref={input}
            className="planning-add-step-input"
            aria-label={text.newStep}
            aria-describedby={hintId}
            aria-disabled={busy || saving || undefined}
            maxLength={MAX_TITLE}
            placeholder={text.newStepPlaceholder}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // An input method's Enter only ends the composition.
              if (event.nativeEvent.isComposing || event.keyCode === 229)
                return;
              if (event.key === "Enter") {
                event.preventDefault();
                void add();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close(true);
              }
            }}
          />
        ) : (
          <button
            ref={button}
            className="planning-add-step"
            aria-label={text.addStepsTo(title)}
            onClick={() => onOpenChange(true)}
          >
            <Plus size={16} />
            {text.addSteps}
          </button>
        )}
        {open && (
          <select
            className="planning-add-step-minutes"
            aria-label={text.estimate}
            value={minutes}
            onChange={(event) => setMinutes(Number(event.target.value))}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close(true);
              }
            }}
          >
            {STEP_MINUTES.map((value) => (
              <option key={value} value={value}>
                {`${value} ${text.minutes}`}
              </option>
            ))}
          </select>
        )}
        <span id={hintId} className="plus-sr-only">
          {text.addStepHint}
        </span>
        <p className="plus-sr-only" role="status">
          {status}
        </p>
      </div>
    </>
  );
}
