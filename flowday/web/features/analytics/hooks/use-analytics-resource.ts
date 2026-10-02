"use client";

import { useEffect, useState } from "react";
import { queryAnalytics } from "@/lib/client/flowday-api";
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
  // The rows a review needs: QueryAnalytics for its range (none: every time entry).
  const range = analyticsRange(type, date ?? "");
  const start = range?.start ?? null;
  const end = range?.end ?? null;

  useEffect(() => {
    let cancelled = false;
    const dates = start === null || end === null ? null : { start, end };
    void queryAnalytics(dates).then(
      (dataset) => {
        if (cancelled) return;
        const result = getAnalytics({ type, date: date ?? null, timeZone: browserTimeZone() }, dataset);
        setData(result.ok ? (result.data as AnalyticsData[K]) : null);
        setLoading(false);
      },
      () => {
        if (!cancelled) setLoading(false);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [start, end, type, date]);

  return { data, loading };
}
