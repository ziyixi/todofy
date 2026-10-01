import { getAnalytics } from "@/features/analytics/services/analytics-service";
import { getSearchParams, serviceJson } from "@/lib/server/route-helpers";

export async function GET(request: Request) {
  const searchParams = getSearchParams(request);
  return serviceJson(
    getAnalytics({
      type: searchParams.get("type"),
      date: searchParams.get("date"),
      timeZone: searchParams.get("tz"),
    })
  );
}
