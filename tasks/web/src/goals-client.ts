import { api } from "./api";

export type GoalCatalog = Awaited<ReturnType<typeof api.getGoalCatalog>>;

// Only the small annual definitions are remembered, for this tab's lifetime.
const catalogs = new Map<number, Promise<GoalCatalog>>();

export function loadGoalCatalog(year = 0): Promise<GoalCatalog> {
  const existing = catalogs.get(year);
  if (existing) return existing;
  const request = api
    .getGoalCatalog({ name: "goalCatalog", year })
    .catch((error: unknown) => {
      if (catalogs.get(year) === request) catalogs.delete(year);
      throw error;
    });
  catalogs.set(year, request);
  return request;
}

export function clearGoalCatalogCache(): void {
  catalogs.clear();
}
