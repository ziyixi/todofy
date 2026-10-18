import type { MailCategory } from "./model";

/** The owner's mail categories: at most this many. */
export const MAX_CATEGORIES = 4;

/** The day (YYYY-MM-DD) of an instant in the account's time zone. */
export function localDate(iso: string, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** A category's generated name, "Work · P2" or "quick · P4"; undefined once its label is gone. */
export function categoryName(
  category: Pick<MailCategory, "labelId" | "priority">,
  labels: readonly { id: string; name: string }[],
): string | undefined {
  const label = labels.find((choice) => choice.id === category.labelId);
  return label && `${label.name} · P${category.priority}`;
}
