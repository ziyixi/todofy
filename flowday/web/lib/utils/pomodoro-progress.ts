export function derivePomodoroLoggedSeconds(
  priorSeconds: number,
  pomodoroTargetSeconds: number | null,
  remainingSeconds: number
): number | null {
  if (pomodoroTargetSeconds == null) return null;
  return Math.max(priorSeconds + pomodoroTargetSeconds - remainingSeconds, 0);
}
