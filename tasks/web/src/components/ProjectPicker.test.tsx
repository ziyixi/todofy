import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import {
  ProjectSchema,
  SectionSchema,
} from "@ziyixi/proto/tasks/ui/v1/task_pb";
import { ProjectPicker } from "./ProjectPicker";

afterEach(cleanup);

it("keeps an archived task's actual project and section visible instead of showing Inbox", () => {
  const catalog = {
    projects: [
      create(ProjectSchema, {
        id: "old",
        title: "Archived studio",
        archived: true,
        color: "#db4035",
      }),
    ],
    sections: [
      create(SectionSchema, {
        id: "notes",
        title: "Old notes",
        projectId: "old",
        archived: true,
      }),
    ],
    labels: [],
    filters: [],
    timeZone: "America/Los_Angeles",
  };
  render(
    <ProjectPicker
      catalog={catalog}
      projectId="old"
      sectionId="notes"
      disabled={false}
      open={false}
      onOpenChange={() => {}}
      onChange={() => {}}
    />,
  );
  expect(screen.getByRole("combobox", { name: "Project" }).textContent).toBe(
    "Archived studio / Old notes",
  );
});
