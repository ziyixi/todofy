/**
 * Pause when away, the decision alone: when the owner leaves a running count-up (the screen locks, no input for
 * AWAY_AFTER_MS, or the machine sleeps), Focus pauses it in Tasks at the moment they left; only when they are back
 * does it ask whether to count that time (gone again before answering, it waits for the next return). Keep resumes at
 * the pause time, as if the session never paused; Discard resumes now.
 *
 * Pure and clock-free: useIdlePause.ts feeds it the detector's readings, a heartbeat and the confirmed timer, with
 * the time of each, and sends the commands it answers through App's write queue.
 */

/** No input for this long is away; it is also the detector's threshold (the API's minimum is 60 s). */
export const AWAY_AFTER_MS = 600_000;
/**
 * The main window's heartbeat. A gap of AWAY_AFTER_MS between beats means the machine slept (or Chrome froze the
 * page) since the last one: a hidden page's timers still run at least once a minute.
 */
export const BEAT_MS = 15_000;

/** What the idle detector last reported. */
export interface Reading {
  /** userState is "idle": no input for AWAY_AFTER_MS. */
  idle: boolean;
  /** screenState is "locked". */
  locked: boolean;
}
/** The confirmed timer, as far as pausing is concerned. */
export interface WatchedTimer {
  taskId: string;
  etag: string;
  /** A running count-up: the only session paused when away. */
  countingUp: boolean;
  /** When a paused session paused (ms). */
  pausedAt?: number;
}
export type Phase =
  /** Not watching: no permission or setting, another window watches, or no count-up runs. */
  | { name: "off" }
  /** A count-up runs; the owner has not been seen active and unlocked since, so nothing pauses yet. */
  | { name: "arming" }
  | { name: "watching" }
  /** The owner left at `since`: its Pause is in flight (`sending`) or waits for the next beat. */
  | {
      name: "pausing";
      taskId: string;
      since: number;
      sending: boolean;
      returnedAt?: number;
    }
  /** Paused by this window, the owner still away. */
  | { name: "away"; etag: string; pausedAt: number }
  /** The owner is back and the question shows; `answered` while its Resume is in flight. */
  | {
      name: "asking";
      etag: string;
      pausedAt: number;
      returnedAt: number;
      answered: boolean;
    };
export interface IdleState {
  phase: Phase;
  /** Watching is allowed: the setting is on, the browser allows it and this window holds the watch. */
  allowed: boolean;
  timer?: WatchedTimer;
  /** Undefined until the detector reports. */
  reading?: Reading;
  lastBeat: number;
}
export type IdleEvent =
  | { type: "allow"; allowed: boolean; at: number }
  | { type: "timer"; timer?: WatchedTimer; at: number }
  | { type: "reading"; reading?: Reading; at: number }
  | { type: "beat"; at: number }
  /** This window's Pause was confirmed. */
  | { type: "paused"; etag: string; pausedAt: number }
  /** This window's Pause or Resume failed. */
  | { type: "failed"; at: number }
  | { type: "answer"; keep: boolean };
/**
 * A timer command: Pause at `at` (`retry` when an earlier one failed, which stays silent), or Resume at `at`, or
 * now without it.
 */
export type IdleCommand =
  | { action: "pause"; at: number; retry: boolean }
  | { action: "resume"; at?: number };

const OFF: Phase = { name: "off" };
export const IDLE_START: IdleState = {
  phase: OFF,
  allowed: false,
  lastBeat: 0,
};

/** The question's minutes: from the pause to the return, at least one. */
export function awayMinutes(phase: { pausedAt: number; returnedAt: number }) {
  return Math.max(1, Math.round((phase.returnedAt - phase.pausedAt) / 60_000));
}
function back(reading: Reading | undefined): boolean {
  return Boolean(reading && !reading.idle && !reading.locked);
}
/** A reading says the owner is not here: a stopped detector's silence says nothing. */
function gone(reading: Reading | undefined): boolean {
  return Boolean(reading && (reading.idle || reading.locked));
}
function asking(etag: string, pausedAt: number, returnedAt: number): Phase {
  return { name: "asking", etag, pausedAt, returnedAt, answered: false };
}
/**
 * The owner left again before answering: the question waits for the next return, so while they are away the bar
 * says Paused. An answer already in flight is left to its own confirmation.
 */
function leftAgain(phase: Phase): Phase | undefined {
  if (phase.name === "asking" && !phase.answered)
    return { name: "away", etag: phase.etag, pausedAt: phase.pausedAt };
  if (phase.name === "pausing" && phase.returnedAt !== undefined)
    return {
      name: "pausing",
      taskId: phase.taskId,
      since: phase.since,
      sending: phase.sending,
    };
  return undefined;
}
/** A confirmed Pause: the question at once when the owner is already back. */
function paused(
  pausing: { returnedAt?: number },
  etag: string,
  pausedAt: number,
): Phase {
  return pausing.returnedAt === undefined
    ? { name: "away", etag, pausedAt }
    : asking(etag, pausedAt, pausing.returnedAt);
}
/** Off, arming and watching follow the setting, the timer and the last reading. */
function settle(state: IdleState, at: number): IdleState {
  const { phase } = state;
  if (!["off", "arming", "watching"].includes(phase.name)) return state;
  if (!state.allowed || !state.timer?.countingUp)
    return phase.name === "off" ? state : { ...state, phase: OFF };
  // What is seen when watching begins is a baseline: idle or locked then is not a departure.
  if (phase.name === "off")
    return {
      ...state,
      lastBeat: at,
      phase: { name: back(state.reading) ? "watching" : "arming" },
    };
  if (phase.name === "arming" && back(state.reading))
    return { ...state, phase: { name: "watching" } };
  return state;
}
/** While watching: the earliest moment any sign says the owner left, and the Pause at it. */
function detect(state: IdleState, at: number): [IdleState, IdleCommand?] {
  const since: number[] = [];
  if (at - state.lastBeat >= AWAY_AFTER_MS) since.push(state.lastBeat);
  if (state.reading?.idle) since.push(at - AWAY_AFTER_MS);
  if (state.reading?.locked) since.push(at);
  if (!since.length || !state.timer) return [state];
  const pausing: Phase = {
    name: "pausing",
    taskId: state.timer.taskId,
    since: Math.min(...since),
    sending: true,
    // Only a heartbeat gap can find the owner already back: the machine slept and woke with them.
    ...(back(state.reading) ? { returnedAt: at } : {}),
  };
  return [
    { ...state, phase: pausing },
    { action: "pause", at: pausing.since, retry: false },
  ];
}
/** A Pause not in flight, once the timer changed or the Pause failed. */
function waitingPause(
  state: IdleState,
  phase: Extract<Phase, { name: "pausing" }>,
  at: number,
): IdleState {
  const timer = state.timer;
  if (timer?.taskId === phase.taskId) {
    // It landed though its answer was lost: the session paused at exactly that moment.
    if (timer.pausedAt === phase.since)
      return { ...state, phase: paused(phase, timer.etag, phase.since) };
    // The next beat tries again, at the same moment.
    if (timer.countingUp) return { ...state, phase };
  }
  // Paused, stopped or completed elsewhere.
  return settle({ ...state, phase: OFF }, at);
}

export function idleStep(
  state: IdleState,
  event: IdleEvent,
): [IdleState, IdleCommand?] {
  const { phase } = state;
  switch (event.type) {
    case "allow": {
      const next = { ...state, allowed: event.allowed };
      // No longer watched (the setting was turned off here): a pause made stays, and the owner is here to answer.
      if (!event.allowed && phase.name === "away")
        return [
          { ...next, phase: asking(phase.etag, phase.pausedAt, event.at) },
        ];
      if (!event.allowed && phase.name === "pausing")
        return [{ ...next, phase: { ...phase, returnedAt: event.at } }];
      return [settle(next, event.at)];
    }
    case "timer": {
      const next = { ...state, timer: event.timer };
      // A Pause in flight is decided by its own answer.
      if (phase.name === "pausing")
        return [phase.sending ? next : waitingPause(next, phase, event.at)];
      // The question belongs to its pause: any other change of the timer drops it.
      if (phase.name === "away" || phase.name === "asking")
        return event.timer?.etag === phase.etag
          ? [next]
          : [settle({ ...next, phase: OFF }, event.at)];
      return [settle(next, event.at)];
    }
    case "reading": {
      const next = { ...state, reading: event.reading };
      // A detector that stopped reports nothing; the next one's first reading is a new baseline.
      if (phase.name === "watching" && event.reading)
        return detect(next, event.at);
      if (gone(event.reading)) {
        const left = leftAgain(phase);
        return [left ? { ...next, phase: left } : settle(next, event.at)];
      }
      if (!back(event.reading)) return [settle(next, event.at)];
      // Back: the latest return is the one the question counts to.
      if (phase.name === "pausing" || phase.name === "asking")
        return [{ ...next, phase: { ...phase, returnedAt: event.at } }];
      if (phase.name === "away")
        return [
          { ...next, phase: asking(phase.etag, phase.pausedAt, event.at) },
        ];
      return [settle(next, event.at)];
    }
    case "beat": {
      if (phase.name === "watching") {
        const [next, command] = detect(state, event.at);
        return [{ ...next, lastBeat: event.at }, command];
      }
      const next = { ...state, lastBeat: event.at };
      if (phase.name === "pausing" && !phase.sending && state.timer?.countingUp)
        return [
          { ...next, phase: { ...phase, sending: true } },
          { action: "pause", at: phase.since, retry: true },
        ];
      return [next];
    }
    case "paused":
      return phase.name === "pausing"
        ? [{ ...state, phase: paused(phase, event.etag, event.pausedAt) }]
        : [state];
    case "failed":
      if (phase.name === "pausing")
        return [waitingPause(state, { ...phase, sending: false }, event.at)];
      // The answer failed: the question takes one again, or on the next return when the owner left meanwhile.
      if (phase.name === "asking")
        return [
          {
            ...state,
            phase: gone(state.reading)
              ? { name: "away", etag: phase.etag, pausedAt: phase.pausedAt }
              : { ...phase, answered: false },
          },
        ];
      return [state];
    case "answer":
      if (phase.name !== "asking" || phase.answered) return [state];
      return [
        { ...state, phase: { ...phase, answered: true } },
        event.keep
          ? { action: "resume", at: phase.pausedAt }
          : { action: "resume" },
      ];
  }
}
