import {
  getSettings,
  updateSettings,
} from "@/features/settings/services/settings-service";
import {
  getSearchParams,
  readJsonBody,
  serviceJson,
} from "@/lib/server/route-helpers";
import type { SettingsUpdateBody } from "@/features/settings/contracts";

export async function GET(request: Request) {
  const searchParams = getSearchParams(request);
  return serviceJson(getSettings(searchParams.get("today")));
}

export async function PUT(request: Request) {
  return serviceJson(updateSettings(await readJsonBody<SettingsUpdateBody>(request)));
}
