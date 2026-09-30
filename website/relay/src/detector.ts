import { boundedInteger, type RelayEnv } from "./env";
import {
  ACTIVE_STATUSES,
  dispatch,
  listRuns,
  parseRuns,
  releaseInputs,
  type RunSummary,
} from "./github";

/**
 * The scheduled change detector (docs/architecture.md, "Automatic releases"). A tick normally costs
 * three subrequests (one GitHub run listing, one Notion query, one dispatch) and at most five (two
 * Notion result pages plus one due/pending query when more rows match). All state lives in GitHub
 * (the release runs) and Notion (the rows and their feedback properties); the Worker stores nothing.
 */

/** Notion property names and website statuses, as content/site.config.ts and scripts/notion/status.ts. */
export const NOTION = {
  authorStatus: "Status",
  publishedAt: "PublishedAt",
  siteStatus: "网站状态",
  checkedAt: "检查时间",
} as const;
export const SCHEDULED = "待定时发布";
export const PENDING = ["有修改待发布", "待下线"] as const;
export const NOT_ONLINE = "未上线";

const MINUTE = 60_000;
/** Notion reports last_edited_time to the minute; widen every "since" by one minute. */
const EDIT_PRECISION = MINUTE;
/**
 * The status write-back writes each row's 检查时间 as the instant of that row's own write
 * (scripts/notion/status.ts), so its edit lands within seconds of it.
 */
const WRITE_BACK_WINDOW = 3 * MINUTE;
/** Notion's largest page size; the query's result pages read per tick before the fallback query. */
export const QUERY_PAGE_SIZE = 100;
export const MAX_QUERY_PAGES = 2;
/** After this many failed release runs in a UTC day the detector stops dispatching until tomorrow. */
export const MAX_FAILED_RELEASES_PER_DAY = 3;

export interface NotionRow {
  /** The page ID ("" if absent): merges the fallback query's rows. */
  id: string;
  lastEditedTime: number;
  lastEditedBy: string | null;
  authorStatus: string | null;
  siteStatus: string | null;
  checkedAt: number | null;
  publishedAt: number | null;
}

export interface DetectorSettings {
  quietMinutes: number;
  maxAutoReleasesPerDay: number;
  reconcileUtcHour: number;
  ignoredEditors: Set<string>;
}

export type Decision =
  | { action: "skip"; code: string; counts?: Counts }
  | {
      action: "dispatch";
      trigger: "cron" | "pending" | "reconcile";
      code: string;
      counts: Counts;
    };

export interface Counts {
  rows: number;
  edited: number;
  due: number;
  pending: number;
  /** Pending states the newest release's own write-back found (see decide). */
  followUp: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  // A date-only value ("2026-10-01") is UTC midnight, exactly as the build's date parser reads it.
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function prop(page: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const properties = page.properties;
  if (!isRecord(properties)) return undefined;
  const value = properties[name];
  return isRecord(value) ? value : undefined;
}

function optionName(value: unknown): string | null {
  return isRecord(value) && typeof value.name === "string" ? value.name : null;
}

function dateStart(value: unknown): number | null {
  return isRecord(value) ? parseTime(value.start) : null;
}

/** Only the fields the rules read; titles, bodies and other properties are never touched. */
export function parseRows(body: unknown): NotionRow[] | null {
  return parsePage(body)?.rows ?? null;
}

/** One page of query results and where the next one starts. */
export function parsePage(body: unknown): { rows: NotionRow[]; nextCursor: string | null } | null {
  if (!isRecord(body) || !Array.isArray(body.results)) return null;
  const rows: NotionRow[] = [];
  for (const page of body.results) {
    if (!isRecord(page) || page.archived === true || page.in_trash === true) continue;
    const lastEditedTime = parseTime(page.last_edited_time);
    if (lastEditedTime === null) continue;
    rows.push({
      id: typeof page.id === "string" ? page.id : "",
      lastEditedTime,
      lastEditedBy:
        isRecord(page.last_edited_by) && typeof page.last_edited_by.id === "string"
          ? page.last_edited_by.id
          : null,
      authorStatus: optionName(prop(page, NOTION.authorStatus)?.status),
      siteStatus: optionName(prop(page, NOTION.siteStatus)?.select),
      checkedAt: dateStart(prop(page, NOTION.checkedAt)?.date),
      publishedAt: dateStart(prop(page, NOTION.publishedAt)?.date),
    });
  }
  const nextCursor =
    body.has_more === true && typeof body.next_cursor === "string" ? body.next_cursor : null;
  return { rows, nextCursor };
}

function utcMidnight(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export interface ReleaseWindow {
  /** When the newest release run started: edits since then are not in the live site yet. */
  since: number;
  /** When it finished (a check after that is newer than the release's own write-back). */
  finishedAt: number;
  /** Its trigger; null without any release run in the listing. */
  trigger: string | null;
}

/**
 * The newest release run (any trigger, any conclusion) bounds what counts as new. A failed run
 * does not write feedback, so edits made before it wait for the daily reconcile release.
 * Without any run in the listing, the last 24 hours count.
 */
export function releaseWindow(runs: RunSummary[], now: number): ReleaseWindow {
  const last = [...runs]
    .sort((left, right) => right.createdAt - left.createdAt)
    .find((run) => run.operation !== null && run.operation !== "status");
  if (!last) {
    const dayAgo = now - 24 * 60 * MINUTE;
    return { since: dayAgo, finishedAt: dayAgo, trigger: null };
  }
  return { since: last.startedAt, finishedAt: last.updatedAt, trigger: last.trigger };
}

/**
 * The Notion filter: anything edited since the last release, due scheduled posts, pending states;
 * newest edit first. `dueOrPendingOnly` drops the edited-since branch: the fallback query when more
 * rows matched than the pages read (every release's write-back edits every row, so right after a
 * release all rows match; the newest edits come first, but a due or pending row can be anywhere).
 */
export function notionQuery(
  window: ReleaseWindow,
  now: number,
  options: { startCursor?: string; dueOrPendingOnly?: boolean } = {},
): Record<string, unknown> {
  return {
    page_size: QUERY_PAGE_SIZE,
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    ...(options.startCursor ? { start_cursor: options.startCursor } : {}),
    filter: {
      or: [
        ...(options.dueOrPendingOnly
          ? []
          : [
              {
                timestamp: "last_edited_time",
                last_edited_time: {
                  on_or_after: new Date(window.since - EDIT_PRECISION).toISOString(),
                },
              },
            ]),
        {
          and: [
            { property: NOTION.siteStatus, select: { equals: SCHEDULED } },
            // The current instant, not "today": a date-only PublishedAt is due at UTC midnight.
            { property: NOTION.publishedAt, date: { on_or_before: new Date(now).toISOString() } },
          ],
        },
        ...PENDING.map((status) => ({ property: NOTION.siteStatus, select: { equals: status } })),
      ],
    },
  };
}

/**
 * An edit made by the status write-back: it lands seconds after the check time it records.
 * Author edits are anything else (also rows never checked). Listed editor IDs never count.
 */
export function isWriteBackEdit(row: NotionRow, ignoredEditors: Set<string>): boolean {
  if (row.lastEditedBy && ignoredEditors.has(row.lastEditedBy)) return true;
  if (row.checkedAt === null) return false;
  const checkedMinute = Math.floor(row.checkedAt / MINUTE) * MINUTE;
  return (
    row.lastEditedTime >= checkedMinute && row.lastEditedTime <= row.checkedAt + WRITE_BACK_WINDOW
  );
}

export function decide(input: {
  now: number;
  runs: RunSummary[];
  rows: NotionRow[];
  settings: DetectorSettings;
}): Decision {
  const { now, runs, rows, settings } = input;
  const window = releaseWindow(runs, now);
  const since = window.since - EDIT_PRECISION;

  const edited = rows.filter(
    (row) =>
      row.lastEditedTime >= since &&
      !isWriteBackEdit(row, settings.ignoredEditors) &&
      // A draft that was never public does not change the site.
      !(row.authorStatus === "Draft" && (row.siteStatus === null || row.siteStatus === NOT_ONLINE)),
  );
  // Became due after the last release started (an earlier release would have published it).
  const due = rows.filter(
    (row) =>
      row.siteStatus === SCHEDULED &&
      row.publishedAt !== null &&
      row.publishedAt <= now &&
      row.publishedAt > since,
  );
  const pendingStates = rows.filter(
    (row): row is NotionRow & { checkedAt: number } =>
      row.siteStatus !== null &&
      (PENDING as readonly string[]).includes(row.siteStatus) &&
      row.checkedAt !== null,
  );
  // A check after the last release finished still sees unpublished changes: an author edit that a
  // later write-back masked (e.g. 刷新状态 after editing).
  const pending = pendingStates.filter((row) => row.checkedAt > window.finishedAt);
  // The newest release's own write-back found unpublished changes: an author edit made while it ran,
  // after its Notion snapshot, whose edit time that write-back then masked. One follow-up release
  // (trigger "pending") publishes it; a follow-up's own pending states never count, so a release
  // that cannot converge re-triggers itself at most once.
  const followUp =
    window.trigger !== null && window.trigger !== "pending"
      ? pendingStates.filter(
          (row) => row.checkedAt >= window.since && row.checkedAt <= window.finishedAt,
        )
      : [];
  const counts: Counts = {
    rows: rows.length,
    edited: edited.length,
    due: due.length,
    pending: pending.length,
    followUp: followUp.length,
  };

  // Quiet period: never publish while the author is still editing (a pending row's masked edit is
  // at the latest its check time).
  const newestEdit = Math.max(
    ...edited.map((row) => row.lastEditedTime),
    ...[...pending, ...followUp].map((row) => row.checkedAt),
    Number.NEGATIVE_INFINITY,
  );
  if (now - newestEdit < settings.quietMinutes * MINUTE) {
    return { action: "skip", code: "QUIET_PERIOD", counts };
  }

  const today = utcMidnight(now);
  // A release that keeps failing (e.g. a blocked gate that needs recovery) must not be retried all day:
  // GitHub has already notified the owner of each failure.
  const failedToday = runs.filter(
    (run) => run.operation === "release" && run.conclusion === "failure" && run.createdAt >= today,
  ).length;
  if (failedToday >= MAX_FAILED_RELEASES_PER_DAY) {
    return { action: "skip", code: "FAILURES_TODAY", counts };
  }
  const reconcileDue =
    new Date(now).getUTCHours() >= settings.reconcileUtcHour &&
    !runs.some((run) => run.trigger === "reconcile" && run.createdAt >= today);
  const changed = edited.length + due.length + pending.length > 0;

  if (changed || followUp.length > 0) {
    const autoToday = runs.filter(
      (run) => (run.trigger === "cron" || run.trigger === "pending") && run.createdAt >= today,
    ).length;
    if (autoToday < settings.maxAutoReleasesPerDay) {
      return changed
        ? { action: "dispatch", trigger: "cron", code: "DISPATCH_CHANGES", counts }
        : { action: "dispatch", trigger: "pending", code: "DISPATCH_FOLLOW_UP", counts };
    }
    if (!reconcileDue) return { action: "skip", code: "AUTO_CAP_REACHED", counts };
  }
  if (reconcileDue) {
    return { action: "dispatch", trigger: "reconcile", code: "DISPATCH_RECONCILE", counts };
  }
  return { action: "skip", code: "NO_CHANGE", counts };
}

export function settingsFrom(env: RelayEnv): DetectorSettings {
  return {
    quietMinutes: boundedInteger(env.QUIET_MINUTES, 25, 0, 24 * 60),
    maxAutoReleasesPerDay: boundedInteger(env.MAX_AUTO_RELEASES_PER_DAY, 6, 0, 48),
    reconcileUtcHour: boundedInteger(env.RECONCILE_UTC_HOUR, 10, 0, 23),
    ignoredEditors: new Set(
      (env.IGNORED_EDITOR_IDS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  };
}

export interface DetectorResult {
  code: string;
  counts?: Counts;
  githubStatus?: number;
  notionStatus?: number;
}

/** One tick. Logs (by the caller) only the returned code and counts. */
export async function runDetector(env: RelayEnv, now: Date): Promise<DetectorResult> {
  if (env.AUTO_PUBLISH !== "true") return { code: "AUTO_PUBLISH_OFF" };
  if (!env.GITHUB_DISPATCH_TOKEN || !env.NOTION_TOKEN || !env.NOTION_DATA_SOURCE_ID) {
    return { code: "NOT_CONFIGURED" };
  }
  const signal = AbortSignal.timeout(20_000);
  try {
    const listed = await listRuns(env, signal);
    if (!listed.ok) return { code: "GITHUB_UNAVAILABLE", githubStatus: listed.status };
    const runs = parseRuns(await listed.json());
    if (!runs) return { code: "GITHUB_UNAVAILABLE" };
    if (runs.some((run) => ACTIVE_STATUSES.has(run.status))) return { code: "RUN_ACTIVE" };

    const window = releaseWindow(runs, now.getTime());
    const queryUrl = `https://api.notion.com/v1/data_sources/${encodeURIComponent(env.NOTION_DATA_SOURCE_ID)}/query`;
    const notionToken = env.NOTION_TOKEN;
    /** One result page, or the failure to report (the HTTP status only when Notion refused). */
    const query = async (
      body: Record<string, unknown>,
    ): Promise<
      { page: NonNullable<ReturnType<typeof parsePage>> } | { page: null; failure: DetectorResult }
    > => {
      const queried = await fetch(queryUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${notionToken}`,
          "Notion-Version": env.NOTION_API_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
        redirect: "manual",
      });
      if (!queried.ok) {
        return {
          page: null,
          failure: { code: "NOTION_UNAVAILABLE", notionStatus: queried.status },
        };
      }
      const page = parsePage(await queried.json());
      return page ? { page } : { page: null, failure: { code: "NOTION_UNAVAILABLE" } };
    };

    const rows: NotionRow[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_QUERY_PAGES; page += 1) {
      const result = await query(
        notionQuery(window, now.getTime(), cursor ? { startCursor: cursor } : {}),
      );
      if (!result.page) return result.failure;
      rows.push(...result.page.rows);
      cursor = result.page.nextCursor ?? undefined;
      if (!cursor) break;
    }
    if (cursor) {
      // More rows matched than were read. The newest edits are in; due and pending rows may not be.
      const result = await query(notionQuery(window, now.getTime(), { dueOrPendingOnly: true }));
      if (!result.page) return result.failure;
      const seen = new Set(rows.map((row) => row.id).filter(Boolean));
      rows.push(...result.page.rows.filter((row) => !row.id || !seen.has(row.id)));
    }

    const decision = decide({ now: now.getTime(), runs, rows, settings: settingsFrom(env) });
    if (decision.action === "skip") return { code: decision.code, counts: decision.counts };
    const dispatched = await dispatch(env, releaseInputs(env, decision.trigger), signal);
    if (dispatched.status !== 200 && dispatched.status !== 204) {
      return { code: "DISPATCH_FAILED", githubStatus: dispatched.status, counts: decision.counts };
    }
    return { code: decision.code, counts: decision.counts };
  } catch {
    return { code: "DETECTOR_ERROR" };
  }
}
