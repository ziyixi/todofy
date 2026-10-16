import { afterEach, expect, it, vi } from "vitest";
import { BetNotSaved } from "../src/bets";
import { extensionActions } from "../src/client";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("wxt/browser", () => ({ browser: { runtime: { sendMessage } } }));
afterEach(() => sendMessage.mockReset());

it("asks for a real Todoist reload when an extension update invalidates the content script", async () => {
  sendMessage.mockRejectedValue(new Error("Extension context invalidated."));
  await expect(extensionActions.load()).rejects.toThrow(
    "Extension updated. Reload Todoist to continue.",
  );
  expect(sendMessage).toHaveBeenCalledOnce();
});

it("keeps ordinary transport failures unchanged", async () => {
  const failure = new Error("Synthetic transport failure");
  sendMessage.mockRejectedValue(failure);
  await expect(extensionActions.loadDays("2026-10-19")).rejects.toBe(failure);
  expect(sendMessage).toHaveBeenCalledOnce();
});
it("marks new action messages so a stale content script cannot use changed planning semantics", async () => {
  sendMessage.mockResolvedValue({ ok: true, value: [] });
  await extensionActions.loadDays("2026-10-19");
  expect(sendMessage).toHaveBeenCalledWith({
    kind: "action",
    protocol: 5,
    method: "loadDays",
    args: ["2026-10-19"],
  });
});

it("throws a Bet the background could not save again as BetNotSaved, with its reason", async () => {
  const bet = {
    weekStart: "2026-10-12",
    area: "work" as const,
    text: "Synthetic goal",
    etag: "1",
  };
  sendMessage.mockResolvedValueOnce({ ok: true, value: { ...bet, etag: "2" } });
  await expect(extensionActions.setWeeklyBet(bet)).resolves.toEqual({
    ...bet,
    etag: "2",
  });
  sendMessage.mockResolvedValueOnce({ ok: true, value: { notSaved: "ended" } });
  const refused = await extensionActions
    .setWeeklyBet(bet)
    .catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(BetNotSaved);
  expect(refused).toMatchObject({ reason: "ended" });
  expect(sendMessage).toHaveBeenLastCalledWith({
    kind: "action",
    protocol: 5,
    method: "setWeeklyBet",
    args: [bet],
  });
});
