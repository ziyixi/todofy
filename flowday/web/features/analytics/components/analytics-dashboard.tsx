"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFlowStore } from "@/features/flow/store";
import { cn } from "@/lib/utils";
import { DailyReview } from "./daily-review";
import { WeeklyReview } from "./weekly-review";
import { StatsView } from "./stats-view";

interface AnalyticsDashboardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AnalyticsDashboard({
  open,
  onOpenChange,
}: AnalyticsDashboardProps) {
  const [tab, setTab] = useState<"daily" | "weekly" | "stats">("daily");
  const currentDate = useFlowStore((state) => state.currentDate);
  const [dailyDate, setDailyDate] = useState(currentDate);
  const [weeklyDate, setWeeklyDate] = useState(currentDate);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setDailyDate(currentDate);
      setWeeklyDate(currentDate);
      setRefreshKey((key) => key + 1);
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="fd-dialog-panel flex h-[85vh] flex-col overflow-hidden rounded-md sm:max-w-3xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>Analytics</DialogTitle>
        </DialogHeader>

        <div className="fd-control-cluster flex w-fit shrink-0 items-center gap-1 p-0.5">
          <button
            onClick={() => setTab("daily")}
            className={cn(
              "rounded-sm px-3 py-1 text-sm font-medium transition-colors",
              tab === "daily"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Daily Review
          </button>
          <button
            onClick={() => setTab("weekly")}
            className={cn(
              "rounded-sm px-3 py-1 text-sm font-medium transition-colors",
              tab === "weekly"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Weekly Review
          </button>
          <button
            onClick={() => setTab("stats")}
            className={cn(
              "rounded-sm px-3 py-1 text-sm font-medium transition-colors",
              tab === "stats"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Work Patterns
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1">
          {tab === "daily" ? (
            <DailyReview
              key={`daily-${refreshKey}-${dailyDate}`}
              date={dailyDate}
              onDateChange={setDailyDate}
            />
          ) : tab === "weekly" ? (
            <WeeklyReview
              key={`weekly-${refreshKey}-${weeklyDate}`}
              date={weeklyDate}
              onDateChange={setWeeklyDate}
            />
          ) : (
            <StatsView key={`stats-${refreshKey}`} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
