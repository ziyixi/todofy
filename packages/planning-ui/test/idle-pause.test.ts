import { expect, it } from "vitest";
import {
  AWAY_AFTER_MS,
  BEAT_MS,
  IDLE_START,
  awayMinutes,
  idleStep,
  type IdleCommand,
  type IdleEvent,
  type IdleState,
  type WatchedTimer,
} from "../src/idle-pause";

// The decision alone, on a fake clock: every event carries its time.
const T0 = Date.parse("2026-10-20T09:00:00Z");
const MIN = 60_000;
const running: WatchedTimer = { taskId: "step", etag: "r1", countingUp: true };
const active = { idle: false, locked: false };
const idle = { idle: true, locked: false };
const locked = { idle: false, locked: true };

/** Plays `events` from `from`: the last state and every command sent. */
function play(events: IdleEvent[], from: IdleState = IDLE_START) {
  let state = from;
  const commands: IdleCommand[] = [];
  for (const event of events) {
    const [next, command] = idleStep(state, event);
    state = next;
    if (command) commands.push(command);
  }
  return { state, commands };
}
/** The heartbeat from `from` up to `to`, as the main window's interval beats. */
function beats(from: number, to: number): IdleEvent[] {
  const events: IdleEvent[] = [];
  for (let at = from + BEAT_MS; at <= to; at += BEAT_MS)
    events.push({ type: "beat", at });
  return events;
}
/** A count-up runs, watching is allowed and the owner was seen active at T0. */
function watching(): IdleState {
  const { state } = play([
    { type: "timer", timer: running, at: T0 },
    { type: "allow", allowed: true, at: T0 },
    { type: "reading", reading: active, at: T0 },
  ]);
  expect(state.phase).toEqual({ name: "watching" });
  return state;
}
/** Paused by this window at `pausedAt` (etag p1), the owner back at `returnedAt`: the question shows. */
function asking(pausedAt = T0 + 5 * MIN, returnedAt = T0 + 17 * MIN) {
  const { state } = play(
    [
      { type: "reading", reading: locked, at: pausedAt },
      { type: "paused", etag: "p1", pausedAt },
      { type: "reading", reading: active, at: returnedAt },
    ],
    watching(),
  );
  expect(state.phase).toEqual({
    name: "asking",
    etag: "p1",
    pausedAt,
    returnedAt,
    answered: false,
  });
  return state;
}

it("pauses at the moment the screen locked, and asks when the owner is back", () => {
  const locking = play(
    [{ type: "reading", reading: locked, at: T0 + 5 * MIN }],
    watching(),
  );
  expect(locking.commands).toEqual([
    { action: "pause", at: T0 + 5 * MIN, retry: false },
  ]);
  const away = play(
    [{ type: "paused", etag: "p1", pausedAt: T0 + 5 * MIN }],
    locking.state,
  );
  expect(away.state.phase).toEqual({
    name: "away",
    etag: "p1",
    pausedAt: T0 + 5 * MIN,
  });
  // Its own pause confirmed by a read changes nothing; the return asks.
  const asked = play(
    [
      {
        type: "timer",
        timer: { ...running, etag: "p1", countingUp: false, pausedAt: T0 + 5 * MIN },
        at: T0 + 6 * MIN,
      },
      { type: "reading", reading: active, at: T0 + 17 * MIN + 20_000 },
    ],
    away.state,
  );
  expect(asked.commands).toEqual([]);
  expect(asked.state.phase).toMatchObject({
    name: "asking",
    returnedAt: T0 + 17 * MIN + 20_000,
  });
  expect(awayMinutes(asked.state.phase as never)).toBe(12);
});

it("an idle report pauses ten minutes before it, and a lock after it keeps the earlier moment", () => {
  const { state, commands } = play(
    [
      ...beats(T0, T0 + 20 * MIN),
      { type: "reading", reading: idle, at: T0 + 20 * MIN },
      { type: "reading", reading: { idle: true, locked: true }, at: T0 + 22 * MIN },
    ],
    watching(),
  );
  expect(commands).toEqual([
    { action: "pause", at: T0 + 20 * MIN - AWAY_AFTER_MS, retry: false },
  ]);
  expect(state.phase).toMatchObject({ name: "pausing", since: T0 + 10 * MIN });
});

it("several signs at once pause at the earliest", () => {
  expect(
    play(
      [
        ...beats(T0, T0 + 30 * MIN),
        { type: "reading", reading: { idle: true, locked: true }, at: T0 + 30 * MIN },
      ],
      watching(),
    ).commands,
  ).toEqual([{ action: "pause", at: T0 + 20 * MIN, retry: false }]);
});

it("a heartbeat gap of ten minutes pauses at the last beat; a shorter one does nothing", () => {
  const beats = play(
    [
      { type: "beat", at: T0 + BEAT_MS },
      { type: "beat", at: T0 + BEAT_MS + AWAY_AFTER_MS - 1 },
    ],
    watching(),
  );
  expect(beats.commands).toEqual([]);
  const last = T0 + BEAT_MS + AWAY_AFTER_MS - 1;
  // The machine slept; it wakes with the owner at it, so the question follows the confirmed pause at once.
  const woke = play(
    [{ type: "beat", at: last + 40 * MIN }],
    beats.state,
  );
  expect(woke.commands).toEqual([{ action: "pause", at: last, retry: false }]);
  const asked = play(
    [{ type: "paused", etag: "p1", pausedAt: last }],
    woke.state,
  );
  expect(asked.state.phase).toEqual({
    name: "asking",
    etag: "p1",
    pausedAt: last,
    returnedAt: last + 40 * MIN,
    answered: false,
  });
  // A detector report first after the sleep finds the gap too.
  expect(
    play(
      [{ type: "reading", reading: locked, at: T0 + 25 * MIN }],
      watching(),
    ).commands,
  ).toEqual([{ action: "pause", at: T0, retry: false }]);
});

it("a detector that stops sends nothing, even long after the last beat", () => {
  expect(
    play(
      [{ type: "reading", reading: undefined, at: T0 + 30 * MIN }],
      watching(),
    ).commands,
  ).toEqual([]);
});

it("idle or locked when watching begins arms: nothing pauses until the owner is seen active and unlocked", () => {
  const armed = play([
    { type: "timer", timer: running, at: T0 },
    { type: "allow", allowed: true, at: T0 },
    { type: "reading", reading: idle, at: T0 },
    { type: "reading", reading: locked, at: T0 + MIN },
    { type: "beat", at: T0 + 40 * MIN },
  ]);
  expect(armed.commands).toEqual([]);
  expect(armed.state.phase).toEqual({ name: "arming" });
  const later = play(
    [
      { type: "reading", reading: active, at: T0 + 41 * MIN },
      ...beats(T0 + 40 * MIN, T0 + 50 * MIN),
      { type: "reading", reading: locked, at: T0 + 50 * MIN },
    ],
    armed.state,
  );
  expect(later.commands).toEqual([
    { action: "pause", at: T0 + 50 * MIN, retry: false },
  ]);
  // Before the detector reports, it arms too.
  expect(
    play([
      { type: "timer", timer: running, at: T0 },
      { type: "allow", allowed: true, at: T0 },
    ]).state.phase,
  ).toEqual({ name: "arming" });
});

it("a return before the pause is confirmed asks right after it", () => {
  const { state } = play(
    [
      { type: "reading", reading: locked, at: T0 + 5 * MIN },
      { type: "reading", reading: active, at: T0 + 9 * MIN },
      { type: "paused", etag: "p1", pausedAt: T0 + 5 * MIN },
    ],
    watching(),
  );
  expect(state.phase).toMatchObject({
    name: "asking",
    pausedAt: T0 + 5 * MIN,
    returnedAt: T0 + 9 * MIN,
  });
  expect(awayMinutes(state.phase as never)).toBe(4);
});

it("a failed pause tries again on the next beat at the same moment, while that session still counts up", () => {
  const failed = play(
    [
      { type: "reading", reading: locked, at: T0 + 5 * MIN },
      { type: "failed", at: T0 + 30 * MIN },
      { type: "timer", timer: { ...running, etag: "r2" }, at: T0 + 30 * MIN },
    ],
    watching(),
  );
  expect(failed.commands).toHaveLength(1);
  const retried = play([{ type: "beat", at: T0 + 30 * MIN + BEAT_MS }], failed.state);
  expect(retried.commands).toEqual([
    { action: "pause", at: T0 + 5 * MIN, retry: true },
  ]);
  // Its answer was lost, but the timer paused at exactly that moment: it was this pause.
  const lost = play(
    [
      { type: "failed", at: T0 + 31 * MIN },
      {
        type: "timer",
        timer: { ...running, etag: "p2", countingUp: false, pausedAt: T0 + 5 * MIN },
        at: T0 + 31 * MIN,
      },
    ],
    retried.state,
  );
  expect(lost.state.phase).toEqual({
    name: "away",
    etag: "p2",
    pausedAt: T0 + 5 * MIN,
  });
  // Paused or stopped elsewhere instead: nothing more is sent.
  const elsewhere = play(
    [
      {
        type: "timer",
        timer: { ...running, etag: "p3", countingUp: false, pausedAt: T0 + 20 * MIN },
        at: T0 + 31 * MIN,
      },
      { type: "beat", at: T0 + 32 * MIN },
    ],
    failed.state,
  );
  expect(elsewhere.commands).toEqual([]);
  expect(elsewhere.state.phase).toEqual({ name: "off" });
});

it("any other change of the timer drops the question", () => {
  const resumed = play(
    [{ type: "timer", timer: { ...running, etag: "r9" }, at: T0 + 20 * MIN }],
    asking(),
  );
  // Resumed elsewhere while the owner is here: watching again.
  expect(resumed.state.phase).toEqual({ name: "watching" });
  expect(
    play([{ type: "timer", timer: undefined, at: T0 + 20 * MIN }], asking())
      .state.phase,
  ).toEqual({ name: "off" });
  // The same etag (a read that changed nothing) keeps it.
  expect(
    play(
      [
        {
          type: "timer",
          timer: { ...running, etag: "p1", countingUp: false, pausedAt: T0 + 5 * MIN },
          at: T0 + 20 * MIN,
        },
      ],
      asking(),
    ).state.phase,
  ).toMatchObject({ name: "asking" });
});

it("a pomodoro is never paused", () => {
  const { state, commands } = play([
    { type: "timer", timer: { ...running, countingUp: false }, at: T0 },
    { type: "allow", allowed: true, at: T0 },
    { type: "reading", reading: active, at: T0 },
    { type: "reading", reading: locked, at: T0 + MIN },
    { type: "beat", at: T0 + 30 * MIN },
  ]);
  expect(commands).toEqual([]);
  expect(state.phase).toEqual({ name: "off" });
});

it("turned off while away, it asks at once; turned off while watching, it stops", () => {
  const away = play(
    [
      { type: "reading", reading: locked, at: T0 + 5 * MIN },
      { type: "paused", etag: "p1", pausedAt: T0 + 5 * MIN },
      { type: "allow", allowed: false, at: T0 + 8 * MIN },
    ],
    watching(),
  );
  expect(away.state.phase).toMatchObject({
    name: "asking",
    returnedAt: T0 + 8 * MIN,
  });
  expect(
    play([{ type: "allow", allowed: false, at: T0 + MIN }], watching()).state
      .phase,
  ).toEqual({ name: "off" });
  // A pause in flight asks once it is confirmed.
  const inFlight = play(
    [
      { type: "reading", reading: locked, at: T0 + 5 * MIN },
      { type: "allow", allowed: false, at: T0 + 7 * MIN },
      { type: "paused", etag: "p1", pausedAt: T0 + 5 * MIN },
    ],
    watching(),
  );
  expect(inFlight.state.phase).toMatchObject({
    name: "asking",
    returnedAt: T0 + 7 * MIN,
  });
});

it("Keep resumes at the pause time, Discard now; one answer at a time", () => {
  const kept = play(
    [
      { type: "answer", keep: true },
      { type: "answer", keep: false },
    ],
    asking(),
  );
  expect(kept.commands).toEqual([{ action: "resume", at: T0 + 5 * MIN }]);
  // It failed: the question takes an answer again.
  const discarded = play(
    [
      { type: "failed", at: T0 + 20 * MIN },
      { type: "answer", keep: false },
    ],
    kept.state,
  );
  expect(discarded.commands).toEqual([{ action: "resume" }]);
  // Confirmed: the resumed session is watched again.
  expect(
    play(
      [{ type: "timer", timer: { ...running, etag: "r3" }, at: T0 + 21 * MIN }],
      discarded.state,
    ).state.phase,
  ).toEqual({ name: "watching" });
});

it("a second absence while the question waits sends nothing, shows Paused while away and counts to the latest return", () => {
  const gone = play(
    [
      { type: "reading", reading: locked, at: T0 + 20 * MIN },
      { type: "beat", at: T0 + 60 * MIN },
    ],
    asking(),
  );
  expect(gone.commands).toEqual([]);
  // Still away: no question until the owner is back.
  expect(gone.state.phase).toEqual({
    name: "away",
    etag: "p1",
    pausedAt: T0 + 5 * MIN,
  });
  const { state, commands } = play(
    [{ type: "reading", reading: active, at: T0 + 65 * MIN }],
    gone.state,
  );
  expect(commands).toEqual([]);
  expect(state.phase).toEqual({
    name: "asking",
    etag: "p1",
    pausedAt: T0 + 5 * MIN,
    returnedAt: T0 + 65 * MIN,
    answered: false,
  });
  expect(awayMinutes(state.phase as never)).toBe(60);
  // No input for the threshold while it waits is gone again too.
  expect(
    play([{ type: "reading", reading: idle, at: T0 + 27 * MIN }], asking())
      .state.phase,
  ).toMatchObject({ name: "away" });
  // A detector that stops says nothing about the owner: the question stays.
  expect(
    play([{ type: "reading", reading: undefined, at: T0 + 20 * MIN }], asking())
      .state.phase,
  ).toMatchObject({ name: "asking" });
});

it("back and gone again before the pause is confirmed: it confirms to Paused, and the next return asks", () => {
  const { state } = play(
    [
      { type: "reading", reading: locked, at: T0 + 5 * MIN },
      { type: "reading", reading: active, at: T0 + 9 * MIN },
      { type: "reading", reading: locked, at: T0 + 10 * MIN },
      { type: "paused", etag: "p1", pausedAt: T0 + 5 * MIN },
    ],
    watching(),
  );
  expect(state.phase).toEqual({
    name: "away",
    etag: "p1",
    pausedAt: T0 + 5 * MIN,
  });
  expect(
    play([{ type: "reading", reading: active, at: T0 + 30 * MIN }], state)
      .state.phase,
  ).toMatchObject({ name: "asking", returnedAt: T0 + 30 * MIN });
});

it("an answer in flight is left to its confirmation when the owner leaves; failed, the next return asks", () => {
  const sent = play(
    [
      { type: "answer", keep: true },
      { type: "reading", reading: locked, at: T0 + 18 * MIN },
    ],
    asking(),
  );
  expect(sent.state.phase).toMatchObject({ name: "asking", answered: true });
  expect(
    play([{ type: "failed", at: T0 + 19 * MIN }], sent.state).state.phase,
  ).toEqual({ name: "away", etag: "p1", pausedAt: T0 + 5 * MIN });
});

it("counts the minutes away rounded, at least one", () => {
  expect(awayMinutes({ pausedAt: T0, returnedAt: T0 + 20_000 })).toBe(1);
  expect(awayMinutes({ pausedAt: T0, returnedAt: T0 + 90_000 })).toBe(2);
  expect(awayMinutes({ pausedAt: T0, returnedAt: T0 + 89_999 })).toBe(1);
});
