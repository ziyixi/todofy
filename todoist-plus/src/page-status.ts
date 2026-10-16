import type { AnchorKey } from "./anchors";
import type { Language } from "./model";

/**
 * Which enhancement is off on the Todoist page, and why: keys from closed sets only, never page
 * text, IDs or URLs. The content script reports it to the background, which keeps the latest in
 * storage.local for the options page; it never leaves the browser.
 */
export const ENHANCEMENTS = ["views", "taskTools"] as const;
const MISSING = [
  "sidebar",
  "content",
  "detailMain",
  "detailRow",
] as const satisfies readonly AnchorKey[];
export const REASONS = [
  ...MISSING,
  "taskIdMismatch",
  "remountLimited",
  "passLimited",
  "renderError",
] as const;
export type Enhancement = (typeof ENHANCEMENTS)[number];
export type Reason = (typeof REASONS)[number];
export interface PageStatus {
  language: Language;
  off: Partial<Record<Enhancement, Reason>>;
}

const isOneOf = <T extends string>(values: readonly T[], value: unknown) =>
  values.includes(value as T);

/** The status, or undefined when anything in it falls outside the closed sets. */
export function pageStatus(value: unknown): PageStatus | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { language, off, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length || !isOneOf(["en", "zh"], language))
    return undefined;
  if (typeof off !== "object" || off === null || Array.isArray(off))
    return undefined;
  const entries = Object.entries(off);
  if (
    !entries.every(
      ([enhancement, reason]) =>
        isOneOf(ENHANCEMENTS, enhancement) && isOneOf(REASONS, reason),
    )
  )
    return undefined;
  return {
    language: language as Language,
    off: Object.fromEntries(entries) as PageStatus["off"],
  };
}

const copy = {
  en: {
    title: "Todoist page check",
    ok: "all good",
    notRun: "open Todoist to run it",
    views: "Plan and Focus are off",
    taskTools: "Steps & timing is off",
    sidebar: "the sidebar was not found",
    content: "the main content area was not found",
    detailMain: "the task details area was not found",
    detailRow: "the task ID was not found",
    taskIdMismatch: "the task ID did not match the page link",
    remountLimited: "Todoist kept re-creating the page",
    passLimited: "the page kept changing without a pause",
    renderError: "a display error occurred",
  },
  zh: {
    title: "Todoist 页面检测",
    ok: "全部正常",
    notRun: "打开 Todoist 后运行",
    views: "计划和专注已关闭",
    taskTools: "步骤与时间已关闭",
    sidebar: "找不到侧栏",
    content: "找不到主内容区",
    detailMain: "找不到任务详情区域",
    detailRow: "找不到任务 ID",
    taskIdMismatch: "任务 ID 与页面链接不一致",
    remountLimited: "Todoist 反复重建页面",
    passLimited: "页面持续变化不停",
    renderError: "显示出错",
  },
} satisfies Record<Language, Record<string, string>>;

/** One line for the options page, in the Todoist page's language. */
export function statusLine(status: PageStatus | undefined): string {
  const text = copy[status?.language ?? "en"];
  const zh = status?.language === "zh";
  const separator = zh ? "：" : ": ";
  if (!status) return `${text.title}${separator}${text.notRun}`;
  const off = ENHANCEMENTS.flatMap((enhancement) => {
    const reason = status.off[enhancement];
    if (!reason) return [];
    return zh
      ? `${text[enhancement]}（${text[reason]}）`
      : `${text[enhancement]} (${text[reason]})`;
  });
  return `${text.title}${separator}${off.length ? off.join(zh ? "；" : "; ") : text.ok}`;
}
