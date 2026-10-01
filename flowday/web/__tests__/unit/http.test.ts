import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGet, apiGetOrNull, apiSend, apiSendOk, setCsrfTokenForTests } from "@/lib/client/http";
import { useApiStatus } from "@/lib/client/api-status";
import { FAKE_CSRF_TOKEN, fakeFetch, fakeWorker } from "../helpers/fake-worker";

/**
 * The single request wrapper (lib/client/http.ts): the CSRF handshake, the retry after an expired token, and
 * visible failures for writes and expired sign-ins.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CSRF", () => {
  it("fetches a token once, sends it with every write, and keeps it", async () => {
    setCsrfTokenForTests(null);
    vi.stubGlobal("fetch", fakeFetch);
    await apiSend("PUT", "/api/settings", { day_capacity_mins: 300 });
    await apiSend("PUT", "/api/settings", { day_capacity_mins: 360 });
    expect(fakeWorker.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /api/csrf",
      "PUT /api/settings",
      "PUT /api/settings",
    ]);
    expect(fakeWorker.requests.filter((request) => request.method === "PUT").every((request) => request.csrf === FAKE_CSRF_TOKEN)).toBe(true);
  });

  it("an expired token (403 csrf_failed) is refreshed and the write retried once; it is saved and nothing is shown", async () => {
    vi.stubGlobal("fetch", fakeFetch);
    fakeWorker.expireCsrfOnce = true;
    const entry = await apiSend<{ taskId: string }>("POST", "/api/entries", {
      taskId: "t1",
      flowDate: "2026-04-13",
      startTime: "2026-04-13T09:00:00Z",
    });
    expect(entry.taskId).toBe("t1");
    expect(fakeWorker.entries).toHaveLength(1);
    expect(fakeWorker.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /api/entries",
      "GET /api/csrf",
      "POST /api/entries",
    ]);
    expect(useApiStatus.getState().error).toBeNull();
  });

  it("a second csrf_failed is not retried again: the write fails visibly", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "csrf_failed", message: "The page security token expired." } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiSend("PUT", "/api/notes", {})).rejects.toMatchObject({ kind: "http", code: "csrf_failed" });
    // write, token refresh (also answered 403 here), no further retry
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useApiStatus.getState().error?.kind).toBe("http");
  });
});

describe("failures are visible", () => {
  it("an expired Access session (redirect) fails as session, is never retried, and shows Reload", async () => {
    const fetchMock = vi.fn(async () => {
      const response = new Response(null, { status: 302, headers: { location: "https://example.cloudflareaccess.com/login" } });
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await apiSendOk("PUT", "/api/flows", { action: "setFlow" })).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useApiStatus.getState().error).toEqual({ kind: "session", message: "Your sign-in has expired. Reload FlowDay to sign in again." });
  });

  it("a login page served as HTML (200) is a session failure, for reads too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } })));
    expect(await apiGetOrNull("/api/tasks")).toBeNull();
    expect(useApiStatus.getState().error?.kind).toBe("session");
  });

  it("the Worker's own 401 is a session failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "unauthorized", message: "x" } }), { status: 401, headers: { "content-type": "application/json" } }))
    );
    await expect(apiGet("/api/tasks")).rejects.toMatchObject({ kind: "session" });
  });

  it("a write's HTTP error shows the Worker's message; a quiet one does not; a network error shows", async () => {
    vi.stubGlobal("fetch", fakeFetch);
    await expect(apiSend("POST", "/api/nowhere", {})).rejects.toMatchObject({ kind: "http", status: 404 });
    expect(useApiStatus.getState().error).toEqual({ kind: "http", message: "Not found." });
    useApiStatus.getState().dismiss();
    await expect(apiSend("POST", "/api/nowhere", {}, { quiet: true })).rejects.toMatchObject({ status: 404 });
    expect(useApiStatus.getState().error).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    expect(await apiSendOk("PUT", "/api/notes", {})).toBe(false);
    expect(useApiStatus.getState().error?.kind).toBe("network");
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
    await apiGet("/api/tasks");
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks", expect.objectContaining({ method: "GET", redirect: "manual", cache: "no-store", credentials: "same-origin" }));
  });
});
