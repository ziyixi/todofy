import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import {
  KeyResultSchema,
  ObjectiveSchema,
} from "@ziyixi/proto/tasks/ui/v1/goals_pb";
import { api } from "../api";
import { GoalEditor } from "./GoalEditor";

vi.mock("./Dialog", () => ({
  Dialog: ({ title, children }: { title: string; children: ReactNode }) => (
    <section role="dialog" aria-label={title}>
      {children}
    </section>
  ),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const objective = create(ObjectiveSchema, {
  id: "direction",
  name: "objectives/direction",
  title: "Synthetic direction",
  year: 2026,
  etag: "objective-v1",
});

it("creates an objective in the selected year without adding results or progress", async () => {
  const saved = create(ObjectiveSchema, {
    ...objective,
    title: "A new direction",
    year: 2027,
  });
  const createObjective = vi
    .spyOn(api, "createObjective")
    .mockResolvedValue(saved);
  const createResult = vi.spyOn(api, "createKeyResult");
  const createProgress = vi.spyOn(api, "createGoalProgress");
  const onClose = vi.fn();
  const onSaved = vi.fn().mockResolvedValue(undefined);
  render(
    <GoalEditor
      kind="objective"
      year={2027}
      objectives={[]}
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: saved.title },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(createObjective).toHaveBeenCalledWith(
    expect.objectContaining({
      objective: expect.objectContaining({ title: saved.title, year: 2027 }),
    }),
  );
  expect(onSaved).toHaveBeenCalledWith(saved);
  expect(createResult).not.toHaveBeenCalled();
  expect(createProgress).not.toHaveBeenCalled();
});

it("creates a result with the owner's milestone definitions and no measured completion", async () => {
  const saved = create(KeyResultSchema, {
    id: "new-result",
    objectiveId: objective.id,
    title: "Publish an example",
    kind: "outcome",
  });
  const write = vi.spyOn(api, "createKeyResult").mockResolvedValue(saved);
  render(
    <GoalEditor
      kind="keyResult"
      year={2026}
      objectives={[objective]}
      objective={objective}
      onClose={vi.fn()}
      onSaved={async () => {}}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: saved.title },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Floor" }), {
    target: { value: "One working example" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add milestone" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Milestone 1" }), {
    target: { value: "Example can be reproduced" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(write).toHaveBeenCalledOnce());
  expect(write.mock.calls[0]?.[0]?.keyResult).toEqual(
    expect.objectContaining({
      title: saved.title,
      objectiveId: objective.id,
      kind: "outcome",
      floorText: "One working example",
      milestones: [
        { id: "", title: "Example can be reproduced", completed: false },
      ],
    }),
  );
  expect(write.mock.calls[0]?.[0]?.keyResult?.completed).toBeUndefined();
});

it("archives an objective through its etag and explicit update fields", async () => {
  const write = vi
    .spyOn(api, "updateObjective")
    .mockResolvedValue(
      create(ObjectiveSchema, { ...objective, archived: true }),
    );
  render(
    <GoalEditor
      kind="objective"
      year={2026}
      objectives={[objective]}
      objective={objective}
      onClose={vi.fn()}
      onSaved={async () => {}}
    />,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Archived" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(write).toHaveBeenCalledOnce());
  expect(write).toHaveBeenCalledWith(
    expect.objectContaining({
      etag: objective.etag,
      objective: expect.objectContaining({
        name: objective.name,
        archived: true,
      }),
      updateMask: { paths: ["title", "description", "source_url", "archived"] },
    }),
  );
});
