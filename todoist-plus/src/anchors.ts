/**
 * How Plus reads Todoist's page: only structure and IDs, never task text. After a Todoist update,
 * this table is the one place to fix.
 *
 * Each anchor is an ordered list of selectors, tried one at a time: the first that finds anything
 * wins. (A CSS selector list would instead return the first match in document order.)
 */
export const ANCHORS = {
  sidebar: ["[data-testid=app-sidebar-scrollable-container]"],
  // Plan and Focus replace this container's children while open.
  content: ["#content", "main"],
  // The nav goes after Todoist's top menu, else after Upcoming, else first in the sidebar.
  topMenu: ["#top-menu"],
  // Inside the sidebar: where the nav goes, and the row whose size it copies.
  upcoming: ["a[href$='/upcoming']"],
  // Inside the sidebar: the native row that is highlighted, cleared while Plus is open.
  current: ["[aria-current=page]", "li.current"],
  // Inside the sidebar: the first favourite filter or label, whichever comes first.
  favorite: ["a[href*='/app/filter/'], a[href*='/app/label/']"],
  detail: ["[data-testid=task-details-modal]"],
  // Inside the task details modal.
  detailMain: ["[data-testid=task-main-content-container]"],
  detailRow: [
    "[data-testid=task-selection-list-container] [data-item-id]",
    "[data-item-id]",
  ],
  detailLabel: ["a[href*='/app/label/']"],
} as const satisfies Record<string, readonly string[]>;
export type AnchorKey = keyof typeof ANCHORS;

/** The anchor's element: the first selector, in table order, that finds one. */
export function find<T extends HTMLElement = HTMLElement>(
  key: AnchorKey,
  scope: ParentNode = document,
): T | undefined {
  for (const selector of ANCHORS[key]) {
    const element = scope.querySelector<T>(selector);
    if (element) return element;
  }
  return undefined;
}
/** All of the anchor's elements, from the first selector, in table order, that finds any. */
export function findAll<T extends HTMLElement = HTMLElement>(
  key: AnchorKey,
  scope: ParentNode = document,
): T[] {
  for (const selector of ANCHORS[key]) {
    const elements = scope.querySelectorAll<T>(selector);
    if (elements.length) return [...elements];
  }
  return [];
}

export function taskIdFromElement(element: Element): string | undefined {
  const item = element.closest("[data-item-id], [data-selection-id]");
  const id =
    item?.getAttribute("data-item-id") ??
    item?.getAttribute("data-selection-id") ??
    "";
  return id && !id.startsWith("tmp-") ? id : undefined;
}

/** True when a Todoist URL slug (`<id>` or `<name>-<id>`) names one of these IDs. */
export function matchesId(slug: string, ids: readonly string[]): boolean {
  return ids.some((id) => slug === id || slug.endsWith(`-${id}`));
}

/**
 * The task the details modal edits; without one, `off` says why when that is a Todoist change (a
 * task not yet saved has neither). The selection list's first row comes first, any other row (a
 * parent breadcrumb, say) only when there is no list. When the page URL is a task link
 * (`…/task/<id>`), it must name the same task, so a reordered modal hides the tools instead of
 * writing to another task.
 */
export function detailTask(
  modal: Element,
  url: string,
): { id?: string; off?: "detailRow" | "taskIdMismatch" } {
  const row = find("detailRow", modal);
  if (!row) return { off: "detailRow" };
  const id = taskIdFromElement(row);
  const linked = new URL(url).pathname.match(/\/task\/([^/]+)\/?$/u)?.[1];
  if (id && linked && !matchesId(linked, [id]))
    return { off: "taskIdMismatch" };
  return { id };
}

/** Todoist's own dialogs, alerts and toasts stay visible beside a Plus view. */
export function keepsVisible(element: Element): boolean {
  const role = element.getAttribute("role");
  return (
    element.tagName === "DIALOG" ||
    element.getAttribute("aria-modal") === "true" ||
    role === "dialog" ||
    role === "alertdialog" ||
    role === "alert" ||
    role === "status"
  );
}
