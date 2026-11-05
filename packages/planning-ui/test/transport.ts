import type { HttpSend } from "@ziyixi/proto/http-client";
import { createPlanningActions } from "../src/api";
import type { FocusState } from "../src/model";

/** The planning actions over one fake fetch, at the paths Tasks serves them on its own origin (`/api/tasks/v1/…`). */
export function fakeActions(
  fetcher: (input: URL, init: RequestInit) => Promise<Response>,
) {
  const transport: HttpSend = (call) =>
    fetcher(new URL(call.url, "https://tasks.example.test"), {
      method: call.httpMethod,
      body: call.body,
    });
  return createPlanningActions({ tasks: transport });
}

export const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });

/** Every day from `start` to `end`, as ListFocusDays lists them; no range is Tasks' today's week. */
export function focusDays(url: URL, queues: Record<string, string[]> = {}) {
  const days = [];
  const end = url.searchParams.get("end_day") || "2026-10-18";
  for (
    let day = url.searchParams.get("start_day") || "2026-10-12";
    day <= end;
    day = new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10)
  )
    days.push({ day, task_ids: queues[day] ?? [] });
  return days;
}

export const focusState = (
  timerEtag: string,
  overrides: Partial<FocusState> = {},
): FocusState => ({
  date: "2026-10-13",
  timerEtag,
  taskIds: ["child"],
  completedTaskIds: [],
  entries: [],
  estimates: {},
  tasks: {},
  ...overrides,
});

/** A Tasks stub: the synthetic answers by method and path, with every request it received. */
export function tasksStub(answers: Record<string, () => Response>) {
  const requests: {
    method: string;
    path: string;
    etag?: string;
    body: unknown;
  }[] = [];
  const api = fakeActions(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({
      method,
      path: url.pathname,
      ...(url.searchParams.has("etag")
        ? { etag: url.searchParams.get("etag")! }
        : {}),
      body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
    });
    const answer = answers[`${method} ${url.pathname}`];
    if (!answer)
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    return answer();
  });
  return { api, requests };
}

export const refused = (reason: string, status: number) =>
  Response.json(
    {
      error: {
        code: status,
        message: "synthetic refusal",
        status: status === 404 ? "NOT_FOUND" : "FAILED_PRECONDITION",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason,
            domain: "tasks.ziyixi.science",
          },
        ],
      },
    },
    { status },
  );

/**
 * Tasks' MoveFocusStep over synthetic queues: no source adds, no destination removes, the same day
 * reorders and two days move, before `before_task_id` or last. Its answer lists each changed day.
 */
export function focusQueues(queues: Map<string, string[]>) {
  const read = (day: string) => queues.get(day) ?? [];
  return (body: {
    task_id: string;
    source_day?: string;
    destination_day?: string;
    before_task_id?: string;
  }) => {
    const { task_id: id, source_day: source, destination_day: target } = body;
    if (source && !read(source).includes(id))
      return { status: 400, error: "This step has moved." };
    if (source)
      queues.set(
        source,
        read(source).filter((item) => item !== id),
      );
    if (target) {
      const queue = read(target).filter((item) => item !== id);
      const before = body.before_task_id
        ? queue.indexOf(body.before_task_id)
        : -1;
      queue.splice(before < 0 ? queue.length : before, 0, id);
      queues.set(target, queue);
    }
    return {
      days: [...new Set([source, target].filter(Boolean))].map((day) => ({
        day,
        task_ids: read(day!),
      })),
    };
  };
}
