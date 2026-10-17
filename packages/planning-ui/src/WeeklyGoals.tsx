import { Target } from "lucide-react";
import { useAnnouncement } from "./announce";
import { BET_AREAS, saveBet, weeklyBet } from "./bets";
import { BetText } from "./BetText";
import { addDays } from "./domain";
import { betWords, words } from "./i18n";
import { weekLabel } from "./PlanningCalendar";
import type { Language, PlanState, PlusActions, RunOperation } from "./model";

interface Props {
  plan: PlanState;
  language: Language;
  busy: boolean;
  run: RunOperation;
  actions: PlusActions;
}

/**
 * This account week's Work and Personal Bets: one line of the owner's own text each, kept by
 * Todofy and tied to no task, edited in place. An empty one shows last week's, with Keep. The week
 * Week shows does not change them; next week's are written in Sunday's weekly review.
 */
export function WeeklyGoals({ plan, language, busy, run, actions }: Props) {
  const [announcement, setAnnouncement] = useAnnouncement();
  const zh = language === "zh";
  const text = words(language);
  const lastWeek = addDays(plan.week, -7);
  return (
    <section
      className="plus-weekly-goals"
      aria-label={zh ? "本周目标" : "Weekly goals"}
    >
      <header>
        <h2>
          <Target size={15} />
          {zh ? "本周目标" : "Weekly goals"}
        </h2>
        <span>{weekLabel(plan.week, language)}</span>
      </header>
      <div className="plus-weekly-goal-grid">
        {BET_AREAS.map((area) => (
          <div key={area} className="plus-weekly-goal-context">
            <h3>{text[area]}</h3>
            <BetText
              bet={weeklyBet(plan.weeklyBets, plan.week, area)}
              previous={weeklyBet(plan.weeklyBets, lastWeek, area).text}
              copy={betWords(language, area, "this")}
              language={language}
              disabled={busy}
              save={(bet) => saveBet(run, actions, bet)}
              announce={setAnnouncement}
            />
          </div>
        ))}
      </div>
      <p className="plus-sr-only" role="status">
        {announcement}
      </p>
    </section>
  );
}
