export interface TodoistApiTask {
  id: string;
  content: string;
  description: string;
  project_id: string;
  priority: number;
  labels: string[];
  due: { date: string; is_recurring: boolean } | null;
  duration: { amount: number; unit: string } | null;
  created_at: string;
  completed_at: string | null;
  is_completed: boolean;
}

export interface TodoistApiProject {
  id: string;
  name: string;
  color: string;
}

interface PaginatedResponse<T> {
  results: T[];
  next_cursor: string | null;
}

const TODOIST_BASE = "https://api.todoist.com/api/v1";

async function fetchPaginated<T>(
  url: string,
  apiKey: string,
  extraParams?: Record<string, string>
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;

  for (;;) {
    const params = new URLSearchParams();
    params.set("limit", "200");
    if (cursor) params.set("cursor", cursor);
    if (extraParams) {
      for (const [k, v] of Object.entries(extraParams)) {
        params.set(k, v);
      }
    }

    const res = await fetch(`${url}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });

    if (!res.ok) {
      throw new Error(`Todoist API error: ${res.status} ${res.statusText}`);
    }

    const data: PaginatedResponse<T> = await res.json();
    all.push(...data.results);

    if (!data.next_cursor) break;
    cursor = data.next_cursor;
  }

  return all;
}

export async function fetchTodoistTasks(
  apiKey: string
): Promise<TodoistApiTask[]> {
  return fetchPaginated<TodoistApiTask>(`${TODOIST_BASE}/tasks`, apiKey);
}

export async function fetchTodoistProjects(
  apiKey: string
): Promise<TodoistApiProject[]> {
  return fetchPaginated<TodoistApiProject>(`${TODOIST_BASE}/projects`, apiKey);
}
