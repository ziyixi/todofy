import { lazy, Suspense, useState } from "react";
import { AlignLeft, Pencil } from "lucide-react";
const Markdown = lazy(() => import("./DescriptionMarkdown"));

export function TaskDescription({
  value,
  onChange,
  busy,
}: {
  value: string;
  onChange: (value: string) => void;
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
            onChange={(event) => onChange(event.target.value)}
            rows={5}
          />
          <button
            type="button"
            className="text-button description-done"
            onClick={() => setEditing(false)}
          >
            Done
          </button>
        </>
      ) : (
        <>
          {value && (
            <div className="description-preview">
              <Suspense fallback={<p className="description-loading">{value}</p>}>
                <Markdown>
                  {value}
                </Markdown>
              </Suspense>
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
