import { useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown, RefreshCw, Search, Target } from "lucide-react";
import { describeError } from "../api";
import {
  clearGoalCatalogCache,
  loadGoalCatalog,
  type GoalCatalog,
} from "../goals-client";
import "./goal-picker.css";

export interface GoalPickerProps {
  value: string;
  title?: string;
  onChange: (id: string, title: string) => void;
  onOpenGoal?: () => void;
  disabled?: boolean;
  label?: string;
}

export function GoalPicker({
  value,
  title,
  onChange,
  onOpenGoal,
  disabled,
  label = "Associated goal",
}: GoalPickerProps) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<GoalCatalog>();
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const portal = useRef<HTMLElement | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);

  async function load(refresh = false) {
    const current = ++requestId.current;
    if (refresh) clearGoalCatalogCache();
    setLoading(true);
    setError("");
    try {
      const read = await loadGoalCatalog();
      if (current === requestId.current) setCatalog(read);
    } catch (reason) {
      if (current === requestId.current) setError(describeError(reason));
    } finally {
      if (current === requestId.current) setLoading(false);
    }
  }
  const query = search.trim().toLocaleLowerCase();
  const objectives = new Map(
    catalog?.objectives.map((objective) => [objective.id, objective]) ?? [],
  );
  const matches =
    catalog?.keyResults.filter(
      (result) =>
        !result.archived &&
        !result.objectiveArchived &&
        `${result.title} ${objectives.get(result.objectiveId)?.title ?? ""}`
          .toLocaleLowerCase()
          .includes(query),
    ) ?? [];
  function choose(id: string, selectedTitle: string) {
    onChange(id, selectedTitle);
    setOpen(false);
  }
  return (
    <div className="goal-property">
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
            setSearch("");
            void load();
          }
        }}
      >
        <Popover.Trigger
          className="goal-picker-trigger"
          disabled={disabled}
          aria-label={label}
          ref={(element: HTMLButtonElement | null) => {
            portal.current = element?.closest("dialog") ?? null;
          }}
        >
          <Target size={14} />
          <span>{value ? title || "Linked goal" : label}</span>
          <ChevronDown size={12} />
        </Popover.Trigger>
        <Popover.Portal container={portal}>
          <Popover.Positioner
            align="start"
            sideOffset={5}
            positionMethod="fixed"
            className="goal-picker-positioner"
          >
            <Popover.Popup
              className="goal-picker-popup"
              aria-label="Goal picker"
              initialFocus={input}
            >
              <div className="goal-picker-search">
                <Search size={14} />
                <input
                  ref={input}
                  aria-label="Search goals"
                  placeholder="Search goals"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.preventDefault();
                  }}
                />
                <button
                  type="button"
                  aria-label="Refresh goals"
                  disabled={loading}
                  onClick={() => void load(true)}
                >
                  <RefreshCw size={13} />
                </button>
              </div>
              <div className="goal-picker-options" aria-busy={loading}>
                <button
                  type="button"
                  className="goal-picker-option"
                  onClick={() => choose("", "")}
                >
                  <span>No goal</span>
                  {!value && <Check size={14} />}
                </button>
                {loading ? (
                  <p className="goal-picker-message">Loading goals…</p>
                ) : error ? (
                  <p className="goal-picker-message" role="alert">
                    {error}
                  </p>
                ) : (
                  matches.map((result) => (
                    <button
                      type="button"
                      className="goal-picker-option"
                      key={result.id}
                      onClick={() => choose(result.id, result.title)}
                    >
                      <span>
                        {result.title}
                        <small>
                          {objectives.get(result.objectiveId)?.title}
                        </small>
                      </span>
                      {value === result.id && <Check size={14} />}
                    </button>
                  ))
                )}
                {!loading && !error && !matches.length && (
                  <p className="goal-picker-message">No matching goals</p>
                )}
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {value && (
        <a
          className="goal-reference-link"
          href={`#/goals/${encodeURIComponent(value)}`}
          aria-label={`Open goal: ${title || "Linked goal"}`}
          onClick={onOpenGoal}
        >
          Open
        </a>
      )}
    </div>
  );
}
