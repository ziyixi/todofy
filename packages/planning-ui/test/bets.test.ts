import { expect, it, vi } from "vitest";
import { Code, RpcError, statusBody } from "@ziyixi/proto/rpc-status";
import { fakeActions } from "./transport";
import {
  BET_MAX_LENGTH,
  BetNotSaved,
  betText,
  saveBet,
  weeklyBet,
  withBets,
} from "../src/bets";
import { createPrototype } from "./fixture";
import type { Confirmed, WeeklyBet } from "../src/model";

const WORK: WeeklyBet = {
  weekStart: "2026-10-12",
  area: "work",
  text: "Ship the draft",
  etag: "1",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const refusal = (code: Code, reason: string) =>
  json(
    statusBody(new RpcError(code, reason, "synthetic refusal"), {
      domain: "todofy.ziyixi.science",
    }),
    code === Code.ABORTED ? 409 : 400,
  );

it("keeps a Bet to one trimmed line, as Tasks stores it", () => {
  expect(betText("  Ship\n the\t\tdraft \u0000")).toBe("Ship the draft");
  expect(betText("周末　去徒步")).toBe("周末 去徒步");
  expect(betText(" \n ")).toBe("");
  // The input's maxlength and Todofy count the same UTF-16 code units.
  expect("😀".repeat(80)).toHaveLength(BET_MAX_LENGTH);
});

it("finds a week's Bet or an empty one, and replaces saved ones by week and area", () => {
  const personal = { ...WORK, area: "personal" as const, etag: "4" };
  expect(weeklyBet([WORK, personal], "2026-10-12", "personal")).toBe(personal);
  expect(weeklyBet([WORK], "2026-10-19", "work")).toEqual({
    weekStart: "2026-10-19",
    area: "work",
    text: "",
    etag: "",
  });
  const changed = { ...WORK, text: "Changed", etag: "2" };
  expect(withBets([WORK, personal], [changed])).toEqual([personal, changed]);
});

it("saves in the write queue and says why a refused Bet was not saved", async () => {
  const actions = createPrototype();
  const merged: Confirmed[] = [];
  const run = vi.fn(async (operation: () => Promise<Confirmed>) => {
    merged.push(await operation());
    return true;
  });
  const bet = weeklyBet(
    (await actions.readPlan()).weeklyBets,
    "2026-10-12",
    "work",
  );
  expect(await saveBet(run, actions, { ...bet, text: "Saved here" })).toBe(
    "saved",
  );
  expect(merged.pop()).toEqual({ ...bet, text: "Saved here", etag: "3" });
  // The etag shown is out of date: the latest Bets are read, to show before saving again.
  expect(await saveBet(run, actions, { ...bet, text: "From an old tab" })).toBe(
    "changed",
  );
  expect(merged.pop()).toContainEqual({
    ...bet,
    text: "Saved here",
    etag: "3",
  });
  // Last week's has ended: nothing to merge, so the queue reads the plan again.
  const ended = { ...bet, weekStart: "2026-10-05", text: "Too late" };
  expect(await saveBet(run, actions, ended)).toBe("ended");
  expect(merged.pop()).toBeUndefined();
  // Any other failure is the queue's: its banner says the change was not confirmed.
  const failing = vi.fn(async (operation: () => Promise<Confirmed>) => {
    await operation().catch(() => {});
    return false;
  });
  vi.spyOn(actions, "setWeeklyBet").mockRejectedValueOnce(new Error("down"));
  expect(await saveBet(failing, actions, { ...bet, text: "Lost" })).toBe(
    "failed",
  );
});

it("sends UpdateWeeklyBet with no request ID and maps Tasks' refusals", async () => {
  const bodies: unknown[] = [];
  const answers = [
    json({
      name: "weeklyBets/2026-10-12-work",
      week_start: "2026-10-12",
      area: "work",
      text: "Ship the draft",
      etag: "1",
      update_time: "2026-10-14T16:00:00Z",
    }),
    refusal(Code.ABORTED, "ETAG_MISMATCH"),
    refusal(Code.FAILED_PRECONDITION, "PRECONDITION_FAILED"),
    refusal(Code.INVALID_ARGUMENT, "BAD_REQUEST"),
  ];
  const api = fakeActions(
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname + url.search).toBe(
        "/api/tasks/v1/weeklyBets/2026-10-12-work?update_mask=text",
      );
      expect(init?.method).toBe("PATCH");
      bodies.push(JSON.parse(String(init?.body)));
      return answers.shift()!;
    }),
  );
  expect(await api.setWeeklyBet(WORK)).toEqual(WORK);
  expect(bodies[0]).toEqual({ text: "Ship the draft" });
  await expect(api.setWeeklyBet(WORK)).rejects.toEqual(
    new BetNotSaved("changed"),
  );
  await expect(api.setWeeklyBet(WORK)).rejects.toMatchObject({
    reason: "ended",
  });
  const other = await api.setWeeklyBet(WORK).catch((error: unknown) => error);
  expect(other).not.toBeInstanceOf(BetNotSaved);
});

it("reads the plan's Bets and leaves out an area this build does not know", async () => {
  const api = fakeActions(
    vi.fn<typeof fetch>(async () =>
      json({
        name: "plan",
        time_zone: "UTC",
        week_start: "2026-10-12",
        weekly_bets: [
          {
            week_start: "2026-10-05",
            area: "personal",
            text: "Rest",
            etag: "2",
          },
          { week_start: "2026-10-12", area: "work", etag: "3" },
          { week_start: "2026-10-12", area: "family", text: "x", etag: "1" },
        ],
      }),
    ),
  );
  expect((await api.readPlan()).weeklyBets).toEqual([
    { weekStart: "2026-10-05", area: "personal", text: "Rest", etag: "2" },
    { weekStart: "2026-10-12", area: "work", text: "", etag: "3" },
  ]);
});
