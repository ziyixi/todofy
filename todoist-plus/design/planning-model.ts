export type Lane = "quarter" | "month" | "week" | "committed";
export type Area = "work" | "personal";

export interface Step {
  id: string;
  title: string;
  minutes: number;
  done?: boolean;
}

export interface Outcome {
  id: string;
  title: string;
  context: string;
  area: Area;
  lane: Lane;
  priority: number;
  mustStart?: boolean;
  deadline?: string;
  color: string;
  steps: Step[];
}

export interface PlanningData {
  weeklyGoals: Record<Area, string>;
  outcomes: Outcome[];
  queues: Record<string, string[]>;
}

export interface BoardLane {
  id: Lane;
  title: string;
  label: string;
}

// One personal board, backed by four ordinary labels in the eventual integration.
export const LANES: BoardLane[] = [
  { id: "quarter", title: "Quarter", label: "quarter" },
  { id: "month", title: "Month", label: "candiate" },
  { id: "week", title: "Week", label: "focus" },
  { id: "committed", title: "Committed", label: "committed" },
];

export const TODAY = "2026-10-13";
export const CURRENT_WEEK = "2026-10-12";

export function weekDates(start: string): string[] {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(`${start}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

export function shiftWeek(start: string, direction: number): string {
  const date = new Date(`${start}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + direction * 7);
  return date.toISOString().slice(0, 10);
}

export function moveOutcome(
  data: PlanningData,
  id: string,
  lane: Lane,
): PlanningData {
  return {
    ...data,
    outcomes: data.outcomes.map((outcome) =>
      outcome.id === id ? { ...outcome, lane } : outcome,
    ),
  };
}

export function moveStep(
  data: PlanningData,
  id: string,
  date: string,
  sourceDate?: string,
  beforeId?: string,
): PlanningData {
  if (id === beforeId) return data;
  const target = (data.queues[date] ?? []).filter((stepId) => stepId !== id);
  const before = beforeId ? target.indexOf(beforeId) : -1;
  const index = before < 0 ? target.length : before;
  const queues = {
    ...data.queues,
    [date]: [...target.slice(0, index), id, ...target.slice(index)],
  };
  if (sourceDate && sourceDate !== date) {
    queues[sourceDate] = (data.queues[sourceDate] ?? []).filter(
      (stepId) => stepId !== id,
    );
  }
  return { ...data, queues };
}

export function findStep(
  outcomes: Outcome[],
  id: string,
): { outcome: Outcome; step: Step } | undefined {
  for (const outcome of outcomes) {
    const step = outcome.steps.find((step) => step.id === id);
    if (step) return { outcome, step };
  }
}

export function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const extra = minutes % 60;
  return `${Math.floor(minutes / 60)}h${extra ? ` ${extra}m` : ""}`;
}
