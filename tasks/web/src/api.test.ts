import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HttpCall } from "@ziyixi/proto/http-client";

// Each test starts from a fresh tab, which has no CSRF token yet.
let api: typeof import("./api");
beforeEach(async () => {
  vi.resetModules();
  api = await import("./api");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Every request the tab sends, with a write's CSRF token; `csrf` answers the token reads. */
function stubFetch(csrf: () => Response) {
  const sent: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      const token = new Headers(init.headers).get("X-CSRF-Token");
      sent.push(`${init.method ?? "GET"} ${input}${token ? ` ${token}` : ""}`);
      return input === "/api/tasks/csrf" ? csrf() : Response.json({});
    }),
  );
  return sent;
}
const write = {
  httpMethod: "POST",
  url: "/api/tasks/v1/tasks",
  body: "{}",
} as HttpCall;

it("reads the CSRF token at startup, so the first write does not wait for it", async () => {
  const sent = stubFetch(() => Response.json({ token: "synthetic-token" }));
  api.prepareWrites();
  // Sent before any write, beside the page's first reads; every write then reuses it.
  expect(sent).toEqual(["GET /api/tasks/csrf"]);
  await api.send(write);
  await api.send(write);
  expect(sent).toEqual([
    "GET /api/tasks/csrf",
    "POST /api/tasks/v1/tasks synthetic-token",
    "POST /api/tasks/v1/tasks synthetic-token",
  ]);
});

it("leaves the token to the first write when the startup read fails", async () => {
  let reads = 0;
  const sent = stubFetch(() =>
    ++reads === 1
      ? new Response("", { status: 503 })
      : Response.json({ token: "synthetic-token" }),
  );
  api.prepareWrites();
  await vi.waitFor(() => expect(reads).toBe(1));
  // The failed read is forgotten, never thrown at the page.
  await new Promise((resolve) => setTimeout(resolve));
  await api.send(write);
  expect(sent).toEqual([
    "GET /api/tasks/csrf",
    "GET /api/tasks/csrf",
    "POST /api/tasks/v1/tasks synthetic-token",
  ]);
});
