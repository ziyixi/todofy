import {
  KeyboardSensor,
  PointerActivationConstraints,
  PointerSensor,
  type PointerSensorOptions,
} from "@dnd-kit/dom";
import { expect, it } from "vitest";
import { planningSensors } from "../src/row-drag";

const [pointer, keyboard] = planningSensors as [
  { plugin: unknown; options: PointerSensorOptions },
  unknown,
];
/** What a press on `target` would be for the pointer sensor. */
const press = (target: EventTarget, pointerType = "mouse") =>
  ({ target, pointerType }) as unknown as PointerEvent;

it("lets a card's own surfaces start its drag, never its other controls", () => {
  document.body.innerHTML = `
    <article class="planning-tray-step">
      <button class="planning-drag-handle"><svg></svg></button>
      <button class="planning-step-title"><span class="planning-full-title"><span>Draft API</span></span><small>30m</small></button>
      <button class="planning-complete"><svg></svg></button>
      <span class="planning-tray-gap"></span>
      <div data-no-drag><button class="planning-step-title">Inside a popover</button><input /></div>
    </article>`;
  const card = document.querySelector("article")!;
  const prevent = (selector: string) =>
    pointer.options.preventActivation!(
      press(card.querySelector(selector)!),
      {} as never,
    );
  expect(pointer.plugin).toBe(PointerSensor);
  expect(keyboard).toBe(KeyboardSensor);
  // The row, its grip and its title (with anything inside them) start a drag.
  expect(prevent(".planning-tray-gap")).toBe(false);
  expect(prevent(".planning-drag-handle svg")).toBe(false);
  expect(prevent(".planning-full-title span")).toBe(false);
  expect(prevent("small")).toBe(false);
  // Complete never does, nor anything marked data-no-drag, a title button included.
  expect(prevent(".planning-complete svg")).toBe(true);
  expect(prevent("[data-no-drag] .planning-step-title")).toBe(true);
  expect(prevent("input")).toBe(true);
  // The whole row is the activator, not only the grip.
  const element = document.createElement("div");
  const activators = pointer.options.activatorElements as (
    source: unknown,
  ) => Element[];
  expect(activators({ element, handle: card })).toEqual([element]);
});

it("starts a mouse drag after 6px and a touch drag after a 250ms hold", () => {
  const constraints = (pointerType: string) => {
    const [constraint] = (
      pointer.options.activationConstraints as unknown as (
        event: PointerEvent,
        source: never,
      ) => { options: unknown }[]
    )(press(document.body, pointerType), {} as never);
    return constraint;
  };
  expect(constraints("mouse")).toBeInstanceOf(
    PointerActivationConstraints.Distance,
  );
  expect(constraints("mouse")!.options).toEqual({ value: 6 });
  expect(constraints("pen")!.options).toEqual({ value: 6 });
  expect(constraints("touch")).toBeInstanceOf(
    PointerActivationConstraints.Delay,
  );
  expect(constraints("touch")!.options).toEqual({ value: 250, tolerance: 5 });
});
