import { create } from "@ziyixi/proto/protobuf";
import { PlanSchema } from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";
import { describe, expect, it } from "vitest";
import { planningChips, planningPresentation } from "./planning-presentation";

describe("native planning presentation", () => {
  it("replaces confirmed role identities without hiding an unrelated same-name label", () => {
    const plan = create(PlanSchema, {
      enabled: true,
      labels: [
        { role: "committed", id: "managed-id", label: "My current commitment" },
      ],
      hiddenFilterIds: ["replaced-filter"],
    });
    const result = planningPresentation(plan);
    expect(result.roles.has("custom-id-with-same-title")).toBe(false);
    expect(
      planningChips(["managed-id", "custom-id-with-same-title"], result.roles),
    ).toEqual(["Committed"]);
    expect(result.hiddenFilters.has("replaced-filter")).toBe(true);
    expect(result.hiddenFilters.has("custom-filter")).toBe(false);
  });
  it("keeps organization visible if native planning is unavailable or not confirmed", () => {
    const plan = create(PlanSchema, {
      labels: [{ role: "focus", id: "weekly", label: "focus" }],
      hiddenFilterIds: ["weekly-filter"],
    });
    for (const result of [planningPresentation(), planningPresentation(plan)]) {
      expect(result.roles.size).toBe(0);
      expect(result.hiddenFilters.size).toBe(0);
    }
  });
});
