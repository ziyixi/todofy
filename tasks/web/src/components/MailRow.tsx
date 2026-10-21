import { ChevronDown, ChevronRight, Inbox, Trash2 } from "lucide-react";
import type { MailCategory } from "@ziyixi/proto/tasks/ui/v1/mail_pb";
import type { MailItem } from "@ziyixi/proto/todofy/mail/v1/mail_service_pb";

export type MailSummary = { loading?: boolean; text?: string; error?: string };
export function MailRow({
  item,
  choices,
  expanded,
  summary,
  busy,
  saving,
  pendingCategory,
  onToggle,
  onRetrySummary,
  onFile,
  onDelete,
}: {
  item: MailItem;
  choices: { category: MailCategory; label: { title: string } }[];
  expanded: boolean;
  summary?: MailSummary;
  busy: boolean;
  saving: boolean;
  pendingCategory?: string;
  onToggle: () => void;
  onRetrySummary: () => void;
  onFile: (category?: MailCategory) => void;
  onDelete: () => void;
}) {
  const received = item.receiveTime
    ? new Date(Number(item.receiveTime.seconds) * 1000).toLocaleString(
        undefined,
        {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        },
      )
    : "";
  return (
    <li className="native-mail-item">
      <div className="native-mail-row">
        <button
          className="native-mail-preview"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <span>
            <strong>{item.title || "(No subject)"}</strong>
            {item.brief && (
              <span className="native-mail-brief">{item.brief}</span>
            )}
          </span>
        </button>
        <time>{received}</time>
      </div>
      {expanded && (
        <div className="native-mail-summary">
          {summary?.loading ? (
            "Loading summary…"
          ) : summary?.error ? (
            <p role="alert">
              {summary.error}
              <button className="text-button" onClick={onRetrySummary}>
                Retry summary
              </button>
            </p>
          ) : (
            summary?.text || "No summary is available."
          )}
        </div>
      )}
      <div className="native-mail-actions">
        {choices.map(({ category, label }) => (
          <button
            key={category.id}
            className="native-mail-category"
            disabled={
              busy ||
              (pendingCategory !== undefined && pendingCategory !== category.id)
            }
            title={`Create task with ${label.title} · P${category.priority}`}
            onClick={() => onFile(category)}
          >
            {label.title}
            <span>· P{category.priority}</span>
          </button>
        ))}
        <button
          className="native-mail-create"
          disabled={busy}
          onClick={() => onFile()}
        >
          {saving
            ? "Saving…"
            : pendingCategory !== undefined
              ? "Retry"
              : item.taskId
                ? "Move to Inbox"
                : "Create task"}
          <Inbox size={13} />
        </button>
        <button
          className="icon-button native-mail-delete"
          aria-label={`Delete mail ${item.title || "(No subject)"}`}
          disabled={busy}
          onClick={onDelete}
        >
          <Trash2 size={15} />
        </button>
      </div>
    </li>
  );
}
