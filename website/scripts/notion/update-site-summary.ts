import { pathToFileURL } from "node:url";

import { Client } from "@notionhq/client";

import { siteConfig } from "../../content/site.config";
import { parseContentDate } from "../../src/lib/content/date";
import { ContentError } from "../../src/lib/content/errors";
import { assertKnownArguments, parseCliArguments } from "../content/args";

const marker = "网站最近一次成功发布（验收时间）：";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseCliArguments(argv);
  assertKnownArguments(args, ["confirmed-at"], []);
  const input = args.values.get("confirmed-at");
  if (!input) throw new ContentError("INVALID_ARGUMENT", "--confirmed-at is required.");
  const confirmedAt = new Date(parseContentDate(input));
  if (confirmedAt.getTime() > Date.now()) {
    throw new ContentError("INVALID_ARGUMENT", "Confirmation time must not be in the future.");
  }
  const {
    NOTION_TOKEN: token,
    NOTION_DATA_SOURCE_ID: dataSourceId,
    NOTION_API_VERSION: version,
  } = process.env;
  if (!token || !dataSourceId || version !== siteConfig.notion.apiVersion) {
    throw new ContentError(
      "NOTION_STATUS_CONFIGURATION",
      "Notion credentials and pinned API version are required.",
    );
  }
  const client = new Client({
    auth: token,
    notionVersion: version,
    timeoutMs: 30_000,
    logger: () => undefined,
  });
  const source = await client.dataSources.retrieve({ data_source_id: dataSourceId });
  if (!("parent" in source) || source.parent.type !== "database_id")
    throw new Error("Incomplete data source.");
  const databaseId = source.parent.database_id;
  const database = await client.databases.retrieve({ database_id: databaseId });
  if (!("description" in database)) throw new Error("Incomplete database.");
  const existing = database.description.map((part) => part.plain_text).join("");
  const prefix = existing.split(marker)[0]!.trimEnd();
  const confirmed = confirmedAt
    .toISOString()
    .replace("T", " ")
    .replace(/\.000Z$/, " UTC");
  const description = `${prefix}\n\n${marker}${confirmed}\n逐篇状态是最近一次检查结果；修改后点「刷新状态」，上线请点「发布网站」。`;
  // Preserve the user's existing description; Notion limits each text item to 2,000 characters.
  const chunks = Array.from({ length: Math.ceil(description.length / 1800) }, (_, index) => ({
    type: "text" as const,
    text: { content: description.slice(index * 1800, (index + 1) * 1800) },
  }));
  await client.databases.update({ database_id: databaseId, description: chunks });
  process.stdout.write(`Updated site release summary: ${confirmed}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const code = error instanceof ContentError ? error.code : "NOTION_SITE_SUMMARY_FAILED";
    process.stderr.write(
      `[${code}] Could not update the Notion site summary. The website remains unchanged.\n`,
    );
    process.exitCode = 1;
  });
}
