import {
  Mailbox as SharedMailbox,
  type MailboxProps,
} from "@ziyixi/planning-ui/Mailbox";
import { todoistDestination } from "./destination";
export type { MailboxProps } from "@ziyixi/planning-ui/Mailbox";

export function Mailbox(props: Omit<MailboxProps, "destination">) {
  return <SharedMailbox {...props} destination={todoistDestination} />;
}
