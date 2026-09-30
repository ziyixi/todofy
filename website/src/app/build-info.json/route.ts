import { getBuildIdentity } from "@/app/_build-identity";
import { getContentBundle, getSiteData } from "@/app/_site-data";

export const dynamic = "force-static";
export const revalidate = false;

export async function GET() {
  const [{ manifest }] = await Promise.all([getContentBundle(), getSiteData()]);
  return Response.json(getBuildIdentity(manifest), {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
