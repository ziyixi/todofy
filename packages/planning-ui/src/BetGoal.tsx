import { useState } from "react";
import { saveBet } from "./bets";
import type {
  Language,
  PlusActions,
  RenderGoalPicker,
  RunOperation,
  WeeklyBet,
} from "./model";

export function BetGoal({
  bet,
  language,
  disabled,
  renderGoalPicker,
  run,
  actions,
}: {
  bet: WeeklyBet;
  language: Language;
  disabled: boolean;
  renderGoalPicker?: RenderGoalPicker;
  run: RunOperation;
  actions: PlusActions;
}) {
  const [notice, setNotice] = useState("");
  const zh = language === "zh";
  const label = zh
    ? `${bet.area === "work" ? "工作" : "个人"}目标关联`
    : `${bet.area === "work" ? "Work" : "Personal"} associated goal`;
  if (!renderGoalPicker && !bet.keyResultId) return null;
  return (
    <div className="plus-bet-goal">
      {renderGoalPicker ? (
        renderGoalPicker({
          value: bet.keyResultId ?? "",
          title: bet.keyResultTitle,
          label,
          disabled,
          onChange: (keyResultId, keyResultTitle) => {
            setNotice("");
            void saveBet(
              run,
              actions,
              { ...bet, keyResultId, keyResultTitle },
              ["key_result_id"],
            ).then((outcome) => {
              if (outcome === "changed")
                setNotice(
                  zh
                    ? "目标已在别处更改，请重新选择。"
                    : "Changed elsewhere. Choose the goal again.",
                );
              else if (outcome === "ended")
                setNotice(zh ? "该周已结束。" : "That week has ended.");
            });
          },
        })
      ) : (
        <a href={`#/goals/${encodeURIComponent(bet.keyResultId!)}`}>
          {bet.keyResultTitle || (zh ? "关联目标" : "Linked goal")}
        </a>
      )}
      {notice && <span role="alert">{notice}</span>}
    </div>
  );
}
