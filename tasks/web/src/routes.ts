export type ListView =
  | "inbox"
  | "today"
  | "upcoming"
  | "project"
  | "search"
  | "label"
  | "filter"
  | "completed";
export type Page =
  ListView | "plan" | "focus" | "mail" | "catalog" | "settings";
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
  "settings",
]);
export function readRoute(hash = window.location.hash): Route {
  const [page = "today", id = ""] = hash.replace(/^#\/?/, "").split("/");
  return {
    page: pages.has(page) ? (page as Page) : "today",
    id: decodeURIComponent(id),
  };
}
export function routeHref(route: Route): string {
  return `#/${route.page}${route.id ? `/${encodeURIComponent(route.id)}` : ""}`;
}
export function isPlanning(page: Page): page is "plan" | "focus" | "mail" {
  return page === "plan" || page === "focus" || page === "mail";
}
