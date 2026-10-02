/**
 * An in-memory stand-in for the Worker's owner API for the UI's tests: FlowDayUiService (proto/flowday/ui/v1) served by
 * the same shared transcoder the Worker uses (proto/ts/http-transcoder.ts), so requests and answers are the real wire
 * (paths, update masks, wire JSON, google.rpc.Status errors), with the CSRF handshake, on plain maps. The Worker
 * itself, on real D1, is tested in worker/test/runtime. The seeding helpers keep the names of the container era's
 * query functions so the ported tests read the same.
 */
import { FlowSchema, NoteSchema } from "@ziyixi/proto/flowday/ui/v1/flow_pb";
import {
  FlowDayUiService,
  ListFlowsResponseSchema,
  ListNotesResponseSchema,
  ListTasksResponseSchema,
  ListTimeEntriesResponseSchema,
  QueryAnalyticsResponseSchema,
  RolloverFlowResponseSchema,
  SyncTasksResponse_State,
  SyncTasksResponseSchema,
} from "@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb";
import { SettingsSchema } from "@ziyixi/proto/flowday/ui/v1/settings_pb";
import { TaskSchema, type Task as TaskMessage } from "@ziyixi/proto/flowday/ui/v1/task_pb";
import {
  TimeEntry_Source,
  TimeEntrySchema,
  TimerSession_Mode,
  TimerSession_State,
  TimerSessionSchema,
  type TimeEntry as TimeEntryMessage,
  type TimerSession,
} from "@ziyixi/proto/flowday/ui/v1/time_entry_pb";
import { HttpTranscoder, type ServiceHandlers, type ShapeOf } from "@ziyixi/proto/http-transcoder";
import { create } from "@ziyixi/proto/protobuf";
import { EmptySchema, timestampDate, timestampFromDate, timestampFromMs, type Timestamp } from "@ziyixi/proto/protobuf/wkt";
import { Code, RpcError } from "@ziyixi/proto/rpc-status";
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
  /** Path and query, as sent. */
  path: string;
  /** The JSON body, parsed (undefined without one). */
  body: unknown;
  csrf: string | null;
}

export const FAKE_CSRF_TOKEN = "fake-csrf-token";

const at = (iso: string | null) => (iso === null ? undefined : timestampFromDate(new Date(iso)));
const iso = (timestamp: Timestamp | undefined) => (timestamp === undefined ? null : timestampDate(timestamp).toISOString());
const notFound = () => new RpcError(Code.NOT_FOUND, "NOT_FOUND", "no such resource");
const idOf = (name: string) => name.slice(name.lastIndexOf("/") + 1);

function taskMessage(task: Task): TaskMessage {
  return create(TaskSchema, {
    name: `tasks/${task.id}`,
    todoistId: task.todoistId ?? "",
    title: task.title,
    description: task.description ?? "",
    projectDisplayName: task.projectName ?? "",
    projectColor: task.projectColor ?? "",
    priority: task.priority,
    labels: task.labels,
    ...(task.estimatedMins === null ? {} : { estimatedMinutes: task.estimatedMins }),
    completed: task.isCompleted,
    completeTime: at(task.completedAt),
    dueDate: task.dueDate ?? "",
    createTime: at(task.createdAt),
    deleteTime: at(task.deletedAt),
  });
}

function entryMessage(entry: Entry): TimeEntryMessage {
  return create(TimeEntrySchema, {
    name: `timeEntries/${entry.id}`,
    taskId: entry.taskId,
    flowDate: entry.flowDate,
    startTime: at(entry.startTime),
    endTime: at(entry.endTime),
    ...(entry.durationS === null ? {} : { durationSeconds: entry.durationS }),
    source: entry.source === "manual" ? TimeEntry_Source.MANUAL : TimeEntry_Source.TIMER,
  });
}

interface Context {
  readonly fake: FakeWorker;
}

class FakeWorker {
  tasks = new Map<string, Task>();
  flows = new Map<string, string[]>();
  completed = new Map<string, string[]>();
  planned = new Set<string>();
  entries: Entry[] = [];
  notes = new Map<string, string>();
  settings = new Map<string, string>();
  session: TimerSession | null = null;
  requests: FakeRequest[] = [];
  /** Tests set this to make the next write answer 403 CSRF_FAILED once (an expired token). */
  expireCsrfOnce = false;
  csrfToken = FAKE_CSRF_TOKEN;
  /** The answer of the next SyncTasks calls (tests set it). */
  syncAnswers: { state: SyncTasksResponse_State; changed: number; fullSync: boolean }[] = [];

  flowMessage(date: string) {
    return create(FlowSchema, { name: `flows/${date}`, taskIds: this.flows.get(date) ?? [], completedTaskIds: this.completed.get(date) ?? [], planningCompleted: this.planned.has(date) });
  }

  async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input.toString(), "http://flowday.test");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    this.requests.push({ method, path: url.pathname + url.search, body, csrf: headers.get("x-csrf-token") });
    if (method === "GET" && url.pathname === "/api/csrf") {
      return new Response(JSON.stringify({ token: this.csrfToken }), { headers: { "content-type": "application/json" } });
    }
    const request = new Request(url, { method, headers, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const result = await transcoder.handle(request, { fake: this }, "test");
    return result?.response ?? transcoder.errorResponse(notFound(), "test");
  }
}

/** Every rpc on the in-memory maps (only as much behaviour as the UI's tests need; validation is the Worker's). */
const handlers: ServiceHandlers<ShapeOf<typeof FlowDayUiService>, Context> = {
  async getTask({ name }, { fake }) {
    const task = fake.tasks.get(idOf(name));
    if (task === undefined) throw notFound();
    return taskMessage(task);
  },
  async listTasks({ showDeleted }, { fake }) {
    const tasks = [...fake.tasks.values()].filter((task) => task.deletedAt === null || showDeleted);
    return create(ListTasksResponseSchema, { tasks: tasks.map(taskMessage) });
  },
  async createTask({ task, requestId }, { fake }) {
    const id = `local-${requestId === "" ? crypto.randomUUID() : requestId}`;
    const stored: Task = {
      id,
      todoistId: null,
      title: task?.title.trim() ?? "",
      description: null,
      projectName: null,
      projectColor: null,
      priority: 1,
      labels: [],
      estimatedMins: null,
      isCompleted: false,
      completedAt: null,
      dueDate: task?.dueDate === "" ? null : (task?.dueDate ?? null),
      createdAt: new Date().toISOString(),
      deletedAt: null,
    };
    if (!fake.tasks.has(id)) fake.tasks.set(id, stored);
    return taskMessage(fake.tasks.get(id) ?? stored);
  },
  async updateTask({ task, updateMask }, { fake }) {
    const stored = fake.tasks.get(idOf(task?.name ?? ""));
    if (stored === undefined || task === undefined) throw notFound();
    const paths = updateMask?.paths ?? ["title", "estimated_minutes"];
    if (paths.includes("title")) stored.title = task.title.trim();
    if (paths.includes("estimated_minutes")) stored.estimatedMins = task.estimatedMinutes ?? null;
    return taskMessage(stored);
  },
  async deleteTask({ name }, { fake }) {
    const stored = fake.tasks.get(idOf(name));
    if (stored === undefined) throw notFound();
    stored.deletedAt = new Date().toISOString();
    return taskMessage(stored);
  },
  async undeleteTask({ name }, { fake }) {
    const stored = fake.tasks.get(idOf(name));
    if (stored === undefined) throw notFound();
    stored.deletedAt = null;
    return taskMessage(stored);
  },
  async syncTasks(_request, { fake }) {
    const answer = fake.syncAnswers.shift() ?? { state: SyncTasksResponse_State.SYNCED, changed: 0, fullSync: false };
    const now = Date.now();
    fake.settings.set("last_sync_at", new Date(now).toISOString());
    return create(SyncTasksResponseSchema, {
      state: answer.state,
      changedTaskCount: answer.changed,
      fullSync: answer.fullSync,
      lastSyncTime: timestampFromMs(now),
      nextAutoSyncTime: timestampFromMs(now + 300_000),
    });
  },
  async getFlow({ name }, { fake }) {
    return fake.flowMessage(idOf(name));
  },
  async listFlows(_request, { fake }) {
    const dates = [...new Set([...fake.flows.keys(), ...fake.completed.keys(), ...fake.planned])].sort();
    return create(ListFlowsResponseSchema, { flows: dates.map((date) => fake.flowMessage(date)) });
  },
  async updateFlow({ flow, updateMask }, { fake }) {
    const date = idOf(flow?.name ?? "");
    const paths = updateMask?.paths ?? ["task_ids", "planning_completed"];
    if (paths.includes("task_ids")) setFlowTaskIds(date, flow?.taskIds ?? []);
    if (paths.includes("planning_completed")) {
      if (flow?.planningCompleted === true) fake.planned.add(date);
      else fake.planned.delete(date);
    }
    return fake.flowMessage(date);
  },
  async completeFlowTask({ name, taskId }, { fake }) {
    addCompletedFlowTask(idOf(name), taskId);
    return fake.flowMessage(idOf(name));
  },
  async reopenFlowTask({ name, taskId }, { fake }) {
    const date = idOf(name);
    fake.completed.set(date, (fake.completed.get(date) ?? []).filter((id) => id !== taskId));
    return fake.flowMessage(date);
  },
  async rolloverFlow({ name, destination, taskIds }, { fake }) {
    const from = idOf(name);
    const to = idOf(destination);
    const done = new Set(fake.completed.get(from) ?? []);
    const source = fake.flows.get(from) ?? [];
    const moving = taskIds.length === 0 ? source.filter((id) => !done.has(id)) : source.filter((id) => taskIds.includes(id));
    const existing = fake.flows.get(to) ?? [];
    setFlowTaskIds(to, [...moving.filter((id) => !existing.includes(id)), ...existing]);
    setFlowTaskIds(from, source.filter((id) => !moving.includes(id)));
    return create(RolloverFlowResponseSchema, { flow: fake.flowMessage(from), destinationFlow: fake.flowMessage(to) });
  },
  async getNote({ name }, { fake }) {
    return create(NoteSchema, { name, content: fake.notes.get(name) ?? "" });
  },
  async listNotes({ parent }, { fake }) {
    const notes = [...fake.notes.entries()].filter(([name]) => name.startsWith(`${parent}/notes/`));
    return create(ListNotesResponseSchema, { notes: notes.map(([name, content]) => create(NoteSchema, { name, content })) });
  },
  async updateNote({ note }, { fake }) {
    fake.notes.set(note?.name ?? "", note?.content ?? "");
    return create(NoteSchema, { name: note?.name ?? "", content: note?.content ?? "" });
  },
  async getTimeEntry({ name }, { fake }) {
    const entry = fake.entries.find((candidate) => candidate.id === idOf(name));
    if (entry === undefined) throw notFound();
    return entryMessage(entry);
  },
  async listTimeEntries({ taskId, flowDate }, { fake }) {
    const entries = fake.entries.filter((entry) => (taskId === "" || entry.taskId === taskId) && (flowDate === "" || entry.flowDate === flowDate));
    return create(ListTimeEntriesResponseSchema, { timeEntries: entries.map(entryMessage) });
  },
  async createTimeEntry({ timeEntry, requestId }, { fake }) {
    const entry: Entry = {
      id: requestId === "" ? crypto.randomUUID() : requestId,
      taskId: timeEntry?.taskId ?? "",
      flowDate: timeEntry?.flowDate ?? "",
      startTime: iso(timeEntry?.startTime) ?? "",
      endTime: iso(timeEntry?.endTime),
      durationS: timeEntry?.durationSeconds ?? null,
      source: timeEntry?.source === TimeEntry_Source.MANUAL ? "manual" : "timer",
      createdAt: null,
    };
    fake.entries.push(entry);
    return entryMessage(entry);
  },
  async updateTimeEntry({ timeEntry }, { fake }) {
    const entry = fake.entries.find((candidate) => candidate.id === idOf(timeEntry?.name ?? ""));
    if (entry === undefined || timeEntry === undefined) throw notFound();
    entry.startTime = iso(timeEntry.startTime) ?? entry.startTime;
    entry.endTime = iso(timeEntry.endTime) ?? entry.endTime;
    entry.durationS = Math.floor((Date.parse(entry.endTime ?? entry.startTime) - Date.parse(entry.startTime)) / 1000);
    return entryMessage(entry);
  },
  async deleteTimeEntry({ name }, { fake }) {
    const before = fake.entries.length;
    fake.entries = fake.entries.filter((entry) => entry.id !== idOf(name));
    if (fake.entries.length === before) throw notFound();
    return create(EmptySchema);
  },
  async getTimerSession(_request, { fake }) {
    return fake.session ?? create(TimerSessionSchema, { name: "timerSession", state: TimerSession_State.IDLE, mode: TimerSession_Mode.COUNT_UP });
  },
  async updateTimerSession({ timerSession }, { fake }) {
    const session = timerSession ?? create(TimerSessionSchema);
    session.name = "timerSession";
    session.updateTime = timestampFromMs(Date.now());
    fake.session = session;
    return session;
  },
  async clearTimerSession(_request, { fake }) {
    fake.session = null;
    return create(TimerSessionSchema, { name: "timerSession", state: TimerSession_State.IDLE, mode: TimerSession_Mode.COUNT_UP });
  },
  async getSettings(_request, { fake }) {
    return create(SettingsSchema, {
      name: "settings",
      todoistApiKeySet: fake.settings.has("todoist_api_key"),
      dayCapacityMinutes: Number(fake.settings.get("day_capacity_mins") ?? "360"),
      lastSyncTime: at(fake.settings.get("last_sync_at") ?? null),
    });
  },
  async updateSettings({ settings, updateMask }, { fake }) {
    const paths = updateMask?.paths ?? ["todoist_api_key", "day_capacity_minutes"];
    if (paths.includes("todoist_api_key")) fake.settings.set("todoist_api_key", "sealed");
    if (paths.includes("day_capacity_minutes")) fake.settings.set("day_capacity_mins", String(settings?.dayCapacityMinutes ?? 0));
    return handlers.getSettings({ $typeName: "flowday.ui.v1.GetSettingsRequest", name: "settings" }, { fake });
  },
  async queryAnalytics({ startDate, endDate }, { fake }) {
    const ranged = startDate !== "" && endDate !== "";
    const within = (date: string) => !ranged || (date >= startDate && date <= endDate);
    const dates = ranged ? [...new Set([...fake.flows.keys(), ...fake.completed.keys()])].filter(within).sort() : [];
    const flows = dates.map((date) => create(FlowSchema, { name: `flows/${date}`, taskIds: fake.flows.get(date) ?? [], completedTaskIds: fake.completed.get(date) ?? [] }));
    const entries = fake.entries.filter((entry) => within(entry.flowDate));
    const ids = new Set([...flows.flatMap((flow) => [...flow.taskIds, ...flow.completedTaskIds]), ...entries.map((entry) => entry.taskId)]);
    return create(QueryAnalyticsResponseSchema, {
      timeEntries: entries.map(entryMessage),
      flows,
      tasks: [...fake.tasks.values()].filter((task) => ids.has(task.id)).map(taskMessage),
      dayCapacityMinutes: Number(fake.settings.get("day_capacity_mins") ?? "360"),
    });
  },
};

const transcoder = new HttpTranscoder(FlowDayUiService, handlers, {
  domain: "flowday.ziyixi.science",
  maxBodyBytes: 256 * 1024,
  localize: (reason) => (reason === "NOT_FOUND" ? { locale: "en", message: "Not found." } : reason === "CSRF_FAILED" ? { locale: "en", message: "The page security token expired. Reload and try again." } : undefined),
  // The CSRF check of every write, as the Worker's.
  authorize(request, route, { fake }) {
    if (route.safe) return;
    if (fake.expireCsrfOnce) {
      fake.expireCsrfOnce = false;
      fake.csrfToken = `${FAKE_CSRF_TOKEN}-2`;
      throw new RpcError(Code.PERMISSION_DENIED, "CSRF_FAILED", "the CSRF token or Origin is not valid");
    }
    if (request.headers.get("x-csrf-token") !== fake.csrfToken) throw new RpcError(Code.PERMISSION_DENIED, "CSRF_FAILED", "the CSRF token or Origin is not valid");
  },
});

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
