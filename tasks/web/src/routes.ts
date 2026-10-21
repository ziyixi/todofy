export type ListView =
  | "inbox"
  | "today"
  | "upcoming"
  | "project"
  | "search"
  | "label"
  | "filter"
  | "completed";
export type Page = ListView | "plan" | "focus" | "mail" | "catalog";
export interface Route {
  page: Page;
  id: string;
}
const pages: ReadonlySet<string> = new Set([
  "inbox",
  "today",
  "upcoming",
  "project",
  "search",
  "label",
  "filter",
  "completed",
  "plan",
  "focus",
  "mail",
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
