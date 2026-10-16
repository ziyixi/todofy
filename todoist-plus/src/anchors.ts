/** How Plus reads Todoist's page: only structure and IDs, never task text. */

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
 * The task the details modal edits, or undefined when it cannot be confirmed. The selection list's
 * first row comes first; any other row (a parent breadcrumb, say) only when there is no list. When
 * the page URL is a task link (`…/task/<id>`), it must name the same task, so a reordered modal
 * hides the tools instead of writing to another task.
 */
export function detailTaskId(modal: Element, url: string): string | undefined {
  const row =
    modal.querySelector(
      "[data-testid=task-selection-list-container] [data-item-id]",
    ) ?? modal.querySelector("[data-item-id]");
  const id = row ? taskIdFromElement(row) : undefined;
  const linked = new URL(url).pathname.match(/\/task\/([^/]+)\/?$/u)?.[1];
  if (id && linked && !matchesId(linked, [id])) return undefined;
  return id;
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
