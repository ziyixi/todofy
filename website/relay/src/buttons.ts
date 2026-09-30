import type { RelayEnv } from "./env";
import {
  ACTIVE_STATUSES,
  dispatch,
  listRuns,
  releaseInputs,
  runUrl,
  statusInputs,
  workflowUrl,
  type DispatchInputs,
} from "./github";

const SECRET_HEADER = "X-Notion-Publish-Secret";
const encoder = new TextEncoder();
const authenticationMessage = encoder.encode("ziyixi.science/notion-publish/v1");

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
  });
}

function error(code: string, status: number, url?: string, githubStatus?: number): Response {
  return json(
    {
      status: "error",
      code,
      ...(url ? { workflowUrl: url } : {}),
      ...(githubStatus ? { githubStatus } : {}),
    },
    status,
  );
}

// Web Crypto performs the MAC verification without a JavaScript secret-string comparison. Neither
// the incoming secret nor a derived MAC is sent upstream.
async function authenticated(candidate: string | null, expected: string): Promise<boolean> {
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

function runDetails(env: RelayEnv, id: unknown) {
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0
    ? { runId: id, runUrl: runUrl(env, id) }
    : {};
}

const targets = new Map<string, (env: RelayEnv) => DispatchInputs>([
  ["/publish", (env) => releaseInputs(env, "button")],
  ["/refresh-status", (env) => statusInputs(env)],
]);

/**
 * The two Notion buttons ("发布网站" -> /publish, "刷新状态" -> /refresh-status). Both dispatch the
 * one workflow website-release.yml on main with fixed inputs; a request can select nothing else.
 */
export async function handleButton(request: Request, env: RelayEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/health" && request.method === "GET") {
    // Liveness only: no credential or configuration disclosure and no authenticated API call.
    return json({ status: "ok" });
  }
  const target = targets.get(pathname);
  if (!target) return error("not_found", 404);
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

  // Ignore all incoming content and query parameters. Never forward or log Notion's payload or a
  // secret.
  const url = workflowUrl(env);
  const signal = AbortSignal.timeout(8000);
  let dispatchStarted = false;
  try {
    // This reduces ordinary double clicks but is not an atomic lock; the workflow's concurrency
    // group serializes the actual releases.
    const existing = await listRuns(env, signal);
    if (!existing.ok) return error("github_unavailable", 502, url, existing.status);
    const listing = (await existing.json()) as { workflow_runs?: unknown };
    if (!listing || !Array.isArray(listing.workflow_runs)) {
      return error("github_unavailable", 502, url);
    }
    const active = (
      listing.workflow_runs as { id?: unknown; head_branch?: unknown; status?: unknown }[]
    ).find((run) => run && run.head_branch === "main" && ACTIVE_STATUSES.has(String(run.status)));
    if (active) {
      return json({ status: "already-running", workflowUrl: url, ...runDetails(env, active.id) });
    }

    dispatchStarted = true;
    const dispatched = await dispatch(env, target(env), signal);
    if (dispatched.status !== 200 && dispatched.status !== 204) {
      return error("github_dispatch_failed", 502, url, dispatched.status);
    }
    // Acceptance only, not deployment completion. Older API versions answer 204.
    let details = {};
    if (dispatched.status === 200) {
      try {
        details = runDetails(
          env,
          ((await dispatched.json()) as { workflow_run_id?: unknown })?.workflow_run_id,
        );
      } catch {
        // The workflow page is still a safe fallback.
      }
    }
    return json({ status: "accepted", workflowUrl: url, ...details }, 202);
  } catch {
    // After a timeout the dispatch may have reached GitHub; never retry it here.
    return error(dispatchStarted ? "github_dispatch_unconfirmed" : "github_unavailable", 502, url);
  }
}
