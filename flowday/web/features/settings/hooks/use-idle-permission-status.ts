"use client";

import { useEffect, useState } from "react";

export type IdlePermissionState = "granted" | "denied" | "prompt" | "unsupported";

export function useIdlePermissionStatus(open: boolean) {
  const [idleStatus, setIdleStatus] = useState<IdlePermissionState>("unsupported");
  const [requestingIdle, setRequestingIdle] = useState(false);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    let permissionStatus: PermissionStatus | null = null;
    let onChange: (() => void) | null = null;

    async function check() {
      if (typeof window === "undefined" || !window.IdleDetector) {
        setIdleStatus("unsupported");
        return;
      }
      try {
        permissionStatus = await navigator.permissions.query({
          name: "idle-detection" as PermissionName,
        });
        if (cancelled) return;
        setIdleStatus(permissionStatus.state);
        onChange = () => setIdleStatus(permissionStatus!.state);
        permissionStatus.addEventListener("change", onChange);
      } catch {
        setIdleStatus("unsupported");
      }
    }

    void check();
    return () => {
      cancelled = true;
      if (permissionStatus && onChange) {
        permissionStatus.removeEventListener("change", onChange);
      }
    };
  }, [open]);

  async function requestIdlePermission() {
    if (!window.IdleDetector) return;

    setRequestingIdle(true);
    try {
      const result = await window.IdleDetector.requestPermission();
      setIdleStatus(result === "granted" ? "granted" : "denied");
    } catch {
      // The browser prompt can be dismissed without changing permission state.
    } finally {
      setRequestingIdle(false);
    }
  }

  return {
    idleStatus,
    requestingIdle,
    requestIdlePermission,
  };
}
