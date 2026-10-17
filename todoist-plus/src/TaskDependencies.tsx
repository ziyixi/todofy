import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";
import { displayedTitle } from "./domain";
import {
  candidates,
  dependencyIndex,
  doneText,
  MAX_ALL_DEPENDENCIES,
  MAX_DEPENDENCIES,
  waitersText,
  type Candidate,
} from "./dependencies";
import { words } from "./i18n";
import { PendingMark } from "./StatusMarks";
import type {
  DependencyResult,
  Language,
  PlanningTask,
  PlusActions,
  RunOperation,
  TaskDependency,
} from "./model";

interface Props {
  task: PlanningTask;
  /** The complete read's active tasks, which the picker searches. */
  tasks: readonly PlanningTask[];
  dependencies: readonly TaskDependency[];
  language: Language;
  busy: boolean;
  run: RunOperation;
  actions: PlusActions;
  /** Opens a task a row names: its editor in Plan, its Todoist page on a native page. */
  onOpen: (id: string) => void;
  /** Reads a confirmed change out, in the editor's one status region. */
  announce: (text: string) => void;
}

/**
 * Task details' "依赖 / Depends on" section, after the deadline, in Plan's editor and the native
 * Steps & timing: what the task still waits for, one line for what is done (its remove action takes
 * the done ones away), who waits for it, and an inline picker that searches the loaded tasks as you
 * type. Each change is confirm-first SetTaskDependency; Todoist is never written. Only what still
 * holds fills the 5: a done dependency gives way to a new one.
 */
export function TaskDependencies({
  task,
  tasks,
  dependencies,
  language,
  busy,
  run,
  actions,
  onOpen,
  announce,
}: Props) {
  const text = words(language);
  const plan = { tasks, dependencies };
  const index = dependencyIndex(plan);
  const open = index.waitingFor.get(task.id) ?? [];
  const done = index.done.get(task.id) ?? [];
  const waiters = index.waiters.get(task.id) ?? [];
  const full =
    open.length >= MAX_DEPENDENCIES ||
    (dependencies.length >= MAX_ALL_DEPENDENCIES && !done.length);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  // The highlighted option, by task ID; a greyed one is never highlighted.
  const [activeId, setActiveId] = useState("");
  // The chosen task, shown pending until Todofy confirms it.
  const [adding, setAdding] = useState<PlanningTask>();
  // After a change, focus returns to "Add a dependency" once write controls are enabled again.
  const [returnFocus, setReturnFocus] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const matches = picking ? candidates(plan, task, query) : [];
  const choosable = matches.filter((match) => !match.refusal);
  const current =
    choosable.find((match) => match.task.id === activeId) ?? choosable[0];
  const active = current ? matches.indexOf(current) : -1;
  useEffect(() => {
    if (!returnFocus || busy || picking) return;
    (addButton.current?.disabled
      ? heading.current
      : addButton.current
    )?.focus();
    setReturnFocus(false);
  }, [returnFocus, busy, picking]);

  function close() {
    setPicking(false);
    setQuery("");
    setReturnFocus(true);
  }
  async function choose(match: Candidate) {
    if (match.refusal || busy) return;
    const title = displayedTitle(match.task.title);
    setPicking(false);
    setQuery("");
    setAdding(match.task);
    const saved = await run(() =>
      actions.setDependency(task.id, match.task.id, true),
    );
    setAdding(undefined);
    if (saved) announce(`${text.addedDependency}: ${title}`);
    setReturnFocus(true);
  }
  async function remove(prerequisite: PlanningTask) {
    const title = displayedTitle(prerequisite.title);
    if (await run(() => actions.setDependency(task.id, prerequisite.id, false)))
      announce(`${text.removedDependency}: ${title}`);
    setReturnFocus(true);
  }
  /** Removes every done dependency in one queued write; the last answer lists what is left. */
  async function removeDone() {
    const removed = await run(async () => {
      let result: DependencyResult | undefined;
      for (const dependency of done)
        result = await actions.setDependency(
          task.id,
          dependency.prerequisiteId,
          false,
        );
      return result;
    });
    if (removed) announce(text.removedDoneDependencies);
    setReturnFocus(true);
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      // Arrows move among the options that can be chosen; the greyed ones stay visible with why.
      if (!current) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      const at = choosable.indexOf(current);
      setActiveId(
        choosable[(at + step + choosable.length) % choosable.length]!.task.id,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (current) void choose(current);
    } else if (event.key === "Escape") {
      // Only the picker closes, not Plan's dialog or Todoist's task modal around it.
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  return (
    <div className="plus-dependencies">
      <div className="plus-section-title">
        <h3 ref={heading} tabIndex={-1}>
          {text.dependencies}
        </h3>
      </div>
      {(open.length > 0 || adding) && (
        <ul className="plus-dependency-list">
          {open.map((prerequisite) => {
            const title = displayedTitle(prerequisite.title);
            return (
              <li key={prerequisite.id} className="plus-dependency">
                <button
                  className="plus-dependency-title"
                  onClick={() => onOpen(prerequisite.id)}
                >
                  {title}
                </button>
                {prerequisite.recurring && (
                  <span className="plus-muted">{text.afterNextCompletion}</span>
                )}
                <button
                  className="plus-icon plus-dependency-remove"
                  aria-label={`${text.removeDependency}: ${title}`}
                  title={text.removeDependency}
                  disabled={busy}
                  onClick={() => void remove(prerequisite)}
                >
                  <X size={14} />
                </button>
              </li>
            );
          })}
          {adding && (
            <li className="plus-dependency is-pending">
              <span className="plus-dependency-title">
                {displayedTitle(adding.title)}
              </span>
              <PendingMark language={language} />
            </li>
          )}
        </ul>
      )}
      {done.length > 0 && (
        <div className="plus-dependency-done">
          <p className="plus-muted plus-dependency-note">
            {doneText(done.length, open.length + (adding ? 1 : 0), language)}
          </p>
          <button
            className="plus-icon plus-dependency-remove"
            aria-label={text.removeDoneDependencies}
            title={text.removeDoneDependencies}
            disabled={busy}
            onClick={() => void removeDone()}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {waiters.length > 0 && (
        <p className="plus-muted plus-dependency-note">
          {waitersText(waiters, language)}
        </p>
      )}
      {picking ? (
        <div className="plus-dependency-picker">
          <div className="plus-dependency-search">
            <input
              type="text"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={matches.length > 0}
              aria-controls={matches.length ? listId : undefined}
              aria-activedescendant={
                matches[active] ? `${listId}-${active}` : undefined
              }
              aria-label={text.searchTasks}
              placeholder={text.searchTasks}
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveId("");
              }}
              onKeyDown={onKeyDown}
            />
            <button className="plus-text-button" onClick={close}>
              {text.cancel}
            </button>
          </div>
          {matches.length > 0 && (
            <ul
              id={listId}
              role="listbox"
              aria-label={text.dependencies}
              className="plus-dependency-options"
            >
              {matches.map((match, position) => (
                <li
                  key={match.task.id}
                  id={`${listId}-${position}`}
                  role="option"
                  aria-selected={position === active}
                  aria-disabled={match.refusal ? true : undefined}
                  className={position === active ? "is-active" : undefined}
                  // The search field keeps focus, so arrows and Enter keep working.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => {
                    if (!match.refusal) setActiveId(match.task.id);
                  }}
                  onClick={() => void choose(match)}
                >
                  <span className="plus-dependency-option-title">
                    {displayedTitle(match.task.title)}
                  </span>
                  <span className="plus-dependency-option-note">
                    {match.refusal === "cycle"
                      ? text.wouldCycle
                      : match.refusal === "repeats"
                        ? text.repeatsForever
                        : match.path}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {query.trim() && !matches.length && (
            <p className="plus-muted plus-dependency-note">{text.noMatches}</p>
          )}
        </div>
      ) : (
        <button
          ref={addButton}
          className="plus-text-button plus-dependency-add"
          disabled={busy || full}
          title={full ? text.dependencyLimit : undefined}
          onClick={() => {
            setActiveId("");
            setPicking(true);
          }}
        >
          <Plus size={12} />
          {text.addDependency}
        </button>
      )}
    </div>
  );
}
