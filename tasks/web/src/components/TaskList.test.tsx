import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import { EMPTY_CATALOG } from "../api";
import { TaskList } from "./TaskList";

afterEach(cleanup);

it("keeps the undated group after dated tasks even when it arrives first", () => {
  render(
    <TaskList
      tasks={[
        create(TaskSchema, { id: "undated", title: "Synthetic undated task" }),
        create(TaskSchema, {
          id: "dated",
          title: "Synthetic dated task",
          dueDate: "2040-06-07",
        }),
      ]}
      catalog={EMPTY_CATALOG}
      busyIds={new Set()}
      selected={new Set()}
      onSelect={() => {}}
      onOpen={() => {}}
      onComplete={() => {}}
      onReorder={() => {}}
      onDetach={() => {}}
      groupBy="date"
    />,
  );
  const headings = screen.getAllByRole("heading", { level: 2 });
  expect(headings[0]?.textContent).toContain("Jun 7");
  expect(headings[1]?.textContent).toBe("No date1");
});
