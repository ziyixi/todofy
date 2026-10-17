import {
  App as SharedApp,
  type PlanningAppProps,
} from "@ziyixi/planning-ui/App";
import { todoistDestination } from "./destination";
export type { PlanningAppProps } from "@ziyixi/planning-ui/App";

export function App(props: Omit<PlanningAppProps, "destination">) {
  return <SharedApp {...props} destination={todoistDestination} />;
}
