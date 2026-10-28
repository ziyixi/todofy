/** The pages that show a ListTasks view; the others read their own APIs. */
const listViews = [
  "inbox",
  "today",
  "upcoming",
  "project",
  "search",
  "label",
  "filter",
  "completed",
] as const;
export type ListView = (typeof listViews)[number];
export type Page = ListView | "goals" | "plan" | "focus" | "mail" | "gtd" | "catalog";
export interface Route {
  page: Page;
  id: string;
}
export function isListView(page: Page): page is ListView {
  return (listViews as readonly string[]).includes(page);
}
const pages: ReadonlySet<string> = new Set([
  ...listViews,
  "goals",
  "plan",
  "focus",
  "mail",
  "gtd",
  "catalog",
]);
export function readRoute(hash = window.location.hash): Route {
  const [page = "today", id = ""] = hash.replace(/^#\/?/, "").split("/");
  return {
    page:
      page === "settings" ? "plan" : pages.has(page) ? (page as Page) : "today",
    id: decodeURIComponent(id),
  };
}
export function routeHref(route: Route): string {
  return `#/${route.page}${route.id ? `/${encodeURIComponent(route.id)}` : ""}`;
}
export function isPlanning(page: Page): page is "plan" | "focus" | "mail" {
  return page === "plan" || page === "focus" || page === "mail";
}
/** Puts a deep-link parameter into the URL, as if the page had loaded with it. */
export function setQueryParameter(name: string, value: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(name, value);
  window.history.replaceState(window.history.state, "", url);
}
/** A deep-link parameter acts once; removing it keeps a reload or a later visit from acting on it again. */
export function removeQueryParameter(name: string): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(name)) return;
  url.searchParams.delete(name);
  window.history.replaceState(window.history.state, "", url);
}
