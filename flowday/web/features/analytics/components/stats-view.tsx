"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { WorkPatternStatsData } from "../contracts";
import { analyticsUrl, useAnalyticsResource } from "../hooks/use-analytics-resource";
import { DAY_LABELS } from "./shared";

export function StatsView() {
  const { data, loading } = useAnalyticsResource<WorkPatternStatsData>(analyticsUrl("stats"));
  const [mode, setMode] = useState<"frequency" | "duration">("frequency");

  if (loading) {
    return <div className="py-8 text-center text-sm text-muted-foreground">Loading...</div>;
  }
  if (!data) {
    return <div className="py-8 text-center text-sm text-muted-foreground">No data</div>;
  }

  const startHour = 6;
  const endHour = 22;
  const grid = mode === "frequency" ? data.weekCount : data.totalMins;
  const maxVal = Math.max(...grid.flatMap((row) => row.slice(startHour, endHour + 1)), 1);
  const hasData = grid.some((row) => row.some((value) => value > 0));

  if (!hasData) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        No work data recorded yet. Start using the timer to build your pattern!
      </div>
    );
  }

  return (
    <div className="space-y-5 py-1">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">Work Patterns</h3>
          <p className="text-xs text-muted-foreground">
            Across {data.totalWeeks} week{data.totalWeeks !== 1 ? "s" : ""} of data
          </p>
        </div>
        <div className="fd-control-cluster flex items-center gap-1 p-0.5">
          <button
            onClick={() => setMode("frequency")}
            className={cn(
              "rounded-sm px-2.5 py-0.5 text-xs font-medium transition-colors",
              mode === "frequency"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Frequency
          </button>
          <button
            onClick={() => setMode("duration")}
            className={cn(
              "rounded-sm px-2.5 py-0.5 text-xs font-medium transition-colors",
              mode === "duration"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Duration
          </button>
        </div>
      </div>

      <div className="fd-chart-panel">
        <div>
          <div className="mb-1 ml-10 flex gap-px">
            {DAY_LABELS.map((day) => (
              <div
                key={day}
                className="flex-1 text-center text-[10px] font-medium text-muted-foreground"
              >
                {day}
              </div>
            ))}
          </div>
          {Array.from({ length: endHour - startHour + 1 }, (_, index) => {
            const hour = startHour + index;
            return (
              <div key={hour} className="mb-px flex items-center gap-px">
                <span className="w-10 shrink-0 pr-1.5 text-right text-[10px] text-muted-foreground">
                  {hour}:00
                </span>
                {DAY_LABELS.map((day, dayIdx) => {
                  const value = grid[dayIdx][hour];
                  const intensity = maxVal > 0 ? value / maxVal : 0;
                  const alpha = Math.round((0.15 + intensity * 0.85) * 100);
                  const tooltip =
                    mode === "frequency"
                      ? `${day} ${hour}:00 — ${value} week${value !== 1 ? "s" : ""}`
                      : `${day} ${hour}:00 — ${value}m total`;
                  return (
                    <div
                      key={dayIdx}
                      className="flex-1 rounded-[2px]"
                      style={{
                        height: 20,
                        backgroundColor:
                          value === 0
                            ? "var(--muted)"
                            : `color-mix(in oklch, var(--chart-2) ${alpha}%, transparent)`,
                      }}
                      title={tooltip}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
        <span>Less</span>
        {[0, 0.25, 0.5, 0.75, 1].map((intensity) => {
          const alpha = Math.round((0.15 + intensity * 0.85) * 100);
          return (
            <div
              key={intensity}
              className="h-3 w-3 rounded-[2px]"
              style={{
                backgroundColor:
                  intensity === 0
                    ? "var(--muted)"
                    : `color-mix(in oklch, var(--chart-2) ${alpha}%, transparent)`,
              }}
            />
          );
        })}
        <span>More</span>
      </div>

      <PeakHoursSummary weekCount={data.weekCount} totalWeeks={data.totalWeeks} />
    </div>
  );
}

function PeakHoursSummary({
  weekCount,
  totalWeeks,
}: {
  weekCount: number[][];
  totalWeeks: number;
}) {
  const slots: { dayIdx: number; hour: number; count: number }[] = [];
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      if (weekCount[dayIndex][hour] > 0) {
        slots.push({ dayIdx: dayIndex, hour, count: weekCount[dayIndex][hour] });
      }
    }
  }
  slots.sort((left, right) => right.count - left.count);
  const top = slots.slice(0, 5);

  if (top.length === 0) return null;

  return (
    <div className="rounded-md border border-border/60 bg-background/25 p-3">
      <h3 className="mb-2 text-sm font-medium">Peak Work Hours</h3>
      <div className="space-y-1.5">
        {top.map((slot, index) => {
          const pct = totalWeeks > 0 ? Math.round((slot.count / totalWeeks) * 100) : 0;
          return (
            <div key={index} className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">
                {DAY_LABELS[slot.dayIdx]} {slot.hour}:00
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-chart-2/70"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {slot.count}/{totalWeeks} wks
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
