import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import {
  ConfirmPlanMappingResponseSchema,
  PlanSchema,
  UpdatePlanLabelsResponseSchema,
  type Plan,
} from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";
import { planningApi } from "../usePlanningSettings";
import { PlanningSettings } from "./PlanningSettings";

afterEach(() => vi.restoreAllMocks());

it("confirms native mapping and saves a selected Quarter identity without an extension credential", async () => {
  const initial = create(PlanSchema, {
    etag: "initial-mapping",
    timezone: "America/Los_Angeles",
    labels: [
      { role: "candiate", id: "month", label: "Month" },
      { role: "focus", id: "week", label: "Week" },
      { role: "committed", id: "commit", label: "Committed" },
    ],
    availableLabels: [
      { id: "month", label: "Month" },
      { id: "week", label: "Week" },
      { id: "commit", label: "Committed" },
      { id: "quarter-custom", label: "A custom quarter label" },
    ],
  });
  const confirmed = create(PlanSchema, { ...initial, enabled: true });
  const confirm = vi
    .spyOn(planningApi, "confirmPlanMapping")
    .mockResolvedValue(
      create(ConfirmPlanMappingResponseSchema, { plan: confirmed }),
    );
  const update = vi
    .spyOn(planningApi, "updatePlanLabels")
    .mockResolvedValue(
      create(UpdatePlanLabelsResponseSchema, { plan: confirmed }),
    );
  function Harness() {
    const [plan, setPlan] = useState<Plan | undefined>(initial);
    return (
      <PlanningSettings
        state={{
          plan,
          setPlan,
          loading: false,
          error: "",
          load: async () => {},
          accept: () => {},
        }}
      />
    );
  }
  render(<Harness />);
  expect(screen.queryByLabelText(/api key|token/i)).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm mapping and enable planning" }),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Planning enabled" })
        .hasAttribute("disabled"),
    ).toBe(true),
  );
  expect(confirm.mock.calls[0]?.[0].etag).toBe("initial-mapping");
  fireEvent.change(screen.getByRole("combobox", { name: "Quarter label" }), {
    target: { value: "quarter-custom" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save columns" }));
  await screen.findByText("Planning columns saved.");
  expect(update.mock.calls[0]?.[0].labels).toContainEqual({
    role: "quarter",
    id: "quarter-custom",
    label: "A custom quarter label",
  });
});
