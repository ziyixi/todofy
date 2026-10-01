"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export const PLANNING_STEPS = [
  { id: "add", label: "Add Tasks" },
  { id: "review", label: "Review" },
  { id: "confirm", label: "Ready" },
] as const;

export function PlanningStepIndicator({
  stepIndex,
}: {
  stepIndex: number;
}) {
  return (
    <div className="mb-5 flex items-center gap-1 rounded-md bg-background/35 p-1">
      {PLANNING_STEPS.map((step, index) => (
        <div key={step.id} className="flex flex-1 items-center gap-1">
          {index > 0 && <div className="mx-1 h-px w-4 bg-border/70" />}
          <div
            className={cn(
              "flex min-w-0 items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs font-medium",
              index < stepIndex
                ? "text-primary"
                : index === stepIndex
                  ? "bg-card text-foreground shadow-[0_1px_2px_oklch(0_0_0/0.035)]"
                  : "text-muted-foreground/40"
            )}
          >
            <span
              className={cn(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                index < stepIndex
                  ? "bg-primary text-primary-foreground"
                  : index === stepIndex
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground/60"
              )}
            >
              {index < stepIndex ? <Check className="h-3 w-3" /> : index + 1}
            </span>
            <span className="hidden truncate sm:inline">{step.label}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
