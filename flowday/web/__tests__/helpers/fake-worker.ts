/**
 * An in-memory stand-in for the Worker's API (worker/src/api.ts) for the UI's tests: the same paths, JSON shapes,
 * CSRF handshake and error envelope, on plain arrays. The Worker itself, on real D1, is tested in
 * worker/test/runtime. The seeding helpers keep the names of the container era's query functions so the ported
 * tests read the same.
 */
import type { AnalyticsDataset } from "@/lib/types/worker-contract";
import type { Task } from "@/lib/types/task";

interface Entry {
  id: string;
  taskId: string;
  flowDate: string;
  startTime: string;
  endTime: string | null;
  durationS: number | null;
  source: string;
  createdAt: string | null;
}

export interface FakeRequest {
  method: string;
  path: string;
  body: unknown;
  csrf: string | null;
}

export const FAKE_CSRF_TOKEN = "fake-csrf-token";

class FakeWorker {
  tasks = new Map<string, Task>();
  flows = new Map<string, string[]>();
  completed = new Map<string, string[]>();
  entries: Entry[] = [];
  settings = new Map<string, string>();
  session: Record<string, unknown> | null = null;
  requests: FakeRequest[] = [];
  /** Tests set this to make the next write answer 403 csrf_failed once (an expired token). */
  expireCsrfOnce = false;
  csrfToken = FAKE_CSRF_TOKEN;

  dataset(start: string | null, end: string | null): AnalyticsDataset {
    const within = (date: string) => start === null || end === null || (date >= start && date <= end);
    const rows = (map: Map<string, string[]>) =>
      [...map.entries()]
        .filter(([date]) => start !== null && end !== null && within(date))
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([flowDate, ids]) => ids.map((taskId) => ({ flowDate, taskId })));
    const flows = rows(this.flows);
    const completed = rows(this.completed);
    const entries = this.entries.filter((entry) => within(entry.flowDate));
    const ids = new Set([...flows, ...completed, ...entries].map((row) => row.taskId));
    return {
      start,
      end,
      flows,
      completed,
      entries: entries.map((entry) => ({ ...entry })),
      tasks: [...this.tasks.values()].filter((task) => ids.has(task.id)),
      dayCapacityMins: Number(this.settings.get("day_capacity_mins") ?? "360"),
    };
  }

  async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input.toString(), "http://flowday.test");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    this.requests.push({ method, path: url.pathname + url.search, body, csrf: headers.get("x-csrf-token") });
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    const fail = (status: number, code: string, message: string) => json({ error: { code, message, request_id: "test" } }, status);

    if (method !== "GET" && url.pathname !== "/api/csrf") {
      if (this.expireCsrfOnce) {
        this.expireCsrfOnce = false;
        this.csrfToken = `${FAKE_CSRF_TOKEN}-2`;
        return fail(403, "csrf_failed", "The page security token expired. Reload and try again.");
      }
      if (headers.get("x-csrf-token") !== this.csrfToken) return fail(403, "csrf_failed", "The page security token expired.");
    }
    const record = (body ?? {}) as Record<string, unknown>;
    switch (`${method} ${url.pathname}`) {
      case "GET /api/csrf":
        return json({ token: this.csrfToken });
      case "GET /api/entries": {
        const taskId = url.searchParams.get("taskId");
        const date = url.searchParams.get("date");
        return json(this.entries.filter((entry) => (taskId === null || entry.taskId === taskId) && (date === null || entry.flowDate === date)));
      }
      case "POST /api/entries": {
        const entry: Entry = {
          id: crypto.randomUUID(),
          taskId: String(record.taskId),
          flowDate: String(record.flowDate),
          startTime: String(record.startTime),
          endTime: (record.endTime as string | null | undefined) ?? null,
          durationS: (record.durationS as number | null | undefined) ?? null,
          source: (record.source as string | undefined) ?? "timer",
          createdAt: null,
        };
        this.entries.push(entry);
        return json(entry, 201);
      }
      case "GET /api/timer/session":
        return json({ session: this.session });
      case "PUT /api/timer/session":
        this.session = { ...record, updatedAt: new Date().toISOString() };
        return json({ success: true });
      case "DELETE /api/timer/session":
        this.session = null;
        return json({ success: true });
      case "GET /api/analytics":
        return json(this.dataset(url.searchParams.get("start"), url.searchParams.get("end")));
      case "GET /api/tasks":
        return json([...this.tasks.values()].filter((task) => task.deletedAt === null));
      case "GET /api/settings":
        return json({
          todoist_api_key: this.settings.has("todoist_api_key") ? "••••••••" : null,
          has_api_key: this.settings.has("todoist_api_key"),
          last_sync_at: this.settings.get("last_sync_at") ?? null,
          day_capacity_mins: Number(this.settings.get("day_capacity_mins") ?? "360"),
          planning_completed_today: false,
        });
      case "PUT /api/flows":
      case "PUT /api/settings":
      case "PATCH /api/tasks":
      case "DELETE /api/tasks":
      case "PUT /api/notes":
        return json({ success: true });
      default:
        return fail(404, "not_found", "Not found.");
    }
  }
}

export let fakeWorker = new FakeWorker();

/** A fresh fake (setup.ts calls it before each test) whose fetch is the global fetch. */
export function resetFakeWorker(): FakeWorker {
  fakeWorker = new FakeWorker();
  return fakeWorker;
}

export const fakeFetch: typeof fetch = (input, init) => fakeWorker.handle(input as RequestInfo | URL, init);

// ---- seeding helpers named like the container era's queries -------------------------------------------------------

export function upsertTasks(list: Task[]): void {
  for (const task of list) fakeWorker.tasks.set(task.id, { ...task });
}

export function setFlowTaskIds(date: string, ids: string[]): void {
  if (ids.length === 0) fakeWorker.flows.delete(date);
  else fakeWorker.flows.set(date, [...new Set(ids)]);
}

export function addCompletedFlowTask(date: string, taskId: string): void {
  const list = fakeWorker.completed.get(date) ?? [];
  if (!list.includes(taskId)) fakeWorker.completed.set(date, [...list, taskId]);
}

export function setSetting(key: string, value: string): void {
  fakeWorker.settings.set(key, value);
}

export function createTimeEntry(entry: Omit<Entry, "createdAt">): void {
  fakeWorker.entries.push({ ...entry, createdAt: null });
}

export function getEntriesByTask(taskId: string): Entry[] {
  return fakeWorker.entries.filter((entry) => entry.taskId === taskId);
}
