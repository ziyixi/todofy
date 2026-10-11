/**
 * One alarm's budgets (../../docs/design.md §14): the subrequests it may still make (Workers Free allows 50 per
 * invocation; the brief keeps ALARM_SUBREQUESTS and makes no retries inside an invocation) and its wall time, with its
 * own AbortSignal under the platform's 15-minute alarm limit. Every external request takes one subrequest first and
 * passes the step's signal, so a step that runs out of either stops cleanly, commits what it has, and goes on in the
 * next alarm.
 */

export class StepBudget {
  private left: number;
  readonly startedAt: number;
  readonly deadline: number;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout> | null;
  private readonly clock: () => number;

  constructor(subrequests: number, wallMs: number, clock: () => number = Date.now, armTimer = true) {
    this.left = subrequests;
    this.clock = clock;
    this.startedAt = clock();
    this.deadline = this.startedAt + wallMs;
    this.timer = armTimer
      ? setTimeout(() => {
          this.controller.abort(new Error('step_deadline'));
        }, wallMs)
      : null;
  }

  /** The signal that aborts when the step's wall time is spent. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Subrequests left. */
  get subrequests(): number {
    return this.left;
  }

  /** Takes `n` subrequests if they are left. */
  take(n = 1): boolean {
    if (this.left < n) return false;
    this.left -= n;
    return true;
  }

  /** Gives back a subrequest taken for a request that was not sent. */
  give(n = 1): void {
    this.left += n;
  }

  has(n: number): boolean {
    return this.left >= n;
  }

  /** Wall time left in milliseconds (0 when spent). */
  timeLeft(): number {
    return Math.max(0, this.deadline - this.clock());
  }

  /** Whether the step should stop now: its wall time or its subrequests are spent. */
  spent(reserveMs = 0): boolean {
    return this.left <= 0 || this.timeLeft() <= reserveMs || this.controller.signal.aborted;
  }

  /** Clears the timer (always call at the end of the step). */
  close(): void {
    if (this.timer !== null) clearTimeout(this.timer);
  }
}

/** Sleeps `ms` unless `signal` aborts first; answers false when it aborted. */
export function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!signal.aborted);
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
