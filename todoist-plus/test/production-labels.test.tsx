import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { PlanState } from "../src/model";
import { BoardLabels } from "../src/BoardLabels";
import { createPrototype } from "../design/fixture";

afterEach(cleanup);

it("saves real label identities and keeps task labels untouched", async () => {
  const actions = createPrototype();
  const before = await actions.load();
  before.plan.availableLabels.push({
    id: "custom-quarter-id",
    label: "My quarter",
  });
  const save = vi.fn(async (labels: PlanState["managedLabels"]) => {
    await actions.updateLabels(labels, before.plan.etag);
    return true;
  });
  const close = vi.fn();
  render(
    <BoardLabels
      plan={before.plan}
      language="en"
      busy={false}
      onSave={save}
      onClose={close}
      onConnection={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("This quarter"), {
    target: { value: "custom-quarter-id" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]![0]).toContainEqual({
    role: "quarter",
    id: "custom-quarter-id",
    label: "My quarter",
  });
  expect((await actions.load()).plan.tasks).toEqual(before.plan.tasks);
});

it("shows a duplicate identity conflict without writing or closing", async () => {
  const { plan } = await createPrototype().load();
  const save = vi.fn();
  const close = vi.fn();
  render(
    <BoardLabels
      plan={plan}
      language="en"
      busy={false}
      onSave={save}
      onClose={close}
      onConnection={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("This quarter"), {
    target: { value: "synthetic-focus" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert").textContent).toBe(
    "Use a different label for each column.",
  );
  expect(save).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});
