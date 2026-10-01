"use client";

import { useEffect, useState } from "react";
import { fetchJsonNoStore } from "@/lib/client/http";

export function analyticsUrl(type: "daily" | "weekly" | "stats", date?: string) {
  const params = new URLSearchParams({ type });
  if (date) params.set("date", date);
  const timeZone =
    typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : "";
  if (timeZone) params.set("tz", timeZone);
  return `/api/analytics?${params.toString()}`;
}

export function useAnalyticsResource<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetchJsonNoStore<T>(url)
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return { data, loading };
}
