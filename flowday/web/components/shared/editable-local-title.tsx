"use client";

import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";

interface EditableLocalTitleProps {
  title: string;
  isLocal: boolean;
  onCommit: (title: string) => void;
}

export function EditableLocalTitle({
  title,
  isLocal,
  onCommit,
}: EditableLocalTitleProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (!editing) {
    return (
      <div className="flex min-w-0 items-center gap-1">
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
        {isLocal && (
          <button
            data-testid="edit-local-title"
            onClick={(e) => {
              e.stopPropagation();
              setValue(title);
              setEditing(true);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-all hover:text-foreground group-hover:opacity-100"
            title="Edit title"
          >
            <Pencil className="h-2.5 w-2.5" />
          </button>
        )}
      </div>
    );
  }

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== title) {
      onCommit(trimmed);
    }
    setEditing(false);
  };

  return (
    <input
      ref={inputRef}
      data-testid="edit-local-title-input"
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className="w-full truncate rounded bg-transparent px-0.5 py-0 text-sm font-medium text-foreground -mx-0.5 outline-none ring-1 ring-primary"
    />
  );
}
