"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/utils/time";
import type { DailyTaskData } from "../contracts";

export const TASK_BREAKDOWN_CHUNK_MINS = 30;
export const TASK_BREAKDOWN_VISIBLE_CHUNKS = 8;
export const TASK_BREAKDOWN_VISIBLE_MINS =
  TASK_BREAKDOWN_CHUNK_MINS * TASK_BREAKDOWN_VISIBLE_CHUNKS;
export const TASK_BREAKDOWN_SCALE_LABEL = `${formatDuration(
  TASK_BREAKDOWN_CHUNK_MINS
)} chunks · capped at ${formatDuration(TASK_BREAKDOWN_VISIBLE_MINS)}`;
const TASK_BREAKDOWN_SEGMENTS = Array.from(
  { length: TASK_BREAKDOWN_VISIBLE_CHUNKS },
  (_, index) => index
);

export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function DateNav({
  label,
  onPrev,
  onNext,
  onToday,
  previousLabel = "Previous analytics period",
  nextLabel = "Next analytics period",
  todayLabel = "Jump to current analytics period",
}: {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  previousLabel?: string;
  nextLabel?: string;
  todayLabel?: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-background/35 p-1">
      <button
        onClick={onPrev}
        aria-label={previousLabel}
        title={previousLabel}
        className="fd-icon-button h-7 w-7"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <button
        onClick={onToday}
        aria-label={todayLabel}
        title={todayLabel}
        className="min-w-[180px] rounded-md px-2 py-1 text-center text-sm font-semibold text-foreground transition-colors hover:bg-accent/70"
      >
        {label}
      </button>
      <button
        onClick={onNext}
        aria-label={nextLabel}
        title={nextLabel}
        className="fd-icon-button h-7 w-7"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="fd-stat-card overflow-hidden rounded-md border px-3 py-2.5">
      <p className="truncate text-[10px] font-medium uppercase text-muted-foreground">
        {label}
      </p>
      <p className="truncate text-lg font-semibold tabular-nums text-foreground">
        {value}
        {sub && <span className="ml-1 text-xs font-normal text-muted-foreground">{sub}</span>}
      </p>
    </div>
  );
}

function getTaskBreakdownPercent(minutes: number) {
  if (minutes <= 0) return 0;
  return Math.min((minutes / TASK_BREAKDOWN_VISIBLE_MINS) * 100, 100);
}

export function TaskBar({ task }: { task: DailyTaskData }) {
  const estimated = task.estimatedMins ?? 0;
  const logged = task.loggedMins;
  const overflowMins = Math.max(Math.max(estimated, logged) - TASK_BREAKDOWN_VISIBLE_MINS, 0);

  return (
    <div className="space-y-1.5 rounded-md bg-background/30 p-2">
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "min-w-0 truncate text-xs font-medium",
            task.completed && "text-muted-foreground line-through"
          )}
        >
          {task.projectColor && (
            <span
              className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
              style={{ backgroundColor: task.projectColor }}
            />
          )}
          {task.title}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {overflowMins > 0 && (
            <span
              data-testid={`analytics-task-overflow-${task.id}`}
              className="rounded-full border border-border/60 bg-card/75 px-1.5 py-0.5 text-[9px] font-medium uppercase text-muted-foreground"
              title={`Beyond the visible ${formatDuration(TASK_BREAKDOWN_VISIBLE_MINS)} cap`}
            >
              +{formatDuration(overflowMins)}
            </span>
          )}
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {estimated > 0 && <span>{formatDuration(estimated)} est</span>}
            {estimated > 0 && logged > 0 && <span className="mx-1">→</span>}
            {logged > 0 && <span>{formatDuration(logged)}</span>}
          </span>
        </div>
      </div>
      <div
        className="relative h-2.5 overflow-hidden rounded-full"
        data-testid={`analytics-task-track-${task.id}`}
      >
        <div
          aria-hidden="true"
          className="absolute inset-0 grid gap-px"
          style={{
            gridTemplateColumns: `repeat(${TASK_BREAKDOWN_VISIBLE_CHUNKS}, minmax(0, 1fr))`,
          }}
        >
          {TASK_BREAKDOWN_SEGMENTS.map((segment) => (
            <span key={segment} className="bg-muted/85" />
          ))}
        </div>
        {estimated > 0 && (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-chart-2/15"
            data-testid={`analytics-task-estimate-fill-${task.id}`}
            style={{ width: `${getTaskBreakdownPercent(estimated)}%` }}
          />
        )}
        {logged > 0 && (
          <div
            className={cn(
              "absolute inset-y-0 left-0 rounded-full",
              task.completed ? "bg-chart-1/75" : "bg-chart-4/80"
            )}
            data-testid={`analytics-task-actual-fill-${task.id}`}
            style={{ width: `${getTaskBreakdownPercent(logged)}%` }}
          />
        )}
      </div>
    </div>
  );
}

export function HourlyChart({
  hourlyMins,
  title,
}: {
  hourlyMins: number[];
  title: string;
}) {
  const maxMins = Math.max(...hourlyMins, 1);
  const hasData = hourlyMins.some((minutes) => minutes > 0);
  if (!hasData) return null;

  const startHour = 6;
  const endHour = 23;
  const hours = hourlyMins.slice(startHour, endHour + 1);

  return (
    <div className="fd-chart-panel">
      <h3 className="mb-3 text-sm font-medium">{title}</h3>
      <div className="flex items-end gap-px" style={{ height: 80 }}>
        {hours.map((minutes, index) => {
          const hour = startHour + index;
          const height = maxMins > 0 ? (minutes / maxMins) * 100 : 0;
          return (
            <div
              key={hour}
              className="flex flex-1 flex-col items-center justify-end"
              style={{ height: 64 }}
            >
              {minutes > 0 ? (
                <div
                  className="w-full rounded-t-[2px] bg-chart-2/70"
                  style={{ height: `${height}%`, minHeight: 2 }}
                  title={`${hour}:00 — ${minutes}m`}
                />
              ) : (
                <div className="w-full bg-muted/50" style={{ height: 1 }} />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex">
        {hours.map((_, index) => {
          const hour = startHour + index;
          const showLabel = hour % 3 === 0;
          return (
            <div
              key={hour}
              className="flex-1 text-center text-[8px] text-muted-foreground/60"
            >
              {showLabel ? `${hour}` : ""}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Heatmap({ heatmap }: { heatmap: number[][] }) {
  const maxMins = Math.max(...heatmap.flat(), 1);
  const hasData = heatmap.some((row) => row.some((minutes) => minutes > 0));
  if (!hasData) return null;

  const startHour = 6;
  const endHour = 22;

  return (
    <div className="fd-chart-panel">
      <h3 className="mb-3 text-sm font-medium">Work Time Heatmap</h3>
      <div>
        <div>
          <div className="mb-1 ml-10 flex gap-px">
            {Array.from({ length: endHour - startHour + 1 }, (_, index) => {
              const hour = startHour + index;
              return (
                <div
                  key={hour}
                  className="flex-1 text-center text-[8px] text-muted-foreground/60"
                >
                  {hour % 3 === 0 ? `${hour}` : ""}
                </div>
              );
            })}
          </div>
          {heatmap.map((row, dayIdx) => (
            <div key={dayIdx} className="mb-px flex items-center gap-px">
              <span className="w-10 shrink-0 pr-1.5 text-right text-[10px] text-muted-foreground">
                {DAY_LABELS[dayIdx]}
              </span>
              {row.slice(startHour, endHour + 1).map((minutes, index) => {
                const intensity = maxMins > 0 ? minutes / maxMins : 0;
                const alpha = Math.round((0.15 + intensity * 0.85) * 100);
                return (
                  <div
                    key={index}
                    className="flex-1 rounded-[2px]"
                    style={{
                      height: 16,
                      backgroundColor:
                        minutes === 0
                          ? "var(--muted)"
                          : `color-mix(in oklch, var(--chart-2) ${alpha}%, transparent)`,
                    }}
                    title={`${DAY_LABELS[dayIdx]} ${startHour + index}:00 — ${minutes}m`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
