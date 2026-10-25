import { afterEach, expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { GoalCatalogSchema } from "@ziyixi/proto/tasks/ui/v1/goals_pb";
import { api } from "./api";
import { clearGoalCatalogCache, loadGoalCatalog } from "./goals-client";

afterEach(() => {
  clearGoalCatalogCache();
  vi.restoreAllMocks();
});

it("shares only the small annual catalog until an explicit invalidation", async () => {
  const catalog = create(GoalCatalogSchema, {
    name: "goalCatalog",
    year: 2026,
  });
  const read = vi.spyOn(api, "getGoalCatalog").mockResolvedValue(catalog);
  expect(read).not.toHaveBeenCalled();
  const first = loadGoalCatalog();
  expect(loadGoalCatalog()).toBe(first);
  expect(await first).toBe(catalog);
  await loadGoalCatalog();
  expect(read).toHaveBeenCalledOnce();
  clearGoalCatalogCache();
  await loadGoalCatalog();
  expect(read).toHaveBeenCalledTimes(2);
  await loadGoalCatalog(2025);
  expect(read).toHaveBeenLastCalledWith({ name: "goalCatalog", year: 2025 });
});

it("allows a failed catalog read to be tried again", async () => {
  const read = vi
    .spyOn(api, "getGoalCatalog")
    .mockRejectedValueOnce(new Error("synthetic read failure"))
    .mockResolvedValue(create(GoalCatalogSchema));
  await expect(loadGoalCatalog()).rejects.toThrow("synthetic read failure");
  await loadGoalCatalog();
  expect(read).toHaveBeenCalledTimes(2);
});
