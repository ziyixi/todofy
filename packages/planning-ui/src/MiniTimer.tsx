import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Check, Pause, Play, Square } from "lucide-react";
import { duration, elapsed, formattedMinutes } from "./domain";
import { words } from "./i18n";
import type { FocusState, Language } from "./model";

type Timer = NonNullable<FocusState["timer"]>;

/** The rule under the time: how far along (0 to 1), its band, and its label. */
export interface MiniRule {
  band: "none" | "on" | "near" | "over";
  progress: number;
  /** Near or past the estimate, the minutes left or over; otherwise empty, and the ratio shows. */
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
    return { band: "on", progress: seconds / timer.targetSeconds, label: "" };
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
    : { band: "on", progress, label: "" };
}

function Control({
  label,
  title,
  busy,
  onClick,
  children,
  primary,
}: {
  label: string;
  title: string;
  busy: boolean;
  onClick: () => void;
  children: ReactNode;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={primary ? "mini-primary" : undefined}
      aria-label={`${label}: ${title}`}
      title={label}
      disabled={busy}
      onClick={onClick}
    >
      {children}
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
 * A compact session: task identity, a steady clock, visible controls and logged time against the estimate.
 * The same content reflows down to Chrome's 64px viewport. Only this component ticks once a second.
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
  const pomodoro = timer.mode === "pomodoro" && Boolean(timer.targetSeconds);
  const total = pomodoro ? seconds : recorded + seconds;
  const target = pomodoro ? (timer.targetSeconds ?? 0) / 60 : estimate;
  const clockLabel = pomodoro ? text.miniRemaining : text.miniSession;
  const ratio = target
    ? `${formattedMinutes(Math.floor(total / 60))} / ${formattedMinutes(target)}`
    : "";
  const progressLabel = rule.label || ratio;
  return (
    <div
      className="mini"
      lang={language}
      data-status={timer.status}
      data-progress={rule.band}
      data-away={away ? "" : undefined}
      data-failed={failed ? "" : undefined}
      aria-busy={busy}
      style={
        {
          // Work and Personal fill in their colour; an unassigned step in the muted tone.
          ...(timer.area !== "unassigned" && {
            "--area-color": `var(--plus-area-${timer.area})`,
          }),
          "--progress": Math.max(0, Math.min(1, rule.progress)),
        } as CSSProperties
      }
    >
      <div className="mini-heading">
        {outcome && (
          <p className="mini-outcome" title={outcome}>
            {outcome}
          </p>
        )}
        {away ? (
          <p className="mini-message mini-question" role="status">
            {text.away(away.minutes)}
          </p>
        ) : (
          <>
            <p
              className={`mini-title${title ? "" : " is-fallback"}`}
              title={title && outcome ? `${outcome} / ${title}` : title}
            >
              {name}
            </p>
            <span className="mini-status">
              <span className="mini-mode">
                {running ? clockLabel : text.paused}
              </span>
              {running && ratio && (
                <span className="mini-compact-label" aria-hidden="true">
                  {ratio}
                </span>
              )}
            </span>
          </>
        )}
      </div>
      <div className="mini-time" role="timer" aria-label={clockLabel}>
        {time}
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
          <div className="mini-controls">
            <Control
              primary
              label={running ? text.pause : text.resume}
              title={name}
              busy={busy}
              onClick={() => onTimer(running ? "pause" : "resume")}
            >
              {running ? <Pause /> : <Play />}
            </Control>
            <Control
              label={text.stop}
              title={name}
              busy={busy}
              onClick={() => onTimer("stop")}
            >
              <Square />
            </Control>
            {onComplete && (
              <Control
                label={text.complete}
                title={name}
                busy={busy}
                onClick={onComplete}
              >
                <Check />
              </Control>
            )}
          </div>
        </>
      )}
      {failed ? (
        <p className="mini-message mini-error" role="alert">
          {text.notSaved}
        </p>
      ) : (
        <div className="mini-foot">
          {target > 0 && (
            <div
              className="mini-rule"
              role="progressbar"
              aria-label={text.miniProgress}
              aria-valuemin={0}
              aria-valuemax={target}
              aria-valuenow={Math.min(target, total / 60)}
              aria-valuetext={ratio}
            >
              <i className="mini-fill" />
            </div>
          )}
          <span
            className="mini-label"
            title={target ? text.miniProgress : undefined}
          >
            {progressLabel || text.unknown}
          </span>
        </div>
      )}
    </div>
  );
}
