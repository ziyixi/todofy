import { afterEach, describe, expect, it, vi } from "vitest";
import { createTimeEntry, flowday, loadTasks, saveDayCapacity, saveNote, persistFlowTasks } from "@/lib/client/flowday-api";
import { read, setCsrfTokenForTests, write } from "@/lib/client/http";
import { useApiStatus } from "@/lib/client/api-status";
import { FAKE_CSRF_TOKEN, fakeFetch, fakeWorker } from "../helpers/fake-worker";

/**
 * The transport of the owner API client (lib/client/http.ts under lib/client/flowday-api.ts): the CSRF handshake, the
 * retry after an expired token, and visible failures for writes and expired sign-ins, on the real wire (the fake
 * Worker serves flowday.ui.v1 through the shared transcoder).
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

const statusBody = (httpStatus: number, status: string, reason: string, message: string) =>
  new Response(
    JSON.stringify({
      error: {
        code: httpStatus,
        message: "for developers",
        status,
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "flowday.ziyixi.science" },
          { "@type": "type.googleapis.com/google.rpc.LocalizedMessage", locale: "en", message },
        ],
      },
    }),
    { status: httpStatus, headers: { "content-type": "application/json" } }
  );

describe("CSRF", () => {
  it("fetches a token once, sends it with every write, and keeps it", async () => {
    setCsrfTokenForTests(null);
    vi.stubGlobal("fetch", fakeFetch);
    expect(await saveDayCapacity(300)).toBe(true);
    expect(await saveDayCapacity(360)).toBe(true);
    expect(fakeWorker.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /api/csrf",
      "PATCH /api/v1/settings?update_mask=day_capacity_minutes",
      "PATCH /api/v1/settings?update_mask=day_capacity_minutes",
    ]);
    expect(fakeWorker.requests.filter((request) => request.method === "PATCH").every((request) => request.csrf === FAKE_CSRF_TOKEN)).toBe(true);
    expect(fakeWorker.requests[2]?.body).toEqual({ day_capacity_minutes: 360 });
  });

  it("an expired token (403 CSRF_FAILED) is refreshed and the write sent once more; it is saved and nothing is shown", async () => {
    vi.stubGlobal("fetch", fakeFetch);
    fakeWorker.expireCsrfOnce = true;
    const entry = await createTimeEntry({ taskId: "t1", flowDate: "2026-04-13", startTime: "2026-04-13T09:00:00Z", endTime: null, durationS: null, source: "timer" });
    expect(entry).toMatchObject({ taskId: "t1", startTime: "2026-04-13T09:00:00.000Z" });
    expect(fakeWorker.entries).toHaveLength(1);
    const [first, csrf, second] = fakeWorker.requests;
    expect([first?.method, csrf?.path, second?.method]).toEqual(["POST", "/api/csrf", "POST"]);
    // The same request both times: one request_id, so the Worker stores the entry once.
    expect(second?.path).toBe(first?.path);
    expect(first?.path).toMatch(/^\/api\/v1\/timeEntries\?request_id=[0-9a-f-]{36}$/);
    expect(useApiStatus.getState().error).toBeNull();
  });

  it("a second CSRF_FAILED is not retried again: the write fails visibly", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input) === "/api/csrf"
        ? new Response(JSON.stringify({ token: "t" }), { headers: { "content-type": "application/json" } })
        : statusBody(403, "PERMISSION_DENIED", "CSRF_FAILED", "The page security token expired. Reload and try again.")
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await saveNote("t1", "2026-04-13", "x")).toBe(false);
    // write, token refresh, the write once more; no further retry
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(useApiStatus.getState().error).toEqual({ kind: "http", message: "The page security token expired. Reload and try again." });
  });
});

describe("failures are visible", () => {
  it("an expired Access session (redirect) fails as session, is never retried, and shows Reload", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://example.cloudflareaccess.com/login" } }));
    vi.stubGlobal("fetch", fetchMock);
    let recovered = false;
    persistFlowTasks("2026-04-13", ["t1"], () => {
      recovered = true;
    });
    await vi.waitFor(() => expect(recovered).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useApiStatus.getState().error).toEqual({ kind: "session", message: "Your sign-in has expired. Reload FlowDay to sign in again." });
  });

  it("a login page served as HTML (200) is a session failure, for reads too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } })));
    expect(await loadTasks()).toBeNull();
    expect(useApiStatus.getState().error?.kind).toBe("session");
  });

  it("the Worker's own 401 is a session failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => statusBody(401, "UNAUTHENTICATED", "UNAUTHORIZED", "Not signed in.")));
    await expect(read(() => flowday.listTasks({}))).rejects.toMatchObject({ kind: "session" });
  });

  it("a write's error shows the Worker's LocalizedMessage and reason; a quiet one does not; a network error shows", async () => {
    vi.stubGlobal("fetch", fakeFetch);
    await expect(write(() => flowday.deleteTask({ name: "tasks/nowhere" }))).rejects.toMatchObject({ kind: "http", status: 404, reason: "NOT_FOUND" });
    expect(useApiStatus.getState().error).toEqual({ kind: "http", message: "Not found." });
    useApiStatus.getState().dismiss();
    await expect(write(() => flowday.deleteTask({ name: "tasks/nowhere" }), { quiet: true })).rejects.toMatchObject({ status: 404 });
    expect(useApiStatus.getState().error).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    expect(await saveNote("t1", "2026-04-13", "x")).toBe(false);
    expect(useApiStatus.getState().error?.kind).toBe("network");
  });

  it("a request the client cannot lay out is never sent", async () => {
    const fetchMock = vi.fn(fakeFetch);
    vi.stubGlobal("fetch", fetchMock);
    await expect(write(() => flowday.deleteTask({ name: "projects/x" }))).rejects.toMatchObject({ kind: "http", status: 400, reason: "BAD_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an expired session cannot be dismissed or replaced by a later failure", () => {
    useApiStatus.getState().report({ kind: "session", message: "expired" });
    useApiStatus.getState().report({ kind: "http", message: "later" });
    useApiStatus.getState().dismiss();
    expect(useApiStatus.getState().error).toEqual({ kind: "session", message: "expired" });
  });

  it("reads never send a body or a token and never follow redirects", async () => {
    const fetchMock = vi.fn(fakeFetch);
    vi.stubGlobal("fetch", fetchMock);
    await loadTasks();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/tasks", expect.objectContaining({ method: "GET", redirect: "manual", cache: "no-store", credentials: "same-origin" }));
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has("x-csrf-token")).toBe(false);
  });
});
