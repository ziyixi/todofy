import type { SyntheticEvent } from "react";

/** The bubble's widest, as planner.css sets it, and the margin it keeps from the window's edge. */
const BUBBLE_WIDTH = 320;
const EDGE = 16;

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
 * text or width is always measured again; nothing observes the title in between. A title too near
 * the window's right edge for the widest bubble is marked `end`: its bubble opens leftwards from
 * the title's end, so it never leaves the window or makes the page scroll sideways.
 */
export function markCut(event: SyntheticEvent<HTMLElement>) {
  const text = event.currentTarget.querySelector<HTMLElement>(
    ".planning-full-title-text",
  );
  const title = text?.parentElement;
  if (!text || !title) return;
  if (
    text.scrollWidth <= text.clientWidth &&
    text.scrollHeight <= text.clientHeight + 1
  )
    return title.removeAttribute("data-cut");
  const room =
    title.ownerDocument.documentElement.clientWidth -
    title.getBoundingClientRect().left;
  title.setAttribute("data-cut", room < BUBBLE_WIDTH + EDGE ? "end" : "");
}
