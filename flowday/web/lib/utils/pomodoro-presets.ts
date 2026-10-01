import { formatDuration } from "./time";

const BASE_MINS = [5, 30, 45, 60, 90, 120] as const;

// Floor for the suggested preset — once you've already burned most of the
// estimate, a 1-2m sprint is just noise; round up to a real working block.
export const MIN_SUGGESTED_MINS = 5;

export type PomodoroPreset = {
  mins: number;
  label: string;
  suggested?: boolean;
};

// Build the preset list with the task's own estimate (minus already-logged
// time) prepended and deduplicated. Surfacing "estimate − logged" first means
// a one-click pomodoro that finishes the task, rather than always offering the
// full estimate even after several rounds.
export function buildPomodoroPresets(
  estimatedMins?: number | null,
  loggedMins?: number | null
): PomodoroPreset[] {
  const base: PomodoroPreset[] = BASE_MINS.map((mins) => ({
    mins,
    label: formatDuration(mins),
  }));
  if (!estimatedMins || estimatedMins <= 0) return base;
  const remaining = Math.max(
    estimatedMins - Math.max(loggedMins ?? 0, 0),
    MIN_SUGGESTED_MINS
  );
  const filtered = base.filter((p) => p.mins !== remaining);
  return [
    { mins: remaining, label: formatDuration(remaining), suggested: true },
    ...filtered,
  ];
}
