import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../../integrations/notion-publish/worker.js";

const env = {
  NOTION_WEBHOOK_SECRET: "not-a-real-secret-000000000000000000000000",
  GITHUB_DISPATCH_TOKEN: "not-a-real-github-token",
};
const api =
  "https://api.github.com/repos/ziyixi/ziyixi.science/actions/workflows/production-release.yml";

function request(options: RequestInit = {}, path = "/publish") {
  return new Request(`https://publish.example${path}`, {
    method: "POST",
    headers: { "X-Notion-Publish-Secret": env.NOTION_WEBHOOK_SECRET },
    ...options,
  });
}

function mockGitHub(runs: unknown[] = [], dispatch = Response.json({ workflow_run_id: 123 })) {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ workflow_runs: runs }))
    .mockResolvedValueOnce(dispatch);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("Notion publish Worker", () => {
  it("refreshes status through its fixed workflow without accepting publish overrides", async () => {
    const upstream = mockGitHub();
    const response = await worker.fetch(
      request(
        {
          body: JSON.stringify({
            workflow: "production-release.yml",
            inputs: { operation: "recovery" },
          }),
        },
        "/refresh-status?workflow=production-release.yml",
      ),
      env,
    );
    expect(response.status).toBe(202);
    expect((await response.json()).workflowUrl).toContain("/notion-status.yml");
    expect(upstream.mock.calls[0]?.[0]).toContain("/notion-status.yml/runs?");
    expect(upstream.mock.calls[1]?.[0]).toContain("/notion-status.yml/dispatches");
    expect(JSON.parse(String(upstream.mock.calls[1]?.[1]?.body))).toEqual({
      ref: "main",
      inputs: {},
    });
  });

  it("authenticates and deduplicates refresh requests independently", async () => {
    const upstream = mockGitHub([{ id: 321, head_branch: "main", status: "in_progress" }]);
    expect((await worker.fetch(request({ headers: {} }, "/refresh-status"), env)).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
    const response = await worker.fetch(request({}, "/refresh-status"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "already-running",
      workflowUrl: "https://github.com/ziyixi/ziyixi.science/actions/workflows/notion-status.yml",
    });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("exposes only a liveness response without checking secrets or contacting GitHub", async () => {
    const upstream = mockGitHub();
    const response = await worker.fetch(request({ method: "GET" }, "/health"), {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([undefined, "incorrect-secret", `${env.NOTION_WEBHOOK_SECRET}x`, "x".repeat(1025)])(
    "never contacts GitHub for an absent or incorrect secret (%s)",
    async (secret) => {
      const upstream = mockGitHub();
      const headers: Record<string, string> = secret ? { "X-Notion-Publish-Secret": secret } : {};
      const response = await worker.fetch(request({ headers }), env);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ status: "error", code: "unauthorized" });
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it.each(["GET", "PUT", "DELETE", "OPTIONS"])(
    "rejects %s on /publish without contacting GitHub",
    async (method) => {
      const upstream = mockGitHub();
      const response = await worker.fetch(request({ method }), env);
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("POST");
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown routes and does not accept a secret in the URL", async () => {
    const upstream = mockGitHub();
    expect((await worker.fetch(request({}, "/other"), env)).status).toBe(404);
    expect(
      (
        await worker.fetch(
          request({ headers: {} }, `/publish?secret=${env.NOTION_WEBHOOK_SECRET}`),
          env,
        )
      ).status,
    ).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([{}, { ...env, NOTION_WEBHOOK_SECRET: "short" }, { ...env, GITHUB_DISPATCH_TOKEN: "" }])(
    "fails closed with missing or weak configuration",
    async (bindings) => {
      const upstream = mockGitHub();
      expect((await worker.fetch(request(), bindings)).status).toBe(503);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("dispatches only the fixed ordinary main release, ignoring body and query overrides", async () => {
    const upstream = mockGitHub();
    const response = await worker.fetch(
      request(
        {
          body: JSON.stringify({
            repository: "attacker/project",
            ref: "evil-branch",
            inputs: { operation: "recovery", force_build: true, allow_empty: true },
            privateNotionData: "must-not-leave-the-worker",
          }),
        },
        "/publish?ref=evil&operation=bootstrap&target=https://attacker.example",
      ),
      env,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "accepted",
      workflowUrl:
        "https://github.com/ziyixi/ziyixi.science/actions/workflows/production-release.yml",
      runId: 123,
      runUrl: "https://github.com/ziyixi/ziyixi.science/actions/runs/123",
    });
    expect(upstream).toHaveBeenCalledTimes(2);
    const [url, options] = upstream.mock.calls[1]!;
    expect(url).toBe(`${api}/dispatches`);
    expect(options?.method).toBe("POST");
    expect(options?.redirect).toBe("manual");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(options?.body))).toEqual({
      ref: "main",
      inputs: {
        operation: "release",
        confirmation: "release:www.ziyixi.science",
        force_build: false,
        allow_empty: false,
      },
    });
    expect(options?.headers).toMatchObject({
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      "X-GitHub-Api-Version": "2026-03-10",
    });
    expect(JSON.stringify(upstream.mock.calls)).not.toContain(env.NOTION_WEBHOOK_SECRET);
    expect(JSON.stringify(upstream.mock.calls)).not.toContain("must-not-leave-the-worker");
  });

  it.each(["queued", "in_progress", "requested", "waiting", "pending"])(
    "does not dispatch again when a main release is %s",
    async (status) => {
      const upstream = mockGitHub([{ id: 321, head_branch: "main", status }]);
      const response = await worker.fetch(request(), env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "already-running", runId: 321 });
      expect(upstream).toHaveBeenCalledTimes(1);
    },
  );

  it("ignores completed runs and unrelated branches", async () => {
    const upstream = mockGitHub([
      { id: 1, head_branch: "main", status: "completed" },
      { id: 2, head_branch: "other", status: "in_progress" },
    ]);
    expect((await worker.fetch(request(), env)).status).toBe(202);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("accepts the older 204 dispatch response without claiming deployment completed", async () => {
    mockGitHub([], new Response(null, { status: 204 }));
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "accepted",
      workflowUrl:
        "https://github.com/ziyixi/ziyixi.science/actions/workflows/production-release.yml",
    });
  });

  it("keeps acceptance if optional run details are malformed and never reflects upstream URLs", async () => {
    mockGitHub(
      [],
      Response.json({ html_url: "https://attacker.example", workflow_run_id: "oops" }),
    );
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(202);
    expect(await response.text()).not.toContain("attacker");
  });

  it("fails closed when run listing is unavailable without reflecting error bodies", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(`untrusted error ${env.GITHUB_DISPATCH_TOKEN}`, { status: 403 }),
      );
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(env.GITHUB_DISPATCH_TOKEN);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the run listing has an unexpected shape", async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ unexpected: [] }));
    vi.stubGlobal("fetch", upstream);
    expect((await worker.fetch(request(), env)).status).toBe(502);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("rejects upstream redirects without forwarding the token to another host", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: "https://attacker.example" } }),
      );
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(502);
    expect((await response.json()).githubStatus).toBe(302);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("reports a rejected dispatch without echoing GitHub errors or retrying", async () => {
    const upstream = mockGitHub([], new Response(env.GITHUB_DISPATCH_TOKEN, { status: 401 }));
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(502);
    const result = await response.json();
    expect(result.code).toBe("github_dispatch_failed");
    expect(JSON.stringify(result)).not.toContain(env.GITHUB_DISPATCH_TOKEN);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("reports uncertain dispatch after a network timeout and does not retry", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ workflow_runs: [] }))
      .mockRejectedValueOnce(new DOMException("request aborted", "TimeoutError"));
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe("github_dispatch_unconfirmed");
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
