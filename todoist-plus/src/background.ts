import { browser } from "wxt/browser";
import {
  createApi,
  publicError,
  validOrigin,
  type Connection,
  type KnownTaskStore,
} from "./api";
import {
  PLANNING_PROTOCOL,
  type BackgroundMessage,
  type Result,
} from "./messages";
import { planConfig } from "./domain";
import { pageStatus } from "./page-status";
import type { PlanConfig, PlanMetadata, PlusActions } from "./model";
const storageKey = "connection";
const knownKey = "knownFlowTasks";
const configKey = "planConfig";
const statusKey = "pageStatus";
const otherViewsKey = "otherViewsOpen";
let api: PlusActions | undefined;
// Session storage outlives an idle-stopped worker, not the browser session.
const knownTasks: KnownTaskStore = {
  async read() {
    const saved = await browser.storage.session.get(knownKey);
    return (saved[knownKey] as string[] | undefined) ?? [];
  },
  async write(ids) {
    await browser.storage.session.set({ [knownKey]: ids });
  },
};
async function getApi(): Promise<PlusActions> {
  if (api) return api;
  const saved = await browser.storage.local.get(storageKey);
  const connection = saved[storageKey] as Connection | undefined;
  if (!connection?.token)
    throw new Error("Connect Todoist Plus in extension settings.");
  const client = createApi(connection, fetch, {
    read: knownTasks.read,
    // A call that outlives a disconnect or a new connection keeps its IDs to itself.
    write: async (ids) => {
      if (client === api) await knownTasks.write(ids);
    },
  });
  api = client;
  return client;
}
function rememberPlan(client: PlusActions, plan: PlanMetadata) {
  if (client !== api) return;
  void browser.storage.local
    .set({ [configKey]: planConfig(plan) satisfies PlanConfig })
    .catch(() => {});
}
async function forgetConnection() {
  // Cleared first, so a call still running cannot store its results after the removal.
  api = undefined;
  await browser.storage.local.remove([storageKey, configKey, otherViewsKey]);
  await browser.storage.session.remove(knownKey);
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
        if (message.kind === "planConfig") {
          const saved = await browser.storage.local.get(configKey);
          return (saved[configKey] as PlanConfig | undefined) ?? null;
        }
        // One boolean: whether the owner left Other views open.
        if (message.kind === "otherViews" && todoist) {
          if (message.open === undefined) {
            const saved = await browser.storage.local.get(otherViewsKey);
            return saved[otherViewsKey] === true;
          }
          if (typeof message.open !== "boolean")
            throw new Error("Unsupported extension operation.");
          await browser.storage.local.set({ [otherViewsKey]: message.open });
          return null;
        }
        // Only keys from closed sets are kept; anything else is refused, not stored.
        if (message.kind === "reportPage" && todoist) {
          const status = pageStatus(message.status);
          if (!status) throw new Error("Unsupported extension operation.");
          await browser.storage.local.set({ [statusKey]: status });
          return null;
        }
        if (message.kind === "pageStatus" && options) {
          const saved = await browser.storage.local.get(statusKey);
          return pageStatus(saved[statusKey]) ?? null;
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
          await forgetConnection();
          await browser.storage.local.set({ [storageKey]: connection });
          return null;
        }
        if (message.kind === "disconnect" && options) {
          await forgetConnection();
          return null;
        }
        if (message.kind !== "action")
          throw new Error("Unsupported extension operation.");
        if (message.protocol !== PLANNING_PROTOCOL)
          throw new Error("Extension updated. Reload Todoist to continue.");
        const client = await getApi();
        switch (message.method) {
          case "load": {
            const data = await client.load(...message.args);
            rememberPlan(client, data.plan);
            return data;
          }
          case "readPlan": {
            const plan = await client.readPlan(...message.args);
            rememberPlan(client, plan);
            return plan;
          }
          case "loadDays":
            return client.loadDays(...message.args);
          case "updateTask":
            return client.updateTask(...message.args);
          case "updateLabels": {
            const plan = await client.updateLabels(...message.args);
            rememberPlan(client, plan);
            return plan;
          }
          case "createSteps":
            return client.createSteps(...message.args);
          case "updateLead":
            return client.updateLead(...message.args);
          case "completeTask":
            return client.completeTask(...message.args);
          case "setDependency":
            return client.setDependency(...message.args);
          case "resolveDependencies":
            return client.resolveDependencies(...message.args);
          case "addToDay":
            return client.addToDay(...message.args);
          case "removeFromDay":
            return client.removeFromDay(...message.args);
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
        .catch((error) => {
          const text =
            error instanceof Error &&
            /Connect Todoist Plus|connection token|HTTPS origin|Unsupported|Extension updated/.test(
              error.message,
            )
              ? error.message
              : publicError(error);
          // Without a working connection, the next page load keeps native Todoist intact.
          if (/Connect Todoist Plus|Connection expired/.test(text))
            void browser.storage.local.remove(configKey).catch(() => {});
          sendResponse({ ok: false, error: text } satisfies Result);
        });
      return true;
    },
  );
}
