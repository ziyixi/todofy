import type { SyntheticEvent } from "react";

/**
 * A title that CSS cuts to one line or a clamp, with its full text in a bubble under it. The bubble
 * shows on hover or keyboard focus of the button that holds the title, and only once `markCut`
 * found the text cut. Spans only, since it sits inside buttons. The bubble is aria-hidden: the
 * button's name is already the whole title, however the text is cut.
 */
export function FullTitle({ text }: { text: string }) {
  return (
    <span className="planning-full-title">
      <span className="planning-full-title-text">{text}</span>
      <span className="planning-full-title-bubble" aria-hidden="true">
        {text}
      </span>
    </span>
  );
}

/**
 * The host button's `onPointerEnter` and `onFocus`: marks its title cut when the text overflows its
 * line or clamp, and clears the mark otherwise. It measures when a bubble could show, so a changed
 * text or width is always measured again; nothing observes the title in between.
 */
export function markCut(event: SyntheticEvent<HTMLElement>) {
  const text = event.currentTarget.querySelector<HTMLElement>(
    ".planning-full-title-text",
  );
  const title = text?.parentElement;
  if (!text || !title) return;
  title.toggleAttribute(
    "data-cut",
    text.scrollWidth > text.clientWidth ||
      text.scrollHeight > text.clientHeight + 1,
  );
}
