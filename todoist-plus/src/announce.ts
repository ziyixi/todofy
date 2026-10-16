import { useCallback, useEffect, useRef, useState } from "react";

/** How long a repeated message stays cleared before it is set again. */
export const ANNOUNCE_AGAIN_MS = 100;

/**
 * The text of a live region (role="status") that is read out on every announcement, the same
 * message twice included: a repeat is first cleared, then set again a moment later, so the region
 * changes each time. Render the region always, before the first message, and only change its
 * text: screen readers often skip a region inserted together with its text.
 */
export function useAnnouncement(): [string, (message: string) => void] {
  const [text, setText] = useState("");
  const shown = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const announce = useCallback((message: string) => {
    clearTimeout(timer.current);
    if (message && message === shown.current) {
      setText("");
      timer.current = setTimeout(() => setText(message), ANNOUNCE_AGAIN_MS);
    } else setText(message);
    shown.current = message;
  }, []);
  return [text, announce];
}
