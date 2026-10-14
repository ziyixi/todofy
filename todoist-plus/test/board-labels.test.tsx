import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BoardLabels } from "../design/BoardLabels";
import { LANES } from "../design/planning-model";

afterEach(cleanup);

it("saves a custom Quarter label without changing column identities or other mappings", () => {
  const before = structuredClone(LANES);
  const save = vi.fn();
  const close = vi.fn();
  render(<BoardLabels lanes={LANES} onSave={save} onClose={close} />);
  fireEvent.change(screen.getByLabelText("Quarter"), {
    target: { value: "  quarter_candidates  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith(
    before.map((lane) =>
      lane.id === "quarter" ? { ...lane, label: "quarter_candidates" } : lane,
    ),
  );
  expect(LANES).toEqual(before);
  expect(close).toHaveBeenCalledOnce();
});

it("keeps the editor open and names empty or duplicate label mappings", () => {
  const save = vi.fn();
  const close = vi.fn();
  render(<BoardLabels lanes={LANES} onSave={save} onClose={close} />);
  fireEvent.change(screen.getByLabelText("Quarter"), {
    target: { value: " " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert").textContent).toContain(
    "Quarter needs a label",
  );
  fireEvent.change(screen.getByLabelText("Quarter"), {
    target: { value: "FOCUS" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert").textContent).toContain("Quarter and Week");
  expect(save).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});
