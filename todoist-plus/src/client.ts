import { browser } from "wxt/browser";
import { PLANNING_PROTOCOL, type ActionMessage, type Result } from "./messages";
import type { PlanConfig, PlusActions } from "./model";
async function call<T>(message: Omit<ActionMessage, "protocol">): Promise<T> {
  let response: Result<T>;
  try {
    response = (await browser.runtime.sendMessage({
      ...message,
      protocol: PLANNING_PROTOCOL,
    })) as Result<T>;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Extension context invalidated")
    )
      throw new Error("Extension updated. Reload Todoist to continue.", {
        cause: error,
      });
    throw error;
  }
  if (!response?.ok)
    throw new Error(
      response?.error || "Extension connection unavailable. Reload this page.",
    );
  return response.value;
}
export const extensionActions: PlusActions = {
  load: (...args) => call({ kind: "action", method: "load", args }),
  readPlan: (...args) => call({ kind: "action", method: "readPlan", args }),
  loadDays: (...args) => call({ kind: "action", method: "loadDays", args }),
  updateTask: (...args) => call({ kind: "action", method: "updateTask", args }),
  updateLabels: (...args) =>
    call({ kind: "action", method: "updateLabels", args }),
  createSteps: (...args) =>
    call({ kind: "action", method: "createSteps", args }),
  updateLead: (...args) => call({ kind: "action", method: "updateLead", args }),
  completeTask: (...args) =>
    call({ kind: "action", method: "completeTask", args }),
  updateQueue: (...args) =>
    call({ kind: "action", method: "updateQueue", args }),
  moveTaskToDay: (...args) =>
    call({ kind: "action", method: "moveTaskToDay", args }),
  updateEstimate: (...args) =>
    call({ kind: "action", method: "updateEstimate", args }),
  timer: (...args) => call({ kind: "action", method: "timer", args }),
};
/** The last confirmed ID-only configuration, read from disk without a network request. */
export async function cachedPlanConfig(): Promise<PlanConfig | undefined> {
  const response = (await browser.runtime.sendMessage({
    kind: "planConfig",
  })) as Result<PlanConfig | null> | undefined;
  const config = response?.ok ? response.value : undefined;
  return config &&
    typeof config.configured === "boolean" &&
    Array.isArray(config.hiddenFilterIds) &&
    Array.isArray(config.labelIds)
    ? config
    : undefined;
}
export function openOptions() {
  void browser.runtime.sendMessage({ kind: "options" });
}
