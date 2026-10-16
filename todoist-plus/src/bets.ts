import type { BetArea, PlusActions, RunOperation, WeeklyBet } from "./model";

/** The Bets' areas, in the order they are shown. */
export const BET_AREAS: readonly BetArea[] = ["work", "personal"];
/** In UTF-16 code units, as the input's maxlength counts them and Todofy checks. */
export const BET_MAX_LENGTH = 160;
/** The character count is shown once this many or fewer remain. */
export const BET_COUNT_FROM = 20;

/** Why Todofy did not save a Bet: it changed elsewhere since it was shown, or its week has ended. */
export class BetNotSaved extends Error {
  constructor(readonly reason: "changed" | "ended") {
    super(
      reason === "changed"
        ? "This goal was changed elsewhere."
        : "That week has ended.",
    );
  }
}
/** What a save did: saved, refused as BetNotSaved says, or failed (the error banner says why). */
export type BetOutcome = "saved" | BetNotSaved["reason"] | "failed";

/**
 * The text as Todofy stores it (core/plan.py bet_text): one line, each run of whitespace or
 * control characters one space, trimmed. Empty means no Bet.
 */
export function betText(value: string): string {
  return value.replace(/[\p{Cc}\s]+/gu, " ").trim();
}

/** The saved Bet of a week and area, or an empty one to write the first. */
export function weeklyBet(
  bets: readonly WeeklyBet[],
  week: string,
  area: BetArea,
): WeeklyBet {
  return (
    bets.find((bet) => bet.weekStart === week && bet.area === area) ?? {
      weekStart: week,
      area,
      text: "",
      etag: "",
    }
  );
}

/** The Bets with each of `saved` in place of the one of its week and area. */
export function withBets(
  bets: readonly WeeklyBet[],
  saved: readonly WeeklyBet[],
): WeeklyBet[] {
  const key = (bet: WeeklyBet) => `${bet.weekStart}:${bet.area}`;
  const replaced = new Set(saved.map(key));
  return [...bets.filter((bet) => !replaced.has(key(bet))), ...saved];
}

/**
 * Saves `bet.text` over the Bet with `bet.etag`, in the write queue. When it changed elsewhere,
 * the latest Bets are read and shown, so saving again replaces them knowingly; when its week has
 * ended, the plan is read again.
 */
export async function saveBet(
  run: RunOperation,
  actions: PlusActions,
  bet: WeeklyBet,
): Promise<BetOutcome> {
  let outcome: BetOutcome = "failed";
  await run(async () => {
    try {
      const saved = await actions.setWeeklyBet(bet);
      outcome = "saved";
      return saved;
    } catch (error) {
      if (!(error instanceof BetNotSaved)) throw error;
      outcome = error.reason;
      if (error.reason === "changed")
        return (await actions.readPlan()).weeklyBets;
      // Nothing to merge: the re-read that follows shows the new week.
    }
  });
  return outcome;
}
