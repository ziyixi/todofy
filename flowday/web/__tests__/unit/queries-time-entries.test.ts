import { describe, it, expect } from "vitest";
import {
  createTimeEntry,
  deleteTimeEntry,
  getAllTimeEntries,
  getEntriesByDate,
  getEntriesByTask,
  getEntriesByTaskAndDate,
  getEntriesInDateRange,
  updateTimeEntry,
} from "@/lib/db/queries/entries";

describe("time entry queries", () => {
  it("creates and retrieves entries by task", () => {
    createTimeEntry({
      id: "e1",
      taskId: "t1",
      flowDate: "2026-04-13",
      startTime: "2026-04-13T09:00:00Z",
      endTime: "2026-04-13T09:30:00Z",
      durationS: 1800,
      source: "timer",
    });

    const entries = getEntriesByTask("t1");
    expect(entries).toHaveLength(1);
    expect(entries[0].taskId).toBe("t1");
    expect(entries[0].durationS).toBe(1800);
  });

  it("retrieves entries by date", () => {
    createTimeEntry({
      id: "e1",
      taskId: "t1",
      flowDate: "2026-04-13",
      startTime: "2026-04-13T09:00:00Z",
      endTime: "2026-04-13T09:30:00Z",
      durationS: 1800,
      source: "timer",
    });
    createTimeEntry({
      id: "e2",
      taskId: "t2",
      flowDate: "2026-04-14",
      startTime: "2026-04-14T10:00:00Z",
      endTime: "2026-04-14T10:15:00Z",
      durationS: 900,
      source: "manual",
    });

    expect(getEntriesByDate("2026-04-13")).toHaveLength(1);
    expect(getEntriesByDate("2026-04-14")).toHaveLength(1);
    expect(getEntriesByDate("2026-04-15")).toHaveLength(0);
  });

  it("retrieves entries by task and date", () => {
    createTimeEntry({
      id: "e1",
      taskId: "t1",
      flowDate: "2026-04-13",
      startTime: "2026-04-13T09:00:00Z",
      endTime: null,
      durationS: 600,
      source: "timer",
    });
    createTimeEntry({
      id: "e2",
      taskId: "t1",
      flowDate: "2026-04-14",
      startTime: "2026-04-14T09:00:00Z",
      endTime: null,
      durationS: 300,
      source: "timer",
    });

    const result = getEntriesByTaskAndDate("t1", "2026-04-13");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("e1");
  });

  it("updates an entry", () => {
    createTimeEntry({
      id: "e1",
      taskId: "t1",
      flowDate: "2026-04-13",
      startTime: "2026-04-13T09:00:00Z",
      endTime: "2026-04-13T09:30:00Z",
      durationS: 1800,
      source: "timer",
    });

    const updated = updateTimeEntry("e1", {
      startTime: "2026-04-13T10:00:00Z",
      endTime: "2026-04-13T11:00:00Z",
      durationS: 3600,
    });
    expect(updated).toBe(true);

    const entries = getEntriesByTask("t1");
    expect(entries[0].durationS).toBe(3600);
    expect(entries[0].startTime).toBe("2026-04-13T10:00:00Z");
  });

  it("returns false when updating non-existent entry", () => {
    expect(
      updateTimeEntry("nonexistent", {
        startTime: "2026-04-13T10:00:00Z",
        endTime: "2026-04-13T11:00:00Z",
        durationS: 3600,
      })
    ).toBe(false);
  });

  it("deletes an entry", () => {
    createTimeEntry({
      id: "e1",
      taskId: "t1",
      flowDate: "2026-04-13",
      startTime: "2026-04-13T09:00:00Z",
      endTime: null,
      durationS: 600,
      source: "timer",
    });

    expect(deleteTimeEntry("e1")).toBe(true);
    expect(getEntriesByTask("t1")).toHaveLength(0);
  });

  it("returns false when deleting non-existent entry", () => {
    expect(deleteTimeEntry("nonexistent")).toBe(false);
  });

  it("getEntriesInDateRange filters correctly", () => {
    createTimeEntry({
      id: "e1",
      taskId: "t1",
      flowDate: "2026-04-10",
      startTime: "2026-04-10T09:00:00Z",
      endTime: null,
      durationS: 600,
      source: "timer",
    });
    createTimeEntry({
      id: "e2",
      taskId: "t1",
      flowDate: "2026-04-12",
      startTime: "2026-04-12T09:00:00Z",
      endTime: null,
      durationS: 600,
      source: "timer",
    });
    createTimeEntry({
      id: "e3",
      taskId: "t1",
      flowDate: "2026-04-15",
      startTime: "2026-04-15T09:00:00Z",
      endTime: null,
      durationS: 600,
      source: "timer",
    });

    const range = getEntriesInDateRange("2026-04-11", "2026-04-14");
    expect(range).toHaveLength(1);
    expect(range[0].id).toBe("e2");
  });

  it("getAllTimeEntries returns all entries", () => {
    createTimeEntry({
      id: "e1",
      taskId: "t1",
      flowDate: "2026-04-10",
      startTime: "2026-04-10T09:00:00Z",
      endTime: null,
      durationS: 600,
      source: "timer",
    });
    createTimeEntry({
      id: "e2",
      taskId: "t2",
      flowDate: "2026-04-12",
      startTime: "2026-04-12T09:00:00Z",
      endTime: null,
      durationS: 300,
      source: "manual",
    });

    expect(getAllTimeEntries()).toHaveLength(2);
  });
});
