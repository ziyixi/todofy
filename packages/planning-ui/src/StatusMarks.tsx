import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { duration, elapsed, formattedMinutes } from "./domain";
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

/**
 * Logged time: saved records' `seconds`, plus a session's time so far when `session` is given (one
 * that counts on this day). It re-renders only itself once per second while the session runs, as
 * `clock` (35:12) when asked, else in whole minutes (35m), inside `label`.
 */
export function LoggedTime({
  seconds,
  session,
  clock = false,
  label,
}: {
  seconds: number;
  session?: FocusState;
  clock?: boolean;
  label: (time: string) => string;
}) {
  const [, tick] = useState(0);
  const running = session?.timer?.status === "running";
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
  const total = seconds + (session ? elapsed(session) : 0);
  return label(
    clock ? duration(total) : formattedMinutes(Math.floor(total / 60)),
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
