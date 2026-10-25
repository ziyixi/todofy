import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import { ListTasksResponseSchema } from "@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb";
import { api } from "../api";
import { useTaskActions } from "../useTaskActions";
import { useTaskView } from "../useTaskView";
import { GoalRelatedTasks } from "./GoalRelatedTasks";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows a failed completion once through App's existing notice without rejecting the button's promise", async () => {
  const task = create(TaskSchema, {
    id: "linked",
    name: "tasks/linked",
    title: "Synthetic linked task",
    etag: "1",
    keyResultId: "result",
  });
  vi.spyOn(api, "listTasks").mockResolvedValue(
    create(ListTasksResponseSchema, { tasks: [task] }),
  );
  vi.spyOn(api, "completeTask").mockRejectedValue(
    new Error("Synthetic unavailable completion"),
  );
  const rejection = vi.fn();
  window.addEventListener("unhandledrejection", rejection);
  function Harness() {
    const route = { page: "goals" as const, id: "result" };
    const list = useTaskView(route, "", "", "sort_order", false);
    const actions = useTaskActions(route, "sort_order", list);
    return (
      <>
        {actions.notice && <div role="status">{actions.notice}</div>}
        <GoalRelatedTasks
          keyResultId="result"
          keyResultTitle="Synthetic annual result"
          refreshRevision={actions.mutationRevision}
          onOpenTask={vi.fn()}
          onCreateTask={vi.fn()}
          onCompleteTask={actions.complete}
        />
      </>
    );
  }
  try {
    render(<Harness />);
    const button = await screen.findByRole("button", {
      name: `Complete ${task.title}`,
    });
    fireEvent.click(button);
    const notice =
      "Could not confirm this change. Check your connection and try again.";
    await screen.findByRole("status");
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    expect(screen.getAllByText(notice)).toHaveLength(1);
    expect(rejection).not.toHaveBeenCalled();
    expect(api.completeTask).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: task.title })).toBeTruthy();
  } finally {
    window.removeEventListener("unhandledrejection", rejection);
  }
});
