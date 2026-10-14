import { browser } from "wxt/browser";
import type { ActionMessage, Result } from "./messages";
import type { PlusActions } from "./model";
async function call<T>(message: ActionMessage): Promise<T> {
  let response: Result<T>;
  try {
    response = (await browser.runtime.sendMessage(message)) as Result<T>;
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
  loadDays: (...args) => call({ kind: "action", method: "loadDays", args }),
  updateTask: (...args) => call({ kind: "action", method: "updateTask", args }),
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
export function openOptions() {
  void browser.runtime.sendMessage({ kind: "options" });
}
