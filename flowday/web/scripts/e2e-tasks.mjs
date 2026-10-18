// The Worker "tasks" the E2E server (./e2e-server.mjs) binds as FlowDay's TASKS: an empty Tasks, with no change
// since the start of its feed and only the Inbox in its catalog, so a sync succeeds and changes nothing (the suite
// seeds FlowDay's mirror through /api/test/seed). Local only; synthetic.
import { WorkerEntrypoint } from "cloudflare:workers";

export class TasksApi extends WorkerEntrypoint {
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname.endsWith("/catalog")) {
      return Response.json({ projects: [{ id: "inbox", name: "projects/inbox", title: "Inbox", inbox: true }] });
    }
    if (pathname.endsWith("/changes")) return Response.json({ changes: [], next_page_token: "0" });
    return Response.json({ error: { code: 404, message: "not found", status: "NOT_FOUND" } }, { status: 404 });
  }
}

const worker = {
  fetch() {
    return new Response(null, { status: 404 });
  },
};

export default worker;
