import { LoaderCircle } from "lucide-react";
import { words } from "./i18n";
import type { Language } from "./model";

/** Marks a card whose change is not yet confirmed, or not yet shown by a re-read. */
export function PendingMark({ language }: { language: Language }) {
  return (
    <LoaderCircle
      size={12}
      className="plus-spin plus-pending-mark"
      role="img"
      aria-label={words(language).updating}
    />
  );
}
