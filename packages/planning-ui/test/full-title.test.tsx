import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FullTitle, markCut } from "../src/FullTitle";

afterEach(cleanup);

/** jsdom lays nothing out: each test says how big the title's text is and where it fits. */
function measure(
  text: HTMLElement,
  size: {
    scrollWidth: number;
    clientWidth: number;
    scrollHeight: number;
    clientHeight: number;
  },
) {
  for (const [name, value] of Object.entries(size))
    Object.defineProperty(text, name, { configurable: true, value });
}
function host(title: string) {
  return render(
    <button onPointerEnter={markCut} onFocus={markCut}>
      <FullTitle text={title} />
    </button>,
  );
}
const fits = {
  scrollWidth: 100,
  clientWidth: 100,
  scrollHeight: 20,
  clientHeight: 20,
};

it("renders the title and an aria-hidden bubble as spans, so the button's name is the title once", () => {
  host("Draft the API");
  const button = screen.getByRole("button", { name: "Draft the API" });
  const title = button.querySelector(".planning-full-title")!;
  expect(title.tagName).toBe("SPAN");
  const text = title.querySelector(".planning-full-title-text")!;
  const bubble = title.querySelector(".planning-full-title-bubble")!;
  expect(text.tagName).toBe("SPAN");
  expect(text.textContent).toBe("Draft the API");
  expect(bubble.tagName).toBe("SPAN");
  expect(bubble.getAttribute("aria-hidden")).toBe("true");
  expect(bubble.textContent).toBe("Draft the API");
  expect(title.hasAttribute("data-cut")).toBe(false);
});

it("marks a title cut on pointer enter or focus when its text is wider or taller than its box, and clears it when it fits", () => {
  host("A long title that does not fit");
  const button = screen.getByRole("button");
  const title = button.querySelector(".planning-full-title")!;
  const text = button.querySelector<HTMLElement>(".planning-full-title-text")!;
  measure(text, { ...fits, scrollWidth: 240 });
  fireEvent.pointerEnter(button);
  expect(title.hasAttribute("data-cut")).toBe(true);
  measure(text, fits);
  fireEvent.focus(button);
  expect(title.hasAttribute("data-cut")).toBe(false);
  // A clamp cuts by height; one pixel of rounding is not a cut.
  measure(text, { ...fits, scrollHeight: 21 });
  fireEvent.focus(button);
  expect(title.hasAttribute("data-cut")).toBe(false);
  measure(text, { ...fits, scrollHeight: 40 });
  fireEvent.pointerEnter(button);
  expect(title.hasAttribute("data-cut")).toBe(true);
});

it("measures again when the text changes, so the mark follows the new text", () => {
  const view = host("A long title that does not fit");
  const button = screen.getByRole("button");
  const text = () =>
    button.querySelector<HTMLElement>(".planning-full-title-text")!;
  measure(text(), { ...fits, scrollWidth: 240 });
  fireEvent.pointerEnter(button);
  expect(
    button.querySelector(".planning-full-title")!.hasAttribute("data-cut"),
  ).toBe(true);
  view.rerender(
    <button onPointerEnter={markCut} onFocus={markCut}>
      <FullTitle text="Short" />
    </button>,
  );
  expect(text().textContent).toBe("Short");
  measure(text(), fits);
  fireEvent.pointerEnter(button);
  expect(
    button.querySelector(".planning-full-title")!.hasAttribute("data-cut"),
  ).toBe(false);
});

it("opens the bubble leftwards from a title too near the window's right edge", () => {
  host("A long title near the right edge");
  const button = screen.getByRole("button");
  const title = button.querySelector<HTMLElement>(".planning-full-title")!;
  const text = button.querySelector<HTMLElement>(".planning-full-title-text")!;
  measure(text, { ...fits, scrollWidth: 240 });
  Object.defineProperty(document.documentElement, "clientWidth", {
    configurable: true,
    value: 1440,
  });
  const at = (left: number) =>
    vi
      .spyOn(title, "getBoundingClientRect")
      .mockReturnValue(DOMRect.fromRect({ x: left, width: 150, height: 16 }));
  // Room for the widest bubble (320px) and the 16px margin: it opens rightwards.
  at(1104);
  fireEvent.pointerEnter(button);
  expect(title.getAttribute("data-cut")).toBe("");
  at(1105);
  fireEvent.focus(button);
  expect(title.getAttribute("data-cut")).toBe("end");
  Reflect.deleteProperty(document.documentElement, "clientWidth");
});
