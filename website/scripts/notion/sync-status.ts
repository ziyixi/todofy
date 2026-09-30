import { pathToFileURL } from "node:url";

import { Client } from "@notionhq/client";

import { siteConfig } from "../../content/site.config";
import { parseContentDate } from "../../src/lib/content/date";
import { ContentError } from "../../src/lib/content/errors";
import { assertKnownArguments, parseCliArguments } from "../content/args";
import { setupStatusSchema, syncNotionStatus, type StatusClient } from "./status";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseCliArguments(argv);
  assertKnownArguments(args, ["confirmed-at"], ["setup-schema", "dry-run"]);
  if (args.flags.has("setup-schema") && (args.flags.has("dry-run") || args.values.size > 0)) {
    throw new ContentError("INVALID_ARGUMENT", "Use --setup-schema without other options.");
  }
  if (process.env.SITE_URL && process.env.SITE_URL !== siteConfig.canonicalOrigin) {
    throw new ContentError(
      "SITE_URL_MISMATCH",
      "SITE_URL must exactly match the configured origin.",
    );
  }
  const token = process.env.NOTION_TOKEN;
  const dataSourceId = process.env.NOTION_DATA_SOURCE_ID;
  const apiVersion = process.env.NOTION_API_VERSION;
  if (!token || !dataSourceId || apiVersion !== siteConfig.notion.apiVersion) {
    throw new ContentError(
      "NOTION_STATUS_CONFIGURATION",
      "Configure NOTION_TOKEN, NOTION_DATA_SOURCE_ID, and the pinned NOTION_API_VERSION.",
    );
  }
  const client = new Client({
    auth: token,
    notionVersion: apiVersion,
    timeoutMs: 30_000,
    logger: () => undefined,
  }) as unknown as StatusClient;
  if (args.flags.has("setup-schema")) {
    const changed = await setupStatusSchema(client, dataSourceId);
    process.stdout.write(
      `Notion feedback schema verified; ${changed} properties added or updated.\n`,
    );
    return;
  }
  const confirmedAt = args.values.get("confirmed-at");
  const result = await syncNotionStatus({
    client,
    token,
    dataSourceId,
    apiVersion,
    dryRun: args.flags.has("dry-run"),
    ...(confirmedAt ? { confirmedAt: new Date(parseContentDate(confirmedAt)) } : {}),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.failed > 0) {
    throw new ContentError(
      "NOTION_STATUS_WRITE_FAILED",
      "Some Notion status rows could not be confirmed or updated; the website remains unchanged.",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // SDK errors can contain private page details; do not print their raw bodies.
    const code = error instanceof ContentError ? error.code : "NOTION_STATUS_FAILED";
    const message =
      error instanceof ContentError
        ? error.message
        : "Status synchronization failed. Check source permissions and service availability.";
    process.stderr.write(`[${code}] ${message}\n`);
    process.exitCode = 1;
  });
}
