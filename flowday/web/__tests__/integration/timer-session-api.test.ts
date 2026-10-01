import { describe, expect, it } from "vitest";

async function callTimerSession(
  method: "GET" | "PUT" | "DELETE",
  body?: unknown
) {
  const mod = await import("@/app/api/timer/session/route");
  const url = "http://localhost:3000/api/timer/session";
  const request = new Request(url, {
    method,
    ...(body
      ? {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }
      : {}),
  });

  if (method === "GET") return mod.GET();
  if (method === "PUT") return mod.PUT(request);
  return mod.DELETE();
}

describe("/api/timer/session", () => {
  it("returns null when no active session exists", async () => {
    const response = await callTimerSession("GET");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ session: null });
  });

  it("stores a full payload and returns it on GET", async () => {
    const payload = {
      taskId: "task-1",
      flowDate: "2026-04-21",
      status: "running",
      timerMode: "pomodoro",
      pomodoroTargetS: 1800,
      segmentWallStart: "2026-04-21T09:00:00.000Z",
      sessionSavedS: 120,
      pomodoroFinishedTaskId: null,
      pomodoroFinishedFlowDate: null,
      pomodoroFinishedTargetS: null,
    };

    const putResponse = await callTimerSession("PUT", payload);
    expect(putResponse.status).toBe(200);
    await expect(putResponse.json()).resolves.toEqual({ success: true });

    const getResponse = await callTimerSession("GET");
    const data = await getResponse.json();
    expect(data.session).toMatchObject(payload);
    expect(typeof data.session.updatedAt).toBe("string");
  });

  it("normalizes invalid status and timerMode values", async () => {
    await callTimerSession("PUT", {
      taskId: "task-2",
      flowDate: "2026-04-21",
      status: "broken",
      timerMode: "weird",
      pomodoroTargetS: null,
      segmentWallStart: null,
      sessionSavedS: 25,
      pomodoroFinishedTaskId: null,
      pomodoroFinishedFlowDate: null,
      pomodoroFinishedTargetS: null,
    });

    const response = await callTimerSession("GET");
    const data = await response.json();
    expect(data.session).toMatchObject({
      taskId: "task-2",
      flowDate: "2026-04-21",
      status: "idle",
      timerMode: "countup",
      sessionSavedS: 25,
    });
  });

  it("clears the session on DELETE", async () => {
    await callTimerSession("PUT", {
      taskId: "task-3",
      flowDate: "2026-04-21",
      status: "paused",
      timerMode: "pomodoro",
      pomodoroTargetS: 1500,
      segmentWallStart: null,
      sessionSavedS: 300,
      pomodoroFinishedTaskId: null,
      pomodoroFinishedFlowDate: null,
      pomodoroFinishedTargetS: null,
    });

    const deleteResponse = await callTimerSession("DELETE");
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({ success: true });

    const getResponse = await callTimerSession("GET");
    await expect(getResponse.json()).resolves.toEqual({ session: null });
  });
});
