import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { LabelSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import { LabelPicker } from "./LabelPicker";

afterEach(cleanup);

it("filters labels and changes selection without losing other selected labels", () => {
  const labels = [
    create(LabelSchema, { id: "focus", title: "Focus" }),
    create(LabelSchema, { id: "week", title: "This Week" }),
    create(LabelSchema, { id: "home", title: "Home" }),
  ];
  function Harness() {
    const [selectedIds, setSelectedIds] = useState(["focus"]);
    return <LabelPicker labels={labels} selectedIds={selectedIds} onChange={setSelectedIds} />;
  }
  render(<Harness />);
  const picker = screen.getByText("Edit labels").closest("details");
  expect(picker?.open).toBe(false);
  fireEvent.click(screen.getByText("Edit labels"));
  fireEvent.change(screen.getByRole("textbox", { name: "Search labels" }), {
    target: { value: "week" },
  });
  expect(screen.queryByRole("checkbox", { name: "Home" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "This Week" }));
  expect(screen.getByText("Focus", { selector: ".selected-label" })).toBeTruthy();
  expect(screen.getByText("This Week", { selector: ".selected-label" })).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Search labels" }), {
    target: { value: "focus" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Focus" }));
  expect(screen.queryByText("Focus", { selector: ".selected-label" })).toBeNull();
  expect(screen.getByText("This Week", { selector: ".selected-label" })).toBeTruthy();
});

it("distinguishes no labels from no search matches", () => {
  const { rerender } = render(<LabelPicker labels={[]} selectedIds={[]} onChange={() => {}} />);
  fireEvent.click(screen.getByText("Add labels"));
  expect(screen.getByText("No labels yet")).toBeTruthy();
  rerender(<LabelPicker labels={[create(LabelSchema, { id: "home", title: "Home" })]} selectedIds={[]} onChange={() => {}} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Search labels" }), {
    target: { value: "missing" },
  });
  expect(screen.getByText("No matching labels")).toBeTruthy();
});
