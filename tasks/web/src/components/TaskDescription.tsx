import { useState } from "react";
import { AlignLeft, Pencil } from "lucide-react";
import DescriptionMarkdown from "./DescriptionMarkdown";

export function TaskDescription({
  value,
  onChange,
  onDone,
  busy,
}: {
  value: string;
  onChange: (value: string) => void;
  onDone: () => Promise<boolean>;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <section className="task-description-detail" aria-label="Task description">
      {editing ? (
        <>
          <label className="visually-hidden" htmlFor="task-description">
            Description
          </label>
          <textarea
            id="task-description"
            className="description-input"
            aria-label="Description"
            autoFocus
            placeholder="Description"
            value={value}
            disabled={busy}
            onChange={(event) => onChange(event.target.value)}
            rows={5}
          />
          <button
            type="button"
            className="text-button description-done"
            disabled={busy}
            onClick={async () => {
              if (await onDone()) setEditing(false);
            }}
          >
            Done
          </button>
        </>
      ) : (
        <>
          {value && (
            <div className="description-preview">
              <DescriptionMarkdown>{value}</DescriptionMarkdown>
            </div>
          )}
          <button
            type="button"
            className="text-button description-edit"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            {value ? <Pencil size={13} /> : <AlignLeft size={15} />}
            {value ? "Edit description" : "Add description"}
          </button>
        </>
      )}
    </section>
  );
}
