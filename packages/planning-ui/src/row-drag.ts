import {
  KeyboardSensor,
  PointerActivationConstraints,
  PointerSensor,
} from "@dnd-kit/dom";

/** The controls inside a card that are the card itself: a press on them may start its drag. */
const SURFACES =
  ".planning-outcome-card, .planning-step-title, .planning-quick-title, .plus-focus-title, .review-drag-handle, .planning-drag-handle, .plus-focus-grip";

/**
 * Every planning DragDropProvider's sensors, as the main task list has them (Tasks'
 * `TaskDrag.tsx`): a card drags by its whole row once the pointer moves 6px, or after a 250ms
 * hold on touch, so a click or double-click never starts a drag and a swipe still scrolls. Its
 * other controls (complete, Start, remove) and anything marked `data-no-drag` never start one.
 * The keyboard still picks a card up from its grip.
 */
export const planningSensors = [
  PointerSensor.configure({
    activatorElements: (source) => [source.element],
    activationConstraints: (event) =>
      event.pointerType === "touch"
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 6 })],
    preventActivation: (event) => {
      if (!(event.target instanceof Element)) return false;
      if (event.target.closest("[data-no-drag]")) return true;
      const control = event.target.closest(
        "button, input, textarea, select, a[href], [contenteditable=true]",
      );
      return Boolean(control) && !control!.matches(SURFACES);
    },
  }),
  KeyboardSensor,
];
