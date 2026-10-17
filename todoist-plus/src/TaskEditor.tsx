import {
  TaskEditor as SharedTaskEditor,
  type TaskEditorProps,
} from "@ziyixi/planning-ui/TaskEditor";
import { todoistDestination } from "./destination";
export type { TaskEditorProps } from "@ziyixi/planning-ui/TaskEditor";
export { LeadSelect } from "@ziyixi/planning-ui/TaskEditor";

export function TaskEditor(props: Omit<TaskEditorProps, "destination">) {
  return <SharedTaskEditor {...props} destination={todoistDestination} />;
}
