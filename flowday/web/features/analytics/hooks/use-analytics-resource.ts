"use client";

import { useEffect, useState } from "react";
import { apiGetOrNull } from "@/lib/client/http";
import type { AnalyticsDataset } from "@/lib/types/worker-contract";
import {
  analyticsRange,
  getAnalytics,
  type AnalyticsType,
} from "../services/analytics-service";
import type {
  DailyAnalyticsData,
  WeeklyAnalyticsData,
  WorkPatternStatsData,
} from "../contracts";

/** The rows a review needs: GET /api/analytics for its range (none: every time entry). */
export function analyticsDatasetUrl(type: AnalyticsType, date = ""): string {
  const range = analyticsRange(type, date);
  if (range === null) return "/api/analytics";
  return `/api/analytics?${new URLSearchParams({ start: range.start, end: range.end }).toString()}`;
}

function browserTimeZone(): string | null {
  return typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : null;
}

interface AnalyticsData {
  daily: DailyAnalyticsData;
  weekly: WeeklyAnalyticsData;
  stats: WorkPatternStatsData;
}

/** Fetches a review's raw rows and computes it in the browser, in the browser's time zone. */
export function useAnalytics<K extends AnalyticsType>(type: K, date?: string) {
  const [data, setData] = useState<AnalyticsData[K] | null>(null);
  const [loading, setLoading] = useState(true);
  const url = analyticsDatasetUrl(type, date);

  useEffect(() => {
    let cancelled = false;
    void apiGetOrNull<AnalyticsDataset>(url).then((dataset) => {
      if (cancelled) return;
      if (dataset) {
        const result = getAnalytics({ type, date: date ?? null, timeZone: browserTimeZone() }, dataset);
        setData(result.ok ? (result.data as AnalyticsData[K]) : null);
      }
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [url, type, date]);

  return { data, loading };
}
