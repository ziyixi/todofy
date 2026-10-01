"use client";

import { addDays, format } from "date-fns";
import { formatDuration, formatLocalDate } from "@/lib/utils/time";
import { cn } from "@/lib/utils";
import type { DailyAnalyticsData } from "../contracts";
import { analyticsUrl, useAnalyticsResource } from "../hooks/use-analytics-resource";
import {
  DateNav,
  HourlyChart,
  StatCard,
  TASK_BREAKDOWN_SCALE_LABEL,
  TaskBar,
} from "./shared";

export function DailyReview({
  date,
  onDateChange,
}: {
  date: string;
  onDateChange: (date: string) => void;
}) {
  const { data, loading } = useAnalyticsResource<DailyAnalyticsData>(
    analyticsUrl("daily", date)
  );
  const dateLabel = format(new Date(`${date}T00:00:00`), "EEEE, MMM d, yyyy");

  if (loading) {
    return (
      <div className="space-y-4">
        <DateNav
          label={dateLabel}
          onPrev={() => onDateChange(format(addDays(new Date(`${date}T00:00:00`), -1), "yyyy-MM-dd"))}
          onNext={() => onDateChange(format(addDays(new Date(`${date}T00:00:00`), 1), "yyyy-MM-dd"))}
          onToday={() => onDateChange(formatLocalDate())}
        />
        <div className="py-8 text-center text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!data) {
    return <div className="py-8 text-center text-sm text-muted-foreground">No data</div>;
  }

  const accuracy =
    data.totalEstimatedMins > 0 && data.totalLoggedMins > 0
      ? Math.round(
          (Math.min(data.totalEstimatedMins, data.totalLoggedMins) /
            Math.max(data.totalEstimatedMins, data.totalLoggedMins)) *
            100
        )
      : null;

  return (
    <div className="space-y-5 py-1">
      <DateNav
        label={dateLabel}
        onPrev={() => onDateChange(format(addDays(new Date(`${date}T00:00:00`), -1), "yyyy-MM-dd"))}
        onNext={() => onDateChange(format(addDays(new Date(`${date}T00:00:00`), 1), "yyyy-MM-dd"))}
        onToday={() => onDateChange(formatLocalDate())}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Tasks" value={`${data.tasksCompleted}/${data.tasksPlanned}`} />
        <StatCard label="Logged" value={formatDuration(data.totalLoggedMins)} />
        <StatCard label="Estimated" value={formatDuration(data.totalEstimatedMins)} />
        <StatCard label="Accuracy" value={accuracy != null ? `${accuracy}%` : "—"} />
      </div>

      {data.dayCapacityMins > 0 && (
        <div className="rounded-md border border-border/60 bg-background/35 p-3">
          <div className="mb-1 flex justify-between text-xs text-muted-foreground">
            <span>Capacity</span>
            <span>
              {formatDuration(data.totalLoggedMins)} / {formatDuration(data.dayCapacityMins)}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted/85">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                data.totalLoggedMins > data.dayCapacityMins ? "bg-amber-500" : "bg-primary"
              )}
              style={{
                width: `${Math.min((data.totalLoggedMins / data.dayCapacityMins) * 100, 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      {data.hourlyMins && <HourlyChart hourlyMins={data.hourlyMins} title="Hourly Activity" />}

      {data.tasks.length > 0 ? (
        <div className="rounded-md border border-border/60 bg-background/25 p-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">Task Breakdown</h3>
            <span className="text-[10px] uppercase text-muted-foreground/70">
              {TASK_BREAKDOWN_SCALE_LABEL}
            </span>
          </div>
          <div className="space-y-2">
            {data.tasks.map((task) => (
              <TaskBar key={task.id} task={task} />
            ))}
          </div>
        </div>
      ) : (
        <p className="py-4 text-center text-sm text-muted-foreground/60">
          No tasks planned for this day
        </p>
      )}

      {data.tasks.filter((task) => task.estimatedMins && task.loggedMins > 0).length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-medium">Estimation vs Actual</h3>
          <div className="overflow-hidden rounded-md border border-border/70 bg-card/55">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/70 bg-muted/45">
                  <th className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground">
                    Task
                  </th>
                  <th className="px-3 py-1.5 text-right text-xs font-medium text-muted-foreground">
                    Est.
                  </th>
                  <th className="px-3 py-1.5 text-right text-xs font-medium text-muted-foreground">
                    Actual
                  </th>
                  <th className="px-3 py-1.5 text-right text-xs font-medium text-muted-foreground">
                    Diff
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.tasks
                  .filter((task) => task.estimatedMins && task.loggedMins > 0)
                  .map((task) => {
                    const estimate = task.estimatedMins!;
                    const diff = task.loggedMins - estimate;
                    return (
                      <tr
                        key={task.id}
                        className="border-b border-border/50 last:border-0"
                      >
                        <td className="max-w-[200px] truncate px-3 py-1.5">{task.title}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                          {formatDuration(estimate)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {formatDuration(task.loggedMins)}
                        </td>
                        <td
                          className={cn(
                            "px-3 py-1.5 text-right tabular-nums font-medium",
                            diff > 0
                              ? "text-red-500"
                              : diff < 0
                                ? "text-green-500"
                                : "text-muted-foreground"
                          )}
                        >
                          {diff > 0 ? "+" : ""}
                          {formatDuration(Math.abs(diff))}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
