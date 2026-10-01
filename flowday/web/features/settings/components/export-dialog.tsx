"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatLocalDate } from "@/lib/utils/time";

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function todayStr() {
  return formatLocalDate();
}

function weekAgoStr() {
  const date = new Date();
  date.setDate(date.getDate() - 7);
  return formatLocalDate(date);
}

export function ExportDialog({ open, onOpenChange }: ExportDialogProps) {
  const [startDate, setStartDate] = useState(weekAgoStr);
  const [endDate, setEndDate] = useState(todayStr);
  const [exportType, setExportType] = useState<"entries" | "flows">("entries");
  const [exportFormat, setExportFormat] = useState<"csv" | "json">("csv");

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setStartDate(weekAgoStr());
      setEndDate(todayStr());
    }
    onOpenChange(nextOpen);
  };

  function handleDownload() {
    const params = new URLSearchParams({
      type: exportType,
      format: exportFormat,
      start: startDate,
      end: endDate,
    });
    const url = `/api/export?${params.toString()}`;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `flowday-${exportType}-${startDate}-to-${endDate}.${exportFormat}`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Export Data</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Data type</label>
            <div className="flex w-fit gap-1 rounded-md border border-border bg-muted/50 p-0.5">
              {(["entries", "flows"] as const).map((type) => (
                <button
                  key={type}
                  onClick={() => setExportType(type)}
                  className={cn(
                    "rounded-sm px-3 py-1 text-sm font-medium transition-colors",
                    exportType === type
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {type === "entries" ? "Time Entries" : "Flow History"}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                From
              </label>
              <Input
                data-testid="export-start-date"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                To
              </label>
              <Input
                data-testid="export-end-date"
                type="date"
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Format</label>
            <div className="flex w-fit gap-1 rounded-md border border-border bg-muted/50 p-0.5">
              {(["csv", "json"] as const).map((format) => (
                <button
                  key={format}
                  onClick={() => setExportFormat(format)}
                  className={cn(
                    "rounded-sm px-3 py-1 text-sm font-medium uppercase transition-colors",
                    exportFormat === format
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {format}
                </button>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button data-testid="download-export" onClick={handleDownload}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
