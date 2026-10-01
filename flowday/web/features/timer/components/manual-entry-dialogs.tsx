"use client";

import { useEffect, useId, useMemo, useState } from "react";
import {
  buildTimeOptions,
  combineLocalDateAndTime,
  defaultManualEntryRange,
  toLocalDateTimeParts,
} from "@/lib/utils/manual-entry-time";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { jsonRequestInit } from "@/lib/client/http";
import type { TimeEntry } from "@/features/timer/contracts";
import { formatDurationShort } from "./manual-entry-utils";

function TimeInput({
  value,
  onChange,
  options,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  testId?: string;
}) {
  const listId = useId();
  return (
    <>
      <Input
        type="time"
        step={60}
        list={listId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="text-sm"
        data-testid={testId}
      />
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
    </>
  );
}

function DateTimeFieldRow({
  label,
  dateValue,
  onDateChange,
  timeValue,
  onTimeChange,
  timeOptions,
  dateTestId,
  timeTestId,
}: {
  label: string;
  dateValue: string;
  onDateChange: (value: string) => void;
  timeValue: string;
  onTimeChange: (value: string) => void;
  timeOptions: string[];
  dateTestId?: string;
  timeTestId?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">
        {label}
      </div>
      <div className="grid grid-cols-[1.2fr_1fr] gap-2">
        <Input
          type="date"
          value={dateValue}
          onChange={(event) => onDateChange(event.target.value)}
          className="text-sm"
          data-testid={dateTestId}
        />
        <TimeInput
          value={timeValue}
          onChange={onTimeChange}
          options={timeOptions}
          testId={timeTestId}
        />
      </div>
    </div>
  );
}

function DurationPreview({
  startDate,
  startTime,
  endDate,
  endTime,
}: {
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
}) {
  let content = "Set a valid range";

  if (startDate && startTime && endDate && endTime) {
    const start = new Date(`${startDate}T${startTime}`);
    const end = new Date(`${endDate}T${endTime}`);
    const durationS = Math.floor((end.getTime() - start.getTime()) / 1000);
    if (durationS > 0) {
      content = formatDurationShort(durationS);
    }
  }

  return (
    <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background px-3 py-2">
      <span className="text-xs font-medium uppercase text-muted-foreground">
        Duration
      </span>
      <span className="text-sm font-medium tabular-nums text-primary">{content}</span>
    </div>
  );
}

export function EditEntryDialog({
  entry,
  open,
  onOpenChange,
  onSaved,
}: {
  entry: TimeEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const timeOptions = useMemo(
    () => buildTimeOptions([startTime, endTime]),
    [startTime, endTime]
  );

  useEffect(() => {
    if (!open) return;
    const start = toLocalDateTimeParts(entry.startTime);
    const end = entry.endTime ? toLocalDateTimeParts(entry.endTime) : start;
    setStartDate(start.dateValue);
    setStartTime(start.timeValue);
    setEndDate(end.dateValue);
    setEndTime(end.timeValue);
    setError("");
  }, [open, entry]);

  async function handleSave() {
    if (!startDate || !startTime || !endDate || !endTime) {
      setError("Both times required");
      return;
    }
    const start = combineLocalDateAndTime(startDate, startTime);
    const end = combineLocalDateAndTime(endDate, endTime);
    if (new Date(end) <= new Date(start)) {
      setError("End must be after start");
      return;
    }

    setSaving(true);
    try {
      await fetch(
        `/api/entries/${entry.id}`,
        jsonRequestInit("PUT", { startTime: start, endTime: end })
      );
      onOpenChange(false);
      onSaved();
    } catch {
      setError("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit Time Entry</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <DateTimeFieldRow
            label="Start"
            dateValue={startDate}
            onDateChange={setStartDate}
            timeValue={startTime}
            onTimeChange={setStartTime}
            timeOptions={timeOptions}
            dateTestId="edit-entry-start-date"
            timeTestId="edit-entry-start-time"
          />
          <DateTimeFieldRow
            label="End"
            dateValue={endDate}
            onDateChange={setEndDate}
            timeValue={endTime}
            onTimeChange={setEndTime}
            timeOptions={timeOptions}
            dateTestId="edit-entry-end-date"
            timeTestId="edit-entry-end-time"
          />
          <DurationPreview
            startDate={startDate}
            startTime={startTime}
            endDate={endDate}
            endTime={endTime}
          />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AddEntryDialog({
  taskId,
  flowDate,
  open,
  onOpenChange,
  onCreated,
}: {
  taskId: string;
  flowDate: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const timeOptions = useMemo(
    () => buildTimeOptions([startTime, endTime]),
    [startTime, endTime]
  );

  useEffect(() => {
    if (!open) return;
    const range = defaultManualEntryRange(new Date());
    setStartDate(range.start.dateValue);
    setStartTime(range.start.timeValue);
    setEndDate(range.end.dateValue);
    setEndTime(range.end.timeValue);
    setError("");
  }, [open]);

  async function handleSubmit() {
    if (!startDate || !startTime || !endDate || !endTime) {
      setError("Both times required");
      return;
    }

    const start = new Date(`${startDate}T${startTime}`);
    const end = new Date(`${endDate}T${endTime}`);
    if (end <= start) {
      setError("End must be after start");
      return;
    }

    const durationS = Math.floor((end.getTime() - start.getTime()) / 1000);
    setSaving(true);
    setError("");

    try {
      await fetch(
        "/api/entries",
        jsonRequestInit("POST", {
          taskId,
          flowDate,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          durationS,
          source: "manual",
        })
      );
      onOpenChange(false);
      onCreated();
    } catch {
      setError("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add Time Entry</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <DateTimeFieldRow
            label="Start"
            dateValue={startDate}
            onDateChange={setStartDate}
            timeValue={startTime}
            onTimeChange={setStartTime}
            timeOptions={timeOptions}
            dateTestId="add-entry-start-date"
            timeTestId="add-entry-start-time"
          />
          <DateTimeFieldRow
            label="End"
            dateValue={endDate}
            onDateChange={setEndDate}
            timeValue={endTime}
            onTimeChange={setEndTime}
            timeOptions={timeOptions}
            dateTestId="add-entry-end-date"
            timeTestId="add-entry-end-time"
          />
          <DurationPreview
            startDate={startDate}
            startTime={startTime}
            endDate={endDate}
            endTime={endTime}
          />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
