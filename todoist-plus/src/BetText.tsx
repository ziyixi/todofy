import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  BET_COUNT_FROM,
  BET_MAX_LENGTH,
  betText,
  type BetOutcome,
} from "./bets";
import { PendingMark } from "./StatusMarks";
import type { BetWords } from "./i18n";
import type { Language, WeeklyBet } from "./model";

interface Props {
  bet: WeeklyBet;
  copy: BetWords;
  language: Language;
  /**
   * Starting an edit, or keeping last week's, waits while writes or a re-read are pending. The
   * buttons are only marked then (aria-disabled): a disabled button would drop the focus that Tab
   * just moved to it from the other line's input, whose save is one of those writes.
   */
  disabled: boolean;
  /** Saves `bet.text` over `bet.etag`. */
  save: (bet: WeeklyBet) => Promise<BetOutcome>;
  /** Reads a confirmed change out to screen readers. */
  announce: (message: string) => void;
  /** Last week's text, offered to keep while this one is empty (the Plan's own week only). */
  previous?: string;
}

/**
 * One week's Bet, edited in place: the text is its own edit button, and editing swaps in a
 * one-line input at the same place. Enter saves (not while an input method composes) and Esc
 * restores, both returning focus to the text. Moving focus elsewhere in the page saves a changed,
 * non-empty text; switching windows keeps the draft open, and leaving the input empty never
 * clears: only Enter on an empty input does. A refusal keeps the draft with its reason, and then
 * only Enter or Esc decides.
 */
export function BetText({
  bet,
  copy,
  language,
  disabled,
  save,
  announce,
  previous,
}: Props) {
  // The Bet the edit started from: a save replaces its etag, so a change that arrives from
  // elsewhere meanwhile is refused instead of overwritten unseen.
  const [editing, setEditing] = useState<WeeklyBet>();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<"changed" | "ended">();
  const [refocus, setRefocus] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // Set once Enter or Esc decides the edit, so the blur of the removed input saves nothing.
  const settled = useRef(false);
  // One save at a time, also for a second event that arrives before the re-render.
  const writing = useRef(false);
  const mounted = useRef(false);
  const hintId = useId();
  const noticeId = useId();
  const isEditing = editing !== undefined;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    const field = input.current;
    if (!isEditing || !field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [isEditing]);
  useEffect(() => {
    if (!refocus || isEditing) return;
    button.current?.focus();
    setRefocus(false);
  }, [refocus, isEditing]);

  function open() {
    settled.current = false;
    setEditing(bet);
    setDraft(bet.text);
    setNotice(undefined);
  }
  function close(focusText: boolean) {
    settled.current = true;
    setEditing(undefined);
    setNotice(undefined);
    if (focusText) setRefocus(true);
  }
  async function write(next: WeeklyBet): Promise<BetOutcome | undefined> {
    if (writing.current) return undefined;
    writing.current = true;
    setSaving(true);
    try {
      return await save(next);
    } finally {
      writing.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  async function commit(how: "enter" | "blur") {
    if (!editing || notice === "ended") return;
    const text = betText(draft);
    if (text === bet.text) return close(how === "enter");
    if (!text && how === "blur") return close(false);
    // After "changed elsewhere" the newest Bet is on screen, and Enter replaces that one.
    const outcome = await write({
      ...(notice === "changed" ? bet : editing),
      text,
    });
    if (!outcome || !mounted.current) return;
    if (outcome === "saved") {
      announce(text ? copy.saved : copy.cleared);
      close(how === "enter");
    } else if (outcome !== "failed") setNotice(outcome);
    // A failure keeps the draft; the error banner says it was not saved.
  }
  async function keep(text: string) {
    const outcome = await write({ ...bet, text });
    if (!outcome || !mounted.current) return;
    if (outcome === "saved") announce(copy.kept);
    // Saved, or changed elsewhere: the goal it shows now is where focus belongs.
    if (outcome === "saved" || outcome === "changed") setRefocus(true);
  }

  const waiting = disabled || saving;
  if (editing) {
    const left = BET_MAX_LENGTH - draft.length;
    return (
      <div className="plus-bet">
        <div className="plus-bet-field">
          <input
            ref={input}
            className="plus-bet-input"
            aria-label={copy.label}
            aria-describedby={notice ? `${hintId} ${noticeId}` : hintId}
            maxLength={BET_MAX_LENGTH}
            placeholder={copy.placeholder}
            value={draft}
            readOnly={saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229)
                return;
              if (event.key === "Enter") {
                event.preventDefault();
                void commit("enter");
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (!saving) close(true);
              }
            }}
            onBlur={() => {
              // Another window or application took focus: the draft waits for the owner.
              if (
                settled.current ||
                !mounted.current ||
                notice ||
                !document.hasFocus()
              )
                return;
              void commit("blur");
            }}
          />
          {saving && <PendingMark language={language} />}
        </div>
        <p className="plus-bet-hint" id={hintId}>
          {copy.hint}
          {left <= BET_COUNT_FROM && copy.left(left)}
        </p>
        {notice && (
          <p className="plus-bet-notice" id={noticeId} role="alert">
            {copy[notice]}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="plus-bet">
      <button
        ref={button}
        className={bet.text ? "plus-bet-text" : "plus-bet-empty"}
        aria-label={bet.text ? copy.edit(bet.text) : undefined}
        aria-disabled={waiting || undefined}
        onClick={() => {
          if (!waiting) open();
        }}
      >
        {bet.text || copy.empty}
      </button>
      {!bet.text && previous && (
        <div className="plus-bet-previous">
          <span title={previous}>{copy.previous(previous)}</span>
          <button
            className="plus-bet-keep"
            aria-label={copy.keepName(previous)}
            aria-disabled={waiting || undefined}
            onClick={() => {
              if (!waiting) void keep(previous);
            }}
          >
            {copy.keep}
          </button>
          {saving && <PendingMark language={language} />}
        </div>
      )}
    </div>
  );
}
