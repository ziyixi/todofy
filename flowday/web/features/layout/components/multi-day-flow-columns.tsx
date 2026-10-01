"use client";

import { format } from "date-fns";
import { DayFlow } from "@/features/flow/components/day-flow";

export function MultiDayFlowColumns({ dates }: { dates: string[] }) {
  return (
    <div className="flex flex-1 divide-x divide-border/65 overflow-hidden">
      {dates.map((date) => (
        <div
          key={date}
          data-testid="day-column"
          data-date={date}
          className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background/45"
        >
          <div className="shrink-0 border-b border-border/65 bg-card/45 px-3 py-2 text-center">
            <p className="text-sm font-medium text-muted-foreground sm:text-xs">
              {format(new Date(`${date}T00:00:00`), "EEE")}
            </p>
            <p className="text-sm font-semibold text-foreground">
              {format(new Date(`${date}T00:00:00`), "MMM d")}
            </p>
          </div>
          <div className="flex flex-1 flex-col overflow-y-auto">
            <DayFlow date={date} readOnly />
          </div>
        </div>
      ))}
    </div>
  );
}
