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
 * The scheduled change detector (docs/architecture.md, "Automatic releases"). Every tick costs at
 * most three subrequests: one GitHub run listing, one Notion query, one dispatch. All state lives
 * in GitHub (the release runs) and Notion (the rows and their feedback properties); the Worker
 * stores nothing.
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
/** The status write-back edits a row within seconds of the check time it writes. */
const WRITE_BACK_WINDOW = 3 * MINUTE;

export interface NotionRow {
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
  | { action: "dispatch"; trigger: "cron" | "reconcile"; code: string; counts: Counts };

export interface Counts {
  rows: number;
  edited: number;
  due: number;
  pending: number;
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
  if (!isRecord(body) || !Array.isArray(body.results)) return null;
  const rows: NotionRow[] = [];
  for (const page of body.results) {
    if (!isRecord(page) || page.archived === true || page.in_trash === true) continue;
    const lastEditedTime = parseTime(page.last_edited_time);
    if (lastEditedTime === null) continue;
    rows.push({
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
  return rows;
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
  if (!last) return { since: now - 24 * 60 * MINUTE, finishedAt: now - 24 * 60 * MINUTE };
  return { since: last.startedAt, finishedAt: last.updatedAt };
}

/** The Notion filter: anything edited since the last release, due scheduled posts, pending states. */
export function notionQuery(window: ReleaseWindow, now: number): Record<string, unknown> {
  return {
    page_size: 25,
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    filter: {
      or: [
        {
          timestamp: "last_edited_time",
          last_edited_time: { on_or_after: new Date(window.since - EDIT_PRECISION).toISOString() },
        },
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
  // A check after the last release finished still sees unpublished changes: an author edit that a
  // later write-back masked (e.g. 刷新状态 after editing). The release's own write-back happens
  // before it finishes, so a release that cannot converge never re-triggers itself.
  const pending = rows.filter(
    (row) =>
      row.siteStatus !== null &&
      (PENDING as readonly string[]).includes(row.siteStatus) &&
      row.checkedAt !== null &&
      row.checkedAt > window.finishedAt,
  );
  const counts: Counts = {
    rows: rows.length,
    edited: edited.length,
    due: due.length,
    pending: pending.length,
  };

  // Quiet period: never publish while the author is still editing (a pending row's masked edit is
  // at the latest its check time).
  const newestEdit = Math.max(
    ...edited.map((row) => row.lastEditedTime),
    ...pending.map((row) => row.checkedAt ?? Number.NEGATIVE_INFINITY),
    Number.NEGATIVE_INFINITY,
  );
  if (now - newestEdit < settings.quietMinutes * MINUTE) {
    return { action: "skip", code: "QUIET_PERIOD", counts };
  }

  const today = utcMidnight(now);
  const reconcileDue =
    new Date(now).getUTCHours() >= settings.reconcileUtcHour &&
    !runs.some((run) => run.trigger === "reconcile" && run.createdAt >= today);
  const changed = edited.length + due.length + pending.length > 0;

  if (changed) {
    const autoToday = runs.filter((run) => run.trigger === "cron" && run.createdAt >= today).length;
    if (autoToday < settings.maxAutoReleasesPerDay) {
      return { action: "dispatch", trigger: "cron", code: "DISPATCH_CHANGES", counts };
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
    const queried = await fetch(
      `https://api.notion.com/v1/data_sources/${encodeURIComponent(env.NOTION_DATA_SOURCE_ID)}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.NOTION_TOKEN}`,
          "Notion-Version": env.NOTION_API_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(notionQuery(window, now.getTime())),
        signal,
        redirect: "manual",
      },
    );
    if (!queried.ok) return { code: "NOTION_UNAVAILABLE", notionStatus: queried.status };
    const rows = parseRows(await queried.json());
    if (!rows) return { code: "NOTION_UNAVAILABLE" };

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
