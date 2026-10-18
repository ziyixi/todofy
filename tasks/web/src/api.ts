import {
  createHttpClient,
  HttpResponseError,
  RpcStatusError,
  type HttpCall,
} from "@ziyixi/proto/http-client";
import {
  TasksUiService,
  type Catalog as ApiCatalog,
} from "@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb";
import type {
  Task as ApiTask,
  Project,
  Section,
  Label,
  SavedFilter,
} from "@ziyixi/proto/tasks/ui/v1/task_pb";
import { clearDetailReadCache } from "./detail-read-cache";

export type Task = ApiTask;
export type Catalog = Pick<
  ApiCatalog,
  "projects" | "sections" | "labels" | "filters" | "timeZone"
> &
  Partial<Pick<ApiCatalog, "taskCounts">>;
export type TaskDraft = Pick<
  Task,
  | "title"
  | "description"
  | "projectId"
  | "sectionId"
  | "parentId"
  | "labelIds"
  | "priority"
  | "dueDate"
  | "dueDatetime"
  | "dueTimezone"
  | "deadline"
  | "durationMinutes"
  | "recurrence"
  | "kind"
  | "effort"
>;
export type CatalogItem = Project | Section | Label | SavedFilter;
export type CatalogKind = "project" | "section" | "label" | "filter";
export const EMPTY_CATALOG: Catalog = {
  projects: [],
  sections: [],
  labels: [],
  filters: [],
  timeZone: "",
};
let csrf: Promise<string> | undefined;
async function csrfToken(): Promise<string> {
  csrf ??= fetch("/api/tasks/csrf", {
    credentials: "same-origin",
    cache: "no-store",
  })
    .then(async (response) => {
      if ([401, 403].includes(response.status)) clearDetailReadCache();
      if (!response.ok)
        throw new Error(
          "Could not verify your session. Refresh and sign in again.",
        );
      const result: unknown = await response.json();
      if (
        !result ||
        typeof result !== "object" ||
        !("token" in result) ||
        typeof result.token !== "string"
      )
        throw new Error("Invalid session response. Refresh and try again.");
      return result.token;
    })
    .catch((error: unknown) => {
      csrf = undefined;
      throw error;
    });
  return csrf;
}
export async function send(call: HttpCall): Promise<Response> {
  const mutation = !["GET", "HEAD"].includes(call.httpMethod);
  const headers = new Headers({ Accept: "application/json" });
  if (call.body !== undefined) headers.set("Content-Type", "application/json");
  if (mutation) headers.set("X-CSRF-Token", await csrfToken());
  let response: Response;
  try {
    response = await fetch(call.url, {
      method: call.httpMethod,
      body: call.body,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  } catch (error) {
    if (mutation) clearDetailReadCache();
    throw error;
  }
  if (mutation || [401, 403, 409].includes(response.status))
    clearDetailReadCache();
  if (response.status === 401 || response.status === 403) csrf = undefined;
  return response;
}
export const api = createHttpClient(TasksUiService, send);
export function describeError(reason: unknown): string {
  if (reason instanceof RpcStatusError)
    return reason.status.localizedMessage?.message || reason.status.message;
  if (
    reason instanceof HttpResponseError &&
    (reason.httpStatus === 401 || reason.httpStatus === 403)
  )
    return "Your session needs attention. Refresh to sign in again.";
  return reason instanceof Error &&
    reason.message.startsWith("Could not verify")
    ? reason.message
    : "Could not confirm this change. Check your connection and try again.";
}
export const TASK_EDIT_FIELDS = [
  "title",
  "description",
  "project_id",
  "section_id",
  "parent_id",
  "label_ids",
  "priority",
  "due_date",
  "due_datetime",
  "due_timezone",
  "deadline",
  "duration_minutes",
  "recurrence",
  "kind",
  "effort",
];
