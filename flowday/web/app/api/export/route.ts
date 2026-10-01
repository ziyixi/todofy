import { exportData } from "@/features/settings/services/export-service";
import { getSearchParams, jsonError } from "@/lib/server/route-helpers";

export async function GET(request: Request) {
  const searchParams = getSearchParams(request);
  const result = exportData({
    type: searchParams.get("type"),
    format: searchParams.get("format"),
    startDate: searchParams.get("start"),
    endDate: searchParams.get("end"),
  });
  if (!result.ok) {
    return jsonError(result.error, result.status);
  }
  return result.data;
}
