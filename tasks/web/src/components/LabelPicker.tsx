import { useState } from "react";
import { ChevronDown, Tag } from "lucide-react";
import type { Catalog } from "../api";

export function LabelPicker({
  labels,
  selectedIds,
  onChange,
}: {
  labels: Catalog["labels"];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const selected = labels.filter((label) => selectedIds.includes(label.id));
  const matches = labels.filter((label) =>
    label.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <div className="label-property">
      <span className="property-heading">Labels</span>
      {selected.length > 0 && (
        <div className="selected-labels">
          {selected.map((label) => (
            <span className="selected-label" key={label.id}>
              <Tag size={12} />
              {label.title}
            </span>
          ))}
        </div>
      )}
      <details className="label-picker">
        <summary>
          <Tag size={15} />
          {selected.length ? "Edit labels" : "Add labels"}
          <ChevronDown size={13} />
        </summary>
        <div className="label-picker-panel">
          <input
            aria-label="Search labels"
            placeholder="Search labels"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.metaKey && !event.ctrlKey)
                event.preventDefault();
            }}
          />
          <div className="label-picker-options">
            {matches.map((label) => (
              <label key={label.id}>
                <input
                  type="checkbox"
                  checked={selectedIds.includes(label.id)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...selectedIds, label.id]
                        : selectedIds.filter((id) => id !== label.id),
                    )
                  }
                />
                {label.title}
              </label>
            ))}
            {matches.length === 0 && (
              <p className="field-hint">
                {labels.length ? "No matching labels" : "No labels yet"}
              </p>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}
