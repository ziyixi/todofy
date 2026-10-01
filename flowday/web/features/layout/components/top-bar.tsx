"use client";

import { useState } from "react";
import { format, addDays } from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  Moon,
  Sun,
  Monitor,
  Settings,
  BarChart3,
} from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useTheme } from "@/components/theme-provider";
import { useFlowStore, type ViewMode } from "@/features/flow/store";
import { MiscTimeButton } from "@/components/timer/misc-time-button";
import { TimerDisplay } from "@/components/timer/timer-display";
import { PopOutTimerButton } from "@/components/timer/pop-out-timer";
import { SettingsDialog } from "@/features/settings/components/settings-dialog";
import { AnalyticsDashboard } from "@/features/analytics/components/analytics-dashboard";
import { formatLocalDate } from "@/lib/utils/time";

export function TopBar() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const currentDateStr = useFlowStore((s) => s.currentDate);
  const setCurrentDate = useFlowStore((s) => s.setCurrentDate);
  const viewMode = useFlowStore((s) => s.viewMode);
  const setViewMode = useFlowStore((s) => s.setViewMode);
  const currentDate = new Date(currentDateStr + "T00:00:00");
  const { theme, setTheme } = useTheme();

  const navigateDate = (direction: -1 | 1) => {
    setCurrentDate(format(addDays(currentDate, direction), "yyyy-MM-dd"));
  };

  const goToToday = () => setCurrentDate(formatLocalDate());

  const cycleTheme = () => {
    const order: Array<"light" | "dark" | "system"> = [
      "light",
      "dark",
      "system",
    ];
    const idx = order.indexOf(theme);
    setTheme(order[(idx + 1) % order.length]);
  };

  const themeIcon =
    theme === "dark" ? (
      <Moon className="h-4 w-4" />
    ) : theme === "light" ? (
      <Sun className="h-4 w-4" />
    ) : (
      <Monitor className="h-4 w-4" />
    );

  const isToday =
    format(currentDate, "yyyy-MM-dd") === formatLocalDate();

  return (
    <header className="fd-topbar flex h-12 shrink-0 items-center justify-between px-4 backdrop-blur-md">
      {/* Left: Brand */}
      <div className="flex items-center gap-3">
        <h1 className="text-base font-semibold text-foreground">FlowDay</h1>
      </div>

      {/* Center: Date navigation + View toggle */}
      <div className="flex items-center gap-2 rounded-md bg-background/25 p-0.5">
        <TooltipIconButton
          className="h-8 w-8 sm:h-7 sm:w-7"
          onClick={() => navigateDate(-1)}
          label="Previous day"
        >
          <ChevronLeft className="h-4 w-4" />
        </TooltipIconButton>

        <button
          onClick={goToToday}
          className="min-w-[148px] rounded-md px-2 py-1 text-center text-sm font-semibold text-foreground transition-colors hover:bg-accent/70"
        >
          {format(currentDate, "EEE, MMM d")}
          {!isToday && (
            <span className="ml-1.5 text-sm text-muted-foreground sm:text-xs">
              {format(currentDate, "yyyy")}
            </span>
          )}
        </button>

        <TooltipIconButton
          className="h-8 w-8 sm:h-7 sm:w-7"
          onClick={() => navigateDate(1)}
          label="Next day"
        >
          <ChevronRight className="h-4 w-4" />
        </TooltipIconButton>

        <div className="ml-1 w-[54px]">
          {!isToday && (
            <button
              onClick={goToToday}
              className="fd-control-cluster w-full px-2 py-0.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:text-xs"
            >
              Today
            </button>
          )}
        </div>

        <div className="fd-control-cluster ml-3 flex items-center p-0.5">
          {([1, 3, 5] as ViewMode[]).map((mode) => (
            <Toggle
              key={mode}
              pressed={viewMode === mode}
              onPressedChange={() => setViewMode(mode)}
              aria-label={`${mode}-day view`}
              title={`${mode}-day view`}
              className="h-7 w-8 rounded-sm px-0 text-sm font-medium text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm sm:h-6 sm:w-7 sm:text-xs"
            >
              {mode}
            </Toggle>
          ))}
        </div>
      </div>

      {/* Right: Timer + Theme toggle + Settings */}
      <div className="flex items-center gap-1.5">
        <MiscTimeButton />
        <TimerDisplay />
        <PopOutTimerButton />

        <TooltipIconButton
          className="h-8 w-8 sm:h-7 sm:w-7"
          onClick={() => setAnalyticsOpen(true)}
          label="Analytics"
        >
          <BarChart3 className="h-4 w-4" />
        </TooltipIconButton>

        <TooltipIconButton
          className="h-8 w-8 sm:h-7 sm:w-7"
          onClick={cycleTheme}
          label={`Theme: ${theme}`}
        >
          {themeIcon}
        </TooltipIconButton>

        <TooltipIconButton
          className="h-8 w-8 sm:h-7 sm:w-7"
          onClick={() => setSettingsOpen(true)}
          label="Settings"
        >
          <Settings className="h-4 w-4" />
        </TooltipIconButton>

        <AnalyticsDashboard open={analyticsOpen} onOpenChange={setAnalyticsOpen} />
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      </div>
    </header>
  );
}
