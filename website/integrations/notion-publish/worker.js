const WORKFLOW_API =
  "https://api.github.com/repos/ziyixi/ziyixi.science/actions/workflows/production-release.yml";
const WORKFLOW_URL =
  "https://github.com/ziyixi/ziyixi.science/actions/workflows/production-release.yml";
const RUN_URL = "https://github.com/ziyixi/ziyixi.science/actions/runs/";
const SECRET_HEADER = "X-Notion-Publish-Secret";
const encoder = new TextEncoder();
const authenticationMessage = encoder.encode("ziyixi.science/notion-publish/v1");
const activeStatuses = new Set(["queued", "in_progress", "requested", "waiting", "pending"]);

function json(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function error(code, status, includeWorkflow = false, githubStatus) {
  return json(
    {
      status: "error",
      code,
      ...(includeWorkflow ? { workflowUrl: WORKFLOW_URL } : {}),
      ...(githubStatus ? { githubStatus } : {}),
    },
    status,
  );
}

// Web Crypto performs the MAC verification without a JavaScript secret-string
// comparison. Neither the incoming secret nor a derived MAC is sent upstream.
async function authenticated(candidate, expected) {
  if (!candidate || candidate.length > 1024) return false;
  const algorithm = { name: "HMAC", hash: "SHA-256" };
  const suppliedKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(candidate),
    algorithm,
    false,
    ["sign"],
  );
  const expectedKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(expected),
    algorithm,
    false,
    ["verify"],
  );
  const signature = await crypto.subtle.sign("HMAC", suppliedKey, authenticationMessage);
  return crypto.subtle.verify("HMAC", expectedKey, signature, authenticationMessage);
}

function runDetails(id) {
  return Number.isSafeInteger(id) && id > 0 ? { runId: id, runUrl: `${RUN_URL}${id}` } : {};
}

const worker = {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health" && request.method === "GET") {
      // Liveness only: do not expose credentials or make an authenticated API call.
      return json({ status: "ok" });
    }
    if (pathname !== "/publish") return error("not_found", 404);
    if (request.method !== "POST") {
      return json({ status: "error", code: "method_not_allowed" }, 405, { Allow: "POST" });
    }
    if (
      typeof env.NOTION_WEBHOOK_SECRET !== "string" ||
      env.NOTION_WEBHOOK_SECRET.length < 32 ||
      env.NOTION_WEBHOOK_SECRET.length > 1024 ||
      typeof env.GITHUB_DISPATCH_TOKEN !== "string" ||
      !env.GITHUB_DISPATCH_TOKEN
    ) {
      return error("not_configured", 503);
    }
    if (!(await authenticated(request.headers.get(SECRET_HEADER), env.NOTION_WEBHOOK_SECRET))) {
      return error("unauthorized", 401);
    }

    // Ignore all incoming content and query parameters. This button can only
    // request the ordinary release below; it cannot select code, recovery, or
    // allow-empty. Never forward or log Notion's payload or either secret.
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "ziyixi-notion-publish",
    };
    const signal = AbortSignal.timeout(8000);
    let dispatchStarted = false;
    try {
      // This reduces ordinary double-clicks but is not an atomic lock. The
      // existing GitHub workflow's concurrency group serializes actual releases.
      const existing = await fetch(
        `${WORKFLOW_API}/runs?branch=main&event=workflow_dispatch&per_page=30`,
        // workerd supports manual/follow, not Node's redirect: "error".
        // Manual plus the status check prevents forwarding the token on 3xx.
        { headers, signal, redirect: "manual" },
      );
      if (!existing.ok) return error("github_unavailable", 502, true, existing.status);
      const listing = await existing.json();
      if (!listing || !Array.isArray(listing.workflow_runs)) {
        return error("github_unavailable", 502, true);
      }
      const active = listing.workflow_runs.find(
        (run) => run && run.head_branch === "main" && activeStatuses.has(run.status),
      );
      if (active) {
        return json({
          status: "already-running",
          workflowUrl: WORKFLOW_URL,
          ...runDetails(active.id),
        });
      }

      dispatchStarted = true;
      const dispatched = await fetch(`${WORKFLOW_API}/dispatches`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        signal,
        redirect: "manual",
        body: JSON.stringify({
          ref: "main",
          inputs: {
            operation: "release",
            confirmation: "release:www.ziyixi.science",
            force_build: false,
            allow_empty: false,
          },
        }),
      });
      if (dispatched.status !== 200 && dispatched.status !== 204) {
        return error("github_dispatch_failed", 502, true, dispatched.status);
      }
      // A successful dispatch is only acceptance, not deployment completion.
      // Older GitHub API versions return 204; do not turn an accepted request
      // into a failure merely because optional run details cannot be decoded.
      let details = {};
      if (dispatched.status === 200) {
        try {
          details = runDetails((await dispatched.json())?.workflow_run_id);
        } catch {
          // The workflow page is still a safe fallback for checking the run.
        }
      }
      return json({ status: "accepted", workflowUrl: WORKFLOW_URL, ...details }, 202);
    } catch {
      // After a timeout, dispatch may have reached GitHub. Do not retry it here.
      return error(
        dispatchStarted ? "github_dispatch_unconfirmed" : "github_unavailable",
        502,
        true,
      );
    }
  },
};

export default worker;
