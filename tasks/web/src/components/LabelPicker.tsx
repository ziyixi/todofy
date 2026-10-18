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
            <span
              className="selected-label"
              key={label.id}
              style={{
                color: "#4a4a4a",
                background: label.color ? `${label.color}14` : "#f0f0ee",
              }}
            >
              <Tag size={12} style={{ color: label.color || undefined }} />
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
                  style={{ accentColor: label.color || undefined }}
                  checked={selectedIds.includes(label.id)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...selectedIds, label.id]
                        : selectedIds.filter((id) => id !== label.id),
                    )
                  }
                />
                <Tag size={13} style={{ color: label.color || undefined }} />
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
