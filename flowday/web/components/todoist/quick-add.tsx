"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useTodoistStore } from "@/features/todoist/store";

export function QuickAdd() {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const addLocalTask = useTodoistStore((s) => s.addLocalTask);

  async function handleSubmit() {
    const trimmed = value.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    await addLocalTask(trimmed);
    setValue("");
    setSubmitting(false);
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        data-testid="quick-add-input"
        type="text"
        placeholder="Quick add task..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSubmit();
        }}
        className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:ring-1 focus:ring-primary"
        disabled={submitting}
      />
      <button
        data-testid="quick-add-submit"
        onClick={handleSubmit}
        disabled={submitting || !value.trim()}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 sm:h-7 sm:w-7"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
