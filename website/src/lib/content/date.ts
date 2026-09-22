import { ContentError } from "./errors";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const OFFSET_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseContentDate(value: string): string {
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (
      Number.isNaN(parsed.valueOf()) ||
      parsed.getUTCFullYear() !== Number(year) ||
      parsed.getUTCMonth() + 1 !== Number(month) ||
      parsed.getUTCDate() !== Number(day)
    ) {
      throw new ContentError("INVALID_DATE", `Invalid calendar date: ${value}`, { value });
    }
    return parsed.toISOString();
  }

  if (!OFFSET_DATE_TIME.test(value)) {
    throw new ContentError(
      "INVALID_DATE",
      "Date-time values must include an explicit UTC offset.",
      { value },
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new ContentError("INVALID_DATE", `Invalid date-time: ${value}`, { value });
  }
  return parsed.toISOString();
}

export function assertNotFuture(isoDate: string, cutoff: Date): void {
  const value = new Date(isoDate);
  if (Number.isNaN(value.valueOf())) {
    throw new ContentError("INVALID_DATE", `Invalid normalized date: ${isoDate}`);
  }
  if (value.valueOf() > cutoff.valueOf()) {
    throw new ContentError("FUTURE_POST", `Published date is after the sync cutoff: ${isoDate}`, {
      cutoff: cutoff.toISOString(),
      publishedAt: isoDate,
    });
  }
}

export function comparePostsNewestFirst<T extends { publishedAt: string; slug: string }>(
  left: T,
  right: T,
): number {
  const byDate = right.publishedAt.localeCompare(left.publishedAt);
  return byDate || left.slug.localeCompare(right.slug);
}
