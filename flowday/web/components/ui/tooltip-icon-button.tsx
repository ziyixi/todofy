"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface TooltipIconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  tooltip?: ReactNode;
  tooltipSide?: "top" | "bottom" | "left" | "right";
}

export function TooltipIconButton({
  children,
  className,
  label,
  tooltip,
  tooltipSide,
  title,
  type = "button",
  ...props
}: TooltipIconButtonProps) {
  const tooltipContent = tooltip ?? label;

  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type={type} />}
        className={cn("fd-icon-button", className)}
        aria-label={label}
        title={title ?? (typeof tooltipContent === "string" ? tooltipContent : label)}
        {...props}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{tooltipContent}</TooltipContent>
    </Tooltip>
  );
}
