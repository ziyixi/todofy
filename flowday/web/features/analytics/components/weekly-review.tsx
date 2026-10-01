"use client";

import { addWeeks, format } from "date-fns";
import { formatDuration, formatLocalDate } from "@/lib/utils/time";
import { cn } from "@/lib/utils";
import type { WeeklyAnalyticsData } from "../contracts";
import { analyticsUrl, useAnalyticsResource } from "../hooks/use-analytics-resource";
import { DateNav, Heatmap, StatCard } from "./shared";

export function WeeklyReview({
  date,
  onDateChange,
}: {
  date: string;
  onDateChange: (date: string) => void;
}) {
  const { data, loading } = useAnalyticsResource<WeeklyAnalyticsData>(
    analyticsUrl("weekly", date)
  );
  const weekLabel = !data
    ? format(new Date(`${date}T00:00:00`), "MMM d, yyyy")
    : `${format(new Date(`${data.weekStart}T00:00:00`), "MMM d")} – ${format(
        new Date(`${data.weekEnd}T00:00:00`),
        "MMM d, yyyy"
      )}`;

  return (
    <div className="space-y-5 py-1">
      <DateNav
        label={weekLabel}
        onPrev={() => onDateChange(format(addWeeks(new Date(`${date}T00:00:00`), -1), "yyyy-MM-dd"))}
        onNext={() => onDateChange(format(addWeeks(new Date(`${date}T00:00:00`), 1), "yyyy-MM-dd"))}
        onToday={() => onDateChange(formatLocalDate())}
      />

      {loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">Loading...</div>
      ) : !data ? (
        <div className="py-8 text-center text-sm text-muted-foreground">No data</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Done" value={String(data.totals.tasksCompleted)} sub="tasks" />
            <StatCard label="Hours" value={formatDuration(data.totals.totalLoggedMins)} />
            <StatCard label="Avg/Day" value={String(data.totals.avgTasksPerDay)} sub="tasks" />
            <StatCard
              label="Accuracy"
              value={data.totals.overallAccuracy != null ? `${data.totals.overallAccuracy}%` : "—"}
            />
          </div>

          <div className="fd-chart-panel">
            <h3 className="mb-3 text-sm font-medium">Daily Trend</h3>
            <div className="flex items-end gap-1.5" style={{ height: 128 }}>
              {data.days.map((day) => {
                const maxMins = Math.max(...data.days.map((item) => item.loggedMins), 1);
                const height = (day.loggedMins / maxMins) * 100;
                return (
                  <div key={day.date} className="flex flex-1 flex-col items-center gap-1">
                    <div className="flex w-full flex-col justify-end" style={{ height: 96 }}>
                      {day.loggedMins > 0 ? (
                        <div
                          className="w-full rounded-t-sm bg-chart-2/75 transition-all"
                          style={{ height: `${height}%` }}
                          title={`${formatDuration(day.loggedMins)} logged`}
                        />
                      ) : (
                        <div className="w-full rounded-t-sm bg-muted" style={{ height: 2 }} />
                      )}
                    </div>
                    <span className="text-[10px] text-muted-foreground">{day.dayOfWeek}</span>
                    <span className="text-[9px] text-muted-foreground/60">
                      {day.tasksCompleted > 0 ? `${day.tasksCompleted}` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {data.heatmap && <Heatmap heatmap={data.heatmap} />}

          {data.byProject.length > 0 && (
            <div>
              <h3 className="mb-3 text-sm font-medium">Time by Project</h3>
              <div className="space-y-2.5 rounded-md border border-border/60 bg-background/25 p-3">
                {data.byProject.map((project) => {
                  const maxMins = Math.max(...data.byProject.map((item) => item.loggedMins), 1);
                  return (
                    <div key={project.projectName} className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="flex min-w-0 items-center gap-1.5">
                          {project.projectColor && (
                            <span
                              className="h-2 w-2 shrink-0 rounded-full"
                              style={{ backgroundColor: project.projectColor }}
                            />
                          )}
                          <span className="truncate">{project.projectName}</span>
                        </span>
                        <span className="ml-2 shrink-0 text-muted-foreground">
                          {formatDuration(project.loggedMins)} · {project.tasksCompleted} tasks
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${(project.loggedMins / maxMins) * 100}%`,
                            backgroundColor: project.projectColor ?? "var(--chart-2)",
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {data.stuckTasks.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-medium">Stuck Tasks</h3>
              <p className="mb-2 text-xs text-muted-foreground">
                Tasks planned on multiple days but not completed
              </p>
              <div className="space-y-1.5">
                {data.stuckTasks.map((task) => (
                  <div
                    key={task.id}
                    className="fd-soft-row flex items-center justify-between px-3 py-1.5"
                  >
                    <span className="truncate text-sm">{task.title}</span>
                    <span className="ml-2 shrink-0 text-xs text-amber-500">
                      {task.daysAppeared} days
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.estimationAccuracy.length > 0 && (
            <div>
              <h3 className="mb-3 text-sm font-medium">Estimation Accuracy</h3>
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
                        Acc.
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.estimationAccuracy.map((item) => {
                      const accuracy = Math.round(
                        (Math.min(item.estimatedMins, item.actualMins) /
                          Math.max(item.estimatedMins, item.actualMins)) *
                          100
                      );
                      return (
                        <tr key={item.id} className="border-b border-border/50 last:border-0">
                          <td className="max-w-[200px] truncate px-3 py-1.5">{item.title}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                            {formatDuration(item.estimatedMins)}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {formatDuration(item.actualMins)}
                          </td>
                          <td
                            className={cn(
                              "px-3 py-1.5 text-right tabular-nums font-medium",
                              accuracy >= 80
                                ? "text-green-500"
                                : accuracy >= 50
                                  ? "text-amber-500"
                                  : "text-red-500"
                            )}
                          >
                            {accuracy}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
