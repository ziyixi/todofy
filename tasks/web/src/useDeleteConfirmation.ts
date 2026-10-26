import { useEffect, useRef, type KeyboardEvent } from "react";

/** Keep confirmation keys on its buttons; Enter uses the focused button's native activation. */
export function useDeleteConfirmation(
  open: boolean,
  busy: boolean,
  onCancel: () => void,
) {
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement;
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus();
    };
  }, [open]);
  useEffect(() => {
    if (open && !busy) confirmButton.current?.focus();
  }, [open, busy]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Enter") {
      event.stopPropagation();
      if (event.repeat || event.nativeEvent.isComposing) event.preventDefault();
    } else if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  }
  return { confirmButton, onKeyDown };
}
