"use client";

import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ExportDialog } from "./export-dialog";
import { useIdlePermissionStatus } from "../hooks/use-idle-permission-status";
import { useTodoistStore } from "@/features/todoist/store";
import { useFlowStore } from "@/features/flow/store";
import { fetchJsonNoStore, jsonRequestInit } from "@/lib/client/http";
import { cn } from "@/lib/utils";
import type { SettingsResponse } from "../contracts";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [apiKey, setApiKey] = useState("");
  const [hasExistingKey, setHasExistingKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [capacityHours, setCapacityHours] = useState("6");
  const [savingCapacity, setSavingCapacity] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const { idleStatus, requestingIdle, requestIdlePermission } =
    useIdlePermissionStatus(open);

  const isSyncing = useTodoistStore((state) => state.isSyncing);
  const lastSyncAt = useTodoistStore((state) => state.lastSyncAt);
  const sync = useTodoistStore((state) => state.sync);
  const setDayCapacityMins = useFlowStore((state) => state.setDayCapacityMins);

  useEffect(() => {
    if (!open) return;

    setApiKey("");
    setMessage(null);

    fetchJsonNoStore<SettingsResponse>("/api/settings")
      .then((data) => {
        if (!data) return;
        setHasExistingKey(data.has_api_key);
        if (data.day_capacity_mins != null) {
          setCapacityHours(String(data.day_capacity_mins / 60));
        }
      })
      .catch(() => {});
  }, [open]);

  async function handleSave() {
    if (!apiKey.trim()) {
      setMessage({ type: "error", text: "API key cannot be empty" });
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/settings",
        jsonRequestInit("PUT", { todoist_api_key: apiKey.trim() })
      );
      if (response.ok) {
        setHasExistingKey(true);
        setApiKey("");
        setMessage({
          type: "success",
          text: "API key saved. Click Sync Now to fetch tasks.",
        });
      } else {
        setMessage({ type: "error", text: "Failed to save" });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to save" });
    } finally {
      setSaving(false);
    }
  }

  async function handleSync() {
    setMessage(null);
    await sync();
    setMessage({ type: "success", text: "Sync complete" });
  }

  async function handleCapacitySave() {
    const hours = parseFloat(capacityHours);
    if (Number.isNaN(hours) || hours < 0) {
      setMessage({ type: "error", text: "Invalid capacity value" });
      return;
    }

    setSavingCapacity(true);
    setMessage(null);
    try {
      const capacityMins = Math.round(hours * 60);
      const response = await fetch(
        "/api/settings",
        jsonRequestInit("PUT", { day_capacity_mins: capacityMins })
      );
      if (response.ok) {
        setDayCapacityMins(capacityMins);
        setMessage({ type: "success", text: "Capacity saved" });
      } else {
        setMessage({ type: "error", text: "Failed to save capacity" });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to save capacity" });
    } finally {
      setSavingCapacity(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="fd-dialog-panel rounded-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-border/60 bg-background/25 p-3">
            <label className="text-sm font-medium text-foreground">
              Todoist API Key
            </label>
            <p className="text-xs text-muted-foreground">
              Find your API key at{" "}
              <span className="font-medium">Settings → Integrations → Developer</span>{" "}
              in Todoist. FlowDay only reads your tasks and never writes to Todoist.
            </p>
            <div className="flex gap-2">
              <Input
                data-testid="settings-api-key-input"
                type="password"
                placeholder={
                  hasExistingKey ? "••••••••  (key saved)" : "Enter your API key"
                }
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                className="flex-1"
              />
              <Button
                data-testid="settings-save-api-key"
                onClick={handleSave}
                disabled={saving}
              >
                Save
              </Button>
            </div>
          </div>

          <div className="rounded-md border border-border/60 bg-background/25 p-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-foreground">
                Todoist Sync
              </label>
              <Button
                data-testid="settings-sync-now"
                variant="outline"
                size="sm"
                onClick={handleSync}
                disabled={isSyncing || !hasExistingKey}
              >
                <RefreshCw
                  className={cn("mr-1.5 h-3.5 w-3.5", isSyncing && "animate-spin")}
                />
                Sync Now
              </Button>
            </div>
            {lastSyncAt && (
              <p className="text-xs text-muted-foreground">
                Last synced: {new Date(lastSyncAt).toLocaleString()}
              </p>
            )}
            {!hasExistingKey && (
              <p className="text-xs text-muted-foreground/60">
                Save an API key to enable syncing.
              </p>
            )}
            <p className="text-xs text-muted-foreground/60">
              Tasks sync automatically every minute when an API key is set.
            </p>
          </div>

          <div className="rounded-md border border-border/60 bg-background/25 p-3">
            <label className="text-sm font-medium text-foreground">
              Daily Work Capacity
            </label>
            <p className="text-xs text-muted-foreground">
              Set your daily focused work budget. FlowDay warns when your plan
              exceeds this number.
            </p>
            <div className="flex items-center gap-2">
              <Input
                data-testid="capacity-input"
                type="number"
                min="0"
                step="0.5"
                value={capacityHours}
                onChange={(event) => setCapacityHours(event.target.value)}
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">hours</span>
              <Button
                data-testid="capacity-save"
                variant="outline"
                size="sm"
                disabled={savingCapacity}
                onClick={handleCapacitySave}
              >
                Save
              </Button>
            </div>
          </div>

          {idleStatus !== "unsupported" && (
            <div className="rounded-md border border-border/60 bg-background/25 p-3">
              <label className="text-sm font-medium text-foreground">
                Auto-pause when idle
              </label>
              <p className="text-xs text-muted-foreground">
                Allow FlowDay to detect screen lock or long inactivity so running
                timers can backdate the pause point precisely.
              </p>
              <div className="flex items-center gap-2">
                {idleStatus === "granted" && (
                  <span className="text-xs font-medium text-green-600">Enabled</span>
                )}
                {idleStatus === "denied" && (
                  <span className="text-xs text-muted-foreground">
                    Denied — re-enable this from your browser&apos;s site settings.
                  </span>
                )}
                {idleStatus === "prompt" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={requestIdlePermission}
                    disabled={requestingIdle}
                  >
                    Allow
                  </Button>
                )}
              </div>
            </div>
          )}

          <div className="rounded-md border border-border/60 bg-background/25 p-3">
            <label className="text-sm font-medium text-foreground">Export Data</label>
            <p className="text-xs text-muted-foreground">
              Download your time entries or flow history as CSV or JSON.
            </p>
            <Button
              data-testid="open-export-dialog"
              variant="outline"
              size="sm"
              onClick={() => setExportOpen(true)}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Export
            </Button>
          </div>

          <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />

          {message && (
            <p
              className={cn(
                "text-xs",
                message.type === "success" ? "text-green-600" : "text-destructive"
              )}
            >
              {message.text}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
