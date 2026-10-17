import type { TaskDestination } from "@ziyixi/planning-ui";
import { todoistProjectUrl, todoistTaskUrl } from "./domain";

export const todoistDestination: TaskDestination = {
  name: "Todoist",
  taskHref: todoistTaskUrl,
  projectHref: todoistProjectUrl,
};
