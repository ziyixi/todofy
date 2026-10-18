import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { duration, elapsed } from "./domain";
import { words } from "./i18n";
import type { FocusState, Language } from "./model";

/** The running clock re-renders only itself once per second, not the board around it. */
export function Elapsed({ focus }: { focus: FocusState }) {
  const [, tick] = useState(0);
  const running = focus.timer?.status === "running";
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
  const seconds = elapsed(focus);
  return duration(
    focus.timer?.mode === "pomodoro" && focus.timer.targetSeconds
      ? Math.max(0, focus.timer.targetSeconds - seconds)
      : seconds,
  );
}

/** Marks a card whose change is not yet confirmed, or not yet shown by a re-read. */
export function PendingMark({ language }: { language: Language }) {
  return (
    <LoaderCircle
      size={12}
      className="plus-spin plus-pending-mark"
      role="img"
      aria-label={words(language).updating}
    />
  );
}
