"use client";

import { AlertTriangle, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApiStatus } from "@/lib/client/api-status";

/** A visible notice for a write that failed or an expired sign-in, with Reload (and Dismiss for other failures). */
export function ApiStatusBanner() {
  const error = useApiStatus((state) => state.error);
  const dismiss = useApiStatus((state) => state.dismiss);
  if (!error) return null;

  return (
    <div
      role="alert"
      className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex-1">
        {error.kind === "session" ? error.message : `Not saved: ${error.message}`}
      </span>
      <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
        <RotateCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Reload
      </Button>
      {error.kind !== "session" && (
        <Button size="sm" variant="ghost" onClick={dismiss} aria-label="Dismiss">
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
