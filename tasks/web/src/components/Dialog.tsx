import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function Dialog({
  title,
  onClose,
  children,
  className = "",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    // Closing returns focus to whatever opened the dialog, so the keyboard keeps its place.
    const opener = document.activeElement;
    ref.current?.showModal();
    const dialog = ref.current;
    dialog?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${className}`}
      aria-label={title}
      onCancel={onClose}
      onKeyDownCapture={(event) => {
        // Escape dismisses the popup first, without cancelling its native parent dialog.
        if (
          event.key === "Escape" &&
          !event.nativeEvent.isComposing &&
          event.currentTarget.querySelector("[data-popup-open]")
        )
          event.preventDefault();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="dialog-content">
        <header className="dialog-header">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
