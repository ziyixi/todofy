import { describe, expect, it } from "vitest";
import { AUTO_SYNC_INTERVAL_MS, RESYNC_ON_VISIBLE_AFTER_MS, startAutoSync } from "@/lib/hooks/auto-sync";

/** A fake clock and timer queue (one timer at a time, like the scheduler uses). */
function harness(visible = true) {
  let now = 1_000_000;
  let pending: { at: number; callback: () => void } | null = null;
  const syncs: number[] = [];
  const env = {
    visible,
    now: () => now,
    isVisible: () => env.visible,
    setTimer: (callback: () => void, ms: number) => {
      pending = { at: now + ms, callback };
      return pending;
    },
    clearTimer: () => {
      pending = null;
    },
    sync: () => {
      syncs.push(now);
    },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    while (pending && pending.at <= target) {
      const due = pending;
      pending = null;
      now = due.at;
      due.callback();
    }
    now = target;
  };
  return { env, syncs, advance, pending: () => pending, start: () => now };
}

describe("automatic Todoist sync scheduling", () => {
  it("syncs when the page opens, then every 10 minutes while visible", () => {
    const h = harness();
    const t0 = h.start();
    startAutoSync(h.env);
    h.advance(35 * 60_000);
    expect(h.syncs).toEqual([t0, t0 + AUTO_SYNC_INTERVAL_MS, t0 + 2 * AUTO_SYNC_INTERVAL_MS, t0 + 3 * AUTO_SYNC_INTERVAL_MS]);
  });

  it("does nothing while hidden: no sync on open, no timer, no polling", () => {
    const h = harness(false);
    startAutoSync(h.env);
    h.advance(60 * 60_000);
    expect(h.syncs).toEqual([]);
    expect(h.pending()).toBeNull();
  });

  it("stops when hidden and catches up on becoming visible when the last attempt is old enough", () => {
    const h = harness();
    const t0 = h.start();
    const auto = startAutoSync(h.env);
    h.advance(2 * 60_000);
    h.env.visible = false;
    auto.visibilityChanged();
    h.advance(3 * 60 * 60_000);
    expect(h.syncs).toEqual([t0]);
    h.env.visible = true;
    auto.visibilityChanged();
    expect(h.syncs).toHaveLength(2);
    h.advance(AUTO_SYNC_INTERVAL_MS);
    expect(h.syncs).toHaveLength(3);
  });

  it("a quick hide and show does not sync again before 5 minutes", () => {
    const h = harness();
    const auto = startAutoSync(h.env);
    h.env.visible = false;
    auto.visibilityChanged();
    h.advance(RESYNC_ON_VISIBLE_AFTER_MS - 1);
    h.env.visible = true;
    auto.visibilityChanged();
    expect(h.syncs).toHaveLength(1);
  });

  it("stop() cancels the timer", () => {
    const h = harness();
    const auto = startAutoSync(h.env);
    auto.stop();
    h.advance(60 * 60_000);
    expect(h.syncs).toHaveLength(1);
  });
});
