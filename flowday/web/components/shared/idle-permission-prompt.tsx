"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

const STORAGE_KEY = "flowday.idleDetectionAsked";

export function IdlePermissionPrompt() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      if (typeof window === "undefined") return;
      if (!window.IdleDetector) return;
      if (localStorage.getItem(STORAGE_KEY) === "true") return;

      try {
        const status = await navigator.permissions.query({
          name: "idle-detection" as PermissionName,
        });
        if (cancelled) return;
        if (status.state === "prompt") setShow(true);
      } catch {
        // Permission name unsupported in this browser — stay hidden.
      }
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleAllow() {
    try {
      await window.IdleDetector?.requestPermission();
    } catch {
      // User dismissed the native prompt — treat as not-now.
    }
    localStorage.setItem(STORAGE_KEY, "true");
    setShow(false);
  }

  function handleDismiss() {
    localStorage.setItem(STORAGE_KEY, "true");
    setShow(false);
  }

  if (!show) return null;

  return (
    <div className="fixed left-1/2 top-3 z-50 flex max-w-md -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-background px-3 py-2 text-sm shadow-lg">
      <span className="text-foreground">
        Auto-pause your timer when you lock your screen or step away?
      </span>
      <button
        onClick={handleAllow}
        className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        Allow
      </button>
      <button
        onClick={handleDismiss}
        title="Not now"
        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
