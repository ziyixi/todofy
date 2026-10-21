import {
  Fragment,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { duration, elapsed, formattedMinutes } from "./domain";
import { words } from "./i18n";
import type { FocusState, Language } from "./model";

type Timer = NonNullable<FocusState["timer"]>;

/** The rule under the time: how far along (0 to 1), its band, and its label. */
export interface MiniRule {
  band: "none" | "on" | "near" | "over";
  progress: number;
  label: string;
}

/**
 * A pomodoro measures its time against its length. A count-up measures the step's logged time (`logged`
 * seconds: its records on the session's day and this session) against its estimate (`estimate` minutes, 0 for
 * none), as Focus's card does; past the estimate, progress is where the estimate falls on the logged time.
 */
export function miniRule(
  timer: Timer,
  seconds: number,
  logged: number,
  estimate: number,
  language: Language,
): MiniRule {
  const text = words(language);
  if (timer.mode === "pomodoro" && timer.targetSeconds)
    return {
      band: "on",
      progress: seconds / timer.targetSeconds,
      label: formattedMinutes(timer.targetSeconds / 60),
    };
  if (!estimate) return { band: "none", progress: 0, label: "" };
  const target = estimate * 60;
  if (logged > target)
    return {
      band: "over",
      progress: target / logged,
      label: text.over(Math.ceil((logged - target) / 60)),
    };
  const progress = logged / target;
  return progress >= 0.9
    ? {
        band: "near",
        progress,
        label: text.left(Math.ceil((target - logged) / 60)),
      }
    : { band: "on", progress, label: formattedMinutes(estimate) };
}

// 24-unit glyphs drawn for the 1.25px hairline the stylesheet gives them.
const PAUSE = <path d="M9.25 6.5v11M14.75 6.5v11" />;
const PLAY = (
  <path d="M8.5 6.6v10.8a.6.6 0 0 0 .9.52l8.9-5.4a.6.6 0 0 0 0-1.04L9.4 6.08a.6.6 0 0 0-.9.52z" />
);
const STOP = <rect x="7" y="7" width="10" height="10" rx="1.5" />;
const CHECK = <path d="m5.75 12.4 4 4L18.25 7.9" />;

function Control({
  label,
  title,
  busy,
  onClick,
  children,
}: {
  label: string;
  title: string;
  busy: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={`${label}: ${title}`}
      title={label}
      disabled={busy}
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}

export interface MiniTimerProps {
  /**
   * The mini timer's window, whose own timers tick the clock: the opener's run late while it is hidden or
   * minimised, which is when the mini timer is looked at.
   */
  clock: Window;
  language: Language;
  /** Focus with its session; the time shown is `elapsed(focus)`. */
  focus: FocusState & { timer: Timer };
  /** The step's title; undefined when no step is known, which shows "Focus". */
  title?: string;
  /** Its outcome's title, when the outcome is not the step itself. */
  outcome?: string;
  /** The step's estimate in minutes, 0 for none. */
  estimate: number;
  /** The step's records on the session's day, in seconds. */
  recorded: number;
  /** A write waits: every control is disabled. */
  busy: boolean;
  /** The last write failed: one line in the rule's place, until the next write. */
  failed: boolean;
  onTimer: (action: "pause" | "resume" | "stop") => void;
  /** Completes the step; absent when Plan does not list it. */
  onComplete?: () => void;
  /** Pause when away's question, while it waits: it fills the window, with Keep and Discard in the controls' place. */
  away?: { minutes: number; keep: () => void; discard: () => void };
}

/**
 * The Focus mini timer (Document Picture-in-Picture): the time as the one large thing, the step over it, its
 * controls beside it on hover or keyboard focus, and a hairline rule of the step's time against its estimate.
 * Away, the question takes the step's line and its answers the controls' place. mini-timer.css styles exactly this
 * DOM. It re-renders only itself, once a second while the session runs.
 */
export function MiniTimer({
  clock,
  language,
  focus,
  title,
  outcome,
  estimate,
  recorded,
  busy,
  failed,
  onTimer,
  onComplete,
  away,
}: MiniTimerProps) {
  const [, tick] = useState(0);
  const timer = focus.timer;
  const running = timer.status === "running";
  useEffect(() => {
    if (!running) return;
    const started = Date.parse(timer.startedAt);
    let id = 0;
    // Each tick lands just after the session's next whole second, so the shown second never lags.
    const schedule = () => {
      const into = Number.isNaN(started)
        ? 0
        : (((Date.now() - started) % 1000) + 1000) % 1000;
      id = clock.setTimeout(() => {
        tick((value) => value + 1);
        schedule();
      }, 1000 - into);
    };
    schedule();
    return () => clock.clearTimeout(id);
  }, [clock, running, timer.startedAt]);
  const text = words(language);
  const seconds = elapsed(focus);
  // A pomodoro shows the time left.
  const time = duration(
    timer.mode === "pomodoro" && timer.targetSeconds
      ? timer.targetSeconds - seconds
      : seconds,
  );
  const rule = miniRule(timer, seconds, recorded + seconds, estimate, language);
  const name = title ?? text.focus;
  return (
    <div
      className="mini"
      lang={language}
      data-status={timer.status}
      data-progress={rule.band}
      data-away={away ? "" : undefined}
      aria-busy={busy}
      style={
        {
          // Work and Personal fill in their colour; an unassigned step in the muted tone.
          ...(timer.area !== "unassigned" && {
            "--area-color": `var(--plus-area-${timer.area})`,
          }),
          "--progress": rule.progress,
        } as CSSProperties
      }
    >
      {outcome && <p className="mini-outcome">{outcome}</p>}
      <p className={`mini-title${title ? "" : " is-fallback"}`} title={title}>
        {name}
      </p>
      {away && (
        <p className="mini-message mini-question" role="status">
          {text.away(away.minutes)}
        </p>
      )}
      <div className="mini-time" role="timer" data-lead={time[0]}>
        {time.split(":").map((part, index) => (
          <Fragment key={index}>
            {index > 0 && <span className="mini-colon">:</span>}
            {part}
          </Fragment>
        ))}
      </div>
      {away ? (
        <div className="mini-answers">
          <button type="button" disabled={busy} onClick={away.keep}>
            {text.keep}
          </button>
          <button type="button" disabled={busy} onClick={away.discard}>
            {text.discard}
          </button>
        </div>
      ) : (
        <>
          <span className="mini-status">{running ? "" : text.paused}</span>
          <div className="mini-controls">
            <Control
              label={running ? text.pause : text.resume}
              title={name}
              busy={busy}
              onClick={() => onTimer(running ? "pause" : "resume")}
            >
              {running ? PAUSE : PLAY}
            </Control>
            <Control
              label={text.stop}
              title={name}
              busy={busy}
              onClick={() => onTimer("stop")}
            >
              {STOP}
            </Control>
            {onComplete && (
              <Control
                label={text.complete}
                title={name}
                busy={busy}
                onClick={onComplete}
              >
                {CHECK}
              </Control>
            )}
          </div>
        </>
      )}
      {failed ? (
        <p className="mini-message mini-error">{text.notSaved}</p>
      ) : (
        <div className="mini-foot">
          <div className="mini-rule" aria-hidden="true">
            <i className="mini-fill" />
          </div>
          {rule.label && <span className="mini-label">{rule.label}</span>}
        </div>
      )}
    </div>
  );
}
