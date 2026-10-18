import { useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { ChevronDown, Tag } from "lucide-react";
import type { Catalog } from "../api";
import "./label-picker.css";

export function LabelPicker({
  labels,
  selectedIds,
  onChange,
  disabled = false,
  open,
  onOpenChange,
}: {
  labels: Catalog["labels"];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const portal = useRef<HTMLElement | null>(null);
  const input = useRef<HTMLInputElement>(null);
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
      <Popover.Root
        open={open}
        onOpenChange={(value) => {
          if (value) setSearch("");
          onOpenChange(value);
        }}
      >
        <Popover.Trigger
          className="property-trigger label-picker-trigger"
          disabled={disabled}
          ref={(element: HTMLButtonElement | null) => {
            portal.current = element?.closest("dialog") ?? null;
          }}
        >
          <Tag size={15} />
          {selected.length ? "Edit labels" : "Add labels"}
          <ChevronDown size={13} className="property-chevron" />
        </Popover.Trigger>
        <Popover.Portal container={portal}>
          <Popover.Positioner
            align="start"
            sideOffset={5}
            positionMethod="fixed"
            className="label-picker-positioner"
          >
            <Popover.Popup
              className="label-picker-popup"
              aria-label="Label picker"
              initialFocus={input}
            >
              <div className="label-picker-search">
                <input
                  ref={input}
                  aria-label="Search labels"
                  placeholder="Search labels"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.metaKey &&
                      !event.ctrlKey
                    )
                      event.preventDefault();
                  }}
                />
              </div>
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
                    <Tag
                      size={13}
                      style={{ color: label.color || undefined }}
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
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
