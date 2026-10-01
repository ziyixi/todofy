/**
 * One request at a time per host (../../docs/design.md §4), inside WatchState. The host's row (store.ts `hosts`)
 * spaces the starts of two requests HOST_SPACING_MS apart, which keeps a 15-second request from overlapping the next
 * one; this lock makes it hold however the clock moves, between an alarm's lanes and the owner's previews alike (the
 * object's input gate stays open while a request is out). It lives in memory: an evicted object has nothing in flight.
 */
export class HostLocks {
  private readonly held = new Map<string, Promise<void>>();

  /** Waits until no request to `host` is in flight, then holds it; the returned function frees it (once). */
  async acquire(host: string): Promise<() => void> {
    for (let busy = this.held.get(host); busy !== undefined; busy = this.held.get(host)) await busy;
    let free: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      free = resolve;
    });
    this.held.set(host, done);
    let freed = false;
    return () => {
      if (freed) return;
      freed = true;
      if (this.held.get(host) === done) this.held.delete(host);
      free();
    };
  }

  /** Whether a request to `host` is in flight. */
  busy(host: string): boolean {
    return this.held.has(host);
  }
}
