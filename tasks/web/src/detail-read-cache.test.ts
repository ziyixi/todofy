import { afterEach, expect, it, vi } from "vitest";
import {
  clearDetailReadCache,
  peekDetailRead,
  readDetail,
} from "./detail-read-cache";

afterEach(() => {
  clearDetailReadCache();
  vi.useRealTimers();
});

it("reuses confirmed detail reads for thirty seconds without extending their freshness", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const load = vi.fn(async () => ({
    description: "Full synthetic description",
    etag: "1",
  }));
  const first = await readDetail("task:example", load);
  vi.setSystemTime(30_999);
  expect(await readDetail("task:example", load)).toBe(first);
  expect(load).toHaveBeenCalledTimes(1);
  vi.setSystemTime(31_000);
  expect(peekDetailRead("task:example")).toBeUndefined();
  await readDetail("task:example", load);
  expect(load).toHaveBeenCalledTimes(2);
});

it("bounds the page cache to twenty recently used detail entries", async () => {
  for (let index = 0; index < 20; index++)
    await readDetail(`task:${String(index)}`, async () => index);
  expect(peekDetailRead("task:0")).toBe(0);
  await readDetail("planning:new:1", async () => ({ flags: ["task"] }));
  expect(peekDetailRead("task:1")).toBeUndefined();
  expect(peekDetailRead("task:0")).toBe(0);
  expect(peekDetailRead("task:19")).toBe(19);
});

it("shares a pending read and prevents its late answer from replacing a newer value after invalidation", async () => {
  let resolve!: (value: string) => void;
  const load = vi.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  const first = readDetail("task:example", load);
  expect(readDetail("task:example", load)).toBe(first);
  await Promise.resolve();
  expect(load).toHaveBeenCalledTimes(1);
  clearDetailReadCache();
  await readDetail("task:example", async () => "fresh");
  resolve("older");
  expect(await first).toBe("older");
  expect(peekDetailRead("task:example")).toBe("fresh");
});

it("does not preserve failed or missing detail replies", async () => {
  await expect(
    readDetail("task:example", async () => {
      throw new Error("Synthetic dependency failure");
    }),
  ).rejects.toThrow();
  expect(peekDetailRead("task:example")).toBeUndefined();
  await readDetail("planning:example:1", async () => undefined);
  expect(peekDetailRead("planning:example:1")).toBeUndefined();
  expect(await readDetail("planning:example:1", async () => "available")).toBe(
    "available",
  );
});

it("lets the next user read replace an expired pending request without accepting its late answer", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  let resolve!: (value: string) => void;
  const load = vi.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  const pending = readDetail("task:example", load);
  await Promise.resolve();
  vi.setSystemTime(30_999);
  expect(readDetail("task:example", load)).toBe(pending);
  expect(load).toHaveBeenCalledTimes(1);
  vi.setSystemTime(32_000);
  expect(await readDetail("task:example", async () => "fresh")).toBe("fresh");
  resolve("older");
  expect(await pending).toBe("older");
  expect(peekDetailRead("task:example")).toBe("fresh");
});
