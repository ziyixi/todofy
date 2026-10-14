import { browser } from "wxt/browser";
import { createApi, publicError, validOrigin, type Connection } from "./api";
import {
  PLANNING_PROTOCOL,
  type BackgroundMessage,
  type Result,
} from "./messages";
import type { PlusActions } from "./model";
const storageKey = "connection";
let api: PlusActions | undefined;
async function getApi(): Promise<PlusActions> {
  if (api) return api;
  const saved = await browser.storage.local.get(storageKey);
  const connection = saved[storageKey] as Connection | undefined;
  if (!connection?.token)
    throw new Error("Connect Todoist Plus in extension settings.");
  api = createApi(connection);
  return api;
}
export function registerBackground() {
  // The content script can request narrow operations, but cannot read the credential.
  void browser.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  browser.runtime.onMessage.addListener(
    (message: BackgroundMessage, sender, sendResponse) => {
      if (sender.id !== browser.runtime.id) return false;
      const source = sender.url ? new URL(sender.url) : undefined;
      const options =
        source?.origin === new URL(browser.runtime.getURL("/")).origin;
      const todoist = source?.origin === "https://app.todoist.com";
      if (!options && !todoist) return false;
      async function handle(): Promise<unknown> {
        if (message.kind === "options") {
          await browser.runtime.openOptionsPage();
          return null;
        }
        if (message.kind === "connection" && options) {
          const saved = await browser.storage.local.get(storageKey);
          const connection = saved[storageKey] as Connection | undefined;
          return {
            connected: Boolean(connection?.token),
            apiOrigin: connection?.apiOrigin ?? "",
          };
        }
        if (message.kind === "connect" && options) {
          const connection = {
            apiOrigin: validOrigin(message.connection.apiOrigin),
            token: message.connection.token.trim(),
          };
          if (!connection.token || connection.token.length > 512)
            throw new Error("A connection token is required.");
          await browser.storage.local.set({ [storageKey]: connection });
          api = undefined;
          return null;
        }
        if (message.kind === "disconnect" && options) {
          await browser.storage.local.remove(storageKey);
          api = undefined;
          return null;
        }
        if (message.kind !== "action")
          throw new Error("Unsupported extension operation.");
        if (message.protocol !== PLANNING_PROTOCOL)
          throw new Error("Extension updated. Reload Todoist to continue.");
        const client = await getApi();
        switch (message.method) {
          case "load":
            return client.load(...message.args);
          case "loadDays":
            return client.loadDays(...message.args);
          case "updateTask":
            return client.updateTask(...message.args);
          case "updateLabels":
            return client.updateLabels(...message.args);
          case "createSteps":
            return client.createSteps(...message.args);
          case "updateLead":
            return client.updateLead(...message.args);
          case "completeTask":
            return client.completeTask(...message.args);
          case "updateQueue":
            return client.updateQueue(...message.args);
          case "moveTaskToDay":
            return client.moveTaskToDay(...message.args);
          case "updateEstimate":
            return client.updateEstimate(...message.args);
          case "timer":
            return client.timer(...message.args);
          default:
            throw new Error("Unsupported extension operation.");
        }
      }
      void handle()
        .then((value) => sendResponse({ ok: true, value } satisfies Result))
        .catch((error) =>
          sendResponse({
            ok: false,
            error:
              error instanceof Error &&
              /Connect Todoist Plus|connection token|HTTPS origin|Unsupported|Extension updated/.test(
                error.message,
              )
                ? error.message
                : publicError(error),
          } satisfies Result),
        );
      return true;
    },
  );
}
