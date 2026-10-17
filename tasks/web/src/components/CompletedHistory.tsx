import { useEffect, useState } from "react";
import { CheckCheck } from "lucide-react";
import { api, describeError } from "../api";
import type { Completion } from "@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb";

export function CompletedHistory({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<Completion[]>([]);
  const [nextPage, setNextPage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function read(pageToken = "") {
    setBusy(true);
    setError("");
    try {
      const result = await api.listCompletions({ pageSize: 100, pageToken });
      setItems((current) =>
        pageToken ? [...current, ...result.completions] : result.completions,
      );
      setNextPage(result.nextPageToken);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void read();
  }, []);
  return (
    <section className="completion-history">
      <h2>Completion history</h2>
      <p className="muted">
        Includes every recorded occurrence of recurring tasks.
      </p>
      {error && (
        <p className="error-message" role="alert">
          {error}
          <button onClick={() => void read()} className="text-button">
            Retry
          </button>
        </p>
      )}
      {items.map((item) => (
        <button
          className="completion-row"
          key={item.id}
          onClick={() => onOpen(item.taskId)}
        >
          <CheckCheck size={17} />
          <span>{item.title}</span>
          <time>
            {item.completeTime
              ? new Date(
                  Number(item.completeTime.seconds) * 1000,
                ).toLocaleString()
              : ""}
          </time>
        </button>
      ))}
      {!busy && !error && !items.length && (
        <p className="empty-copy">No recorded completions yet.</p>
      )}
      {busy && (
        <p role="status" className="muted">
          Loading history…
        </p>
      )}
      {nextPage && (
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => void read(nextPage)}
        >
          Load more history
        </button>
      )}
    </section>
  );
}
