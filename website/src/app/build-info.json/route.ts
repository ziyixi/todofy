import { getContentBundle, getSiteData } from "@/app/_site-data";
import { CONTENT_SCHEMA_VERSION } from "@/lib/content";

export const dynamic = "force-static";
export const revalidate = false;

export async function GET() {
  const [{ manifest }] = await Promise.all([getContentBundle(), getSiteData()]);
  const codeSha =
    process.env.CODE_SHA ??
    process.env.GITHUB_SHA ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    "local-development";
  return Response.json(
    {
      codeSha,
      configHash: manifest.configHash,
      contentHash: manifest.contentHash,
      schemaVersion: CONTENT_SCHEMA_VERSION,
    },
    {
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  );
}
