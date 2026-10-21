import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  launchConsumer,
  readLaunch,
  useLaunchQueue,
  type Launch,
} from "./launch";

const ORIGIN = "https://tasks.example.test";
const nothing: Launch = {
  hash: "",
  taskId: "",
  review: false,
  mailId: "",
  quickAdd: false,
};

afterEach(() => {
  cleanup();
  delete window.launchQueue;
});

it("reads what each inbound URL asks for", () => {
  // Todofy's GTD mail (and its /task/<id> redirect): the task, over the current page.
  expect(readLaunch(`${ORIGIN}/?task=abc`, ORIGIN)).toEqual({
    ...nothing,
    taskId: "abc",
  });
  // The weekly review mail, with and without its route: Plan's checklist.
  expect(readLaunch(`${ORIGIN}/?review=1#/plan`, ORIGIN)).toEqual({
    ...nothing,
    hash: "#/plan",
    review: true,
  });
  expect(readLaunch(`${ORIGIN}/?review=1`, ORIGIN)).toEqual({
    ...nothing,
    hash: "#/plan",
    review: true,
  });
  // A long mail task's link to the mail's full summary.
  expect(readLaunch(`${ORIGIN}/?mail=event-1#/mail`, ORIGIN)).toEqual({
    ...nothing,
    hash: "#/mail",
    mailId: "event-1",
  });
  // Home's tile only focuses the window.
  expect(readLaunch(`${ORIGIN}/`, ORIGIN)).toEqual(nothing);
  expect(readLaunch(`${ORIGIN}/#`, ORIGIN)).toEqual(nothing);
  // The Dock's shortcuts.
  expect(readLaunch(`${ORIGIN}/#/focus`, ORIGIN)).toEqual({
    ...nothing,
    hash: "#/focus",
  });
  expect(readLaunch(`${ORIGIN}/?add=1`, ORIGIN)).toEqual({
    ...nothing,
    quickAdd: true,
  });
  // Other parameters are ignored.
  expect(readLaunch(`${ORIGIN}/?add=0&utm=x#/today`, ORIGIN)).toEqual({
    ...nothing,
    hash: "#/today",
  });
});

it("ignores a URL outside this origin or one that does not parse", () => {
  expect(readLaunch("https://other.example.test/?task=abc", ORIGIN)).toBe(
    undefined,
  );
  expect(readLaunch("not a url", ORIGIN)).toBe(undefined);
});

it("skips only a first launch that loaded this document", () => {
  const act = vi.fn();
  const consume = launchConsumer(`${ORIGIN}/?add=1`, ORIGIN, act);
  consume({ targetURL: `${ORIGIN}/?add=1` });
  expect(act).not.toHaveBeenCalled();
  // Quick add again from the Dock: the same URL acts this time.
  consume({ targetURL: `${ORIGIN}/?add=1` });
  expect(act).toHaveBeenCalledExactlyOnceWith({ ...nothing, quickAdd: true });
});

it("acts on a first launch to another URL than the one loaded", () => {
  const act = vi.fn();
  const consume = launchConsumer(`${ORIGIN}/#/today`, ORIGIN, act);
  consume({ targetURL: `${ORIGIN}/?task=abc` });
  consume({ targetURL: `${ORIGIN}/#/today` });
  consume({});
  expect(act.mock.calls).toEqual([
    [{ ...nothing, taskId: "abc" }],
    [{ ...nothing, hash: "#/today" }],
  ]);
});

it("sets one consumer that calls the latest handler, and does nothing without launchQueue", () => {
  const first = vi.fn();
  const latest = vi.fn();
  // Without the API (a plain browser), the hook only renders.
  const plain = renderHook(() => useLaunchQueue(first));
  plain.unmount();
  const setConsumer = vi.fn();
  window.launchQueue = { setConsumer };
  const { rerender } = renderHook(({ handler }) => useLaunchQueue(handler), {
    initialProps: { handler: first },
  });
  rerender({ handler: latest });
  expect(setConsumer).toHaveBeenCalledOnce();
  const consume = setConsumer.mock.calls[0]![0] as (params: {
    targetURL?: string;
  }) => void;
  // This document's own URL (jsdom's) is the launch that loaded it.
  consume({ targetURL: window.location.href });
  consume({ targetURL: `${window.location.origin}/#/plan` });
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledExactlyOnceWith({
    ...nothing,
    hash: "#/plan",
  });
});
