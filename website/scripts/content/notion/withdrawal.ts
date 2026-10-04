import { ContentError } from "../../../src/lib/content/errors";
import { sourceKeyForNotionPage } from "../../../src/lib/content/hash";
import { queryAllArchivedDataSourcePages } from "./pagination";
import type { NotionClientLike } from "./types";

export function isWithdrawnPage(row: Record<string, unknown>): boolean {
  return row.is_archived === true || row.in_trash === true || row.archived === true;
}

/** Compare only former public identities; no raw IDs or Notion content leave the sync process. */
export async function emptyWithdrawalFingerprint(options: {
  client: NotionClientLike;
  dataSourceId: string;
  source: unknown;
  rows: unknown[];
  previousPublishedKeys: readonly string[];
  statusProperty: string;
}): Promise<string> {
  const { client, dataSourceId, rows, previousPublishedKeys, statusProperty } = options;
  if (
    !isRecord(options.source) ||
    options.source.object !== "data_source" ||
    !sameId(options.source.id, dataSourceId) ||
    isWithdrawnPage(options.source)
  ) {
    throw new ContentError(
      "NOTION_WITHDRAWAL_SOURCE_MISMATCH",
      "The configured Notion source cannot confirm article withdrawals.",
    );
  }

  const previousKeys = new Set(previousPublishedKeys);
  const evidence = new Map<string, { reason: "draft" | "archived"; editedAt: string }>();
  const seen = new Set<string>();

  function collect(input: unknown[], archivedPartition: boolean): void {
    for (const row of input) {
      if (!isRecord(row) || row.object !== "page" || typeof row.id !== "string") {
        throw new ContentError(
          "INVALID_NOTION_PAGE",
          "Notion returned an incomplete page identity.",
        );
      }
      if (!/^[a-f0-9]{32}$/i.test(row.id.replaceAll("-", ""))) {
        throw new ContentError("INVALID_NOTION_PAGE", "Notion returned an invalid page identity.");
      }
      const key = sourceKeyForNotionPage(row.id);
      if (!previousKeys.has(key)) continue;
      if (seen.has(key)) {
        throw new ContentError(
          "INVALID_NOTION_PAGE",
          "Notion returned duplicate article identities.",
        );
      }
      seen.add(key);
      if (
        !isRecord(row.parent) ||
        row.parent.type !== "data_source_id" ||
        !sameId(row.parent.data_source_id, dataSourceId)
      ) {
        throw new ContentError(
          "NOTION_WITHDRAWAL_SOURCE_MISMATCH",
          "A former public article no longer belongs to the configured Notion source.",
        );
      }
      if (
        typeof row.last_edited_time !== "string" ||
        !Number.isFinite(Date.parse(row.last_edited_time))
      ) {
        throw new ContentError(
          "INVALID_NOTION_PAGE",
          "Notion returned an invalid article edit time.",
        );
      }
      const archived = isWithdrawnPage(row);
      if (archivedPartition && !archived) {
        throw new ContentError(
          "INVALID_NOTION_PAGE",
          "The archived query returned an active article.",
        );
      }
      const status = isRecord(row.properties) ? row.properties[statusProperty] : undefined;
      const draft = isRecord(status) && isRecord(status.status) && status.status.name === "Draft";
      if (archived || draft) {
        evidence.set(key, {
          reason: archived ? "archived" : "draft",
          editedAt: row.last_edited_time,
        });
      }
    }
  }

  collect(rows, false);
  if (evidence.size < previousKeys.size) {
    collect(await queryAllArchivedDataSourcePages(client, dataSourceId), true);
  }
  if (evidence.size !== previousKeys.size) {
    throw new ContentError(
      "UNCONFIRMED_EMPTY_COLLECTION",
      "Notion did not explicitly withdraw every previously published article; the existing site is preserved.",
    );
  }
  return JSON.stringify(
    [...evidence.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function sameId(value: unknown, expected: string): boolean {
  return (
    typeof value === "string" &&
    value.replaceAll("-", "").toLowerCase() === expected.replaceAll("-", "").toLowerCase()
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
