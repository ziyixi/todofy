import { Accessibility, defaultPreset } from "@dnd-kit/dom";
import { expect, it } from "vitest";
import {
  dragHandle,
  dragInstructions,
  spokenDrags,
  type SpokenName,
} from "../src/drag-announcements";

type Options = NonNullable<ConstructorParameters<typeof Accessibility>[1]>;
type Event = Record<string, unknown>;
/** The Accessibility plugin's options, as spokenDrags configures it. */
function spoken(language: "en" | "zh", name: SpokenName) {
  const plugins = spokenDrags(language, name) as unknown[];
  const descriptor = plugins.find(
    (plugin): plugin is { plugin: unknown; options: Options } =>
      typeof plugin === "object" &&
      plugin !== null &&
      "plugin" in plugin &&
      plugin.plugin === Accessibility,
  )!;
  // Every other default plugin stays, in its place.
  expect(plugins).toHaveLength(defaultPreset.plugins.length);
  expect(plugins.indexOf(descriptor)).toBe(
    defaultPreset.plugins.indexOf(Accessibility),
  );
  const { announcements, screenReaderInstructions } = descriptor.options;
  const say =
    (kind: keyof NonNullable<Options["announcements"]>) => (event: Event) =>
      (announcements![kind] as (event: Event, manager: unknown) => unknown)(
        event,
        undefined,
      );
  return { say, instructions: screenReaderInstructions!.draggable };
}
// A card dragged from Committed over the Week lane's second card.
const source = {
  id: "review-outcome:synthetic-1",
  data: { title: "Book the venue" },
};
const target = {
  id: "review-outcome:synthetic-2",
  data: { lane: "Week", position: 1 },
};
const name: SpokenName = (data, as) =>
  as === "source"
    ? (data?.title as string | undefined)
    : data
      ? `${String(data.lane)} ${Number(data.position) + 1}`
      : undefined;

it("speaks a drag in the page's language from titles and places", () => {
  for (const [language, texts] of [
    [
      "en",
      [
        "Picked up: Book the venue. Arrow keys move it, Space or Enter drops it, Escape cancels.",
        "Over: Week 2",
        "Not over a drop target",
        "Dropped: Book the venue",
        "Cancelled: Book the venue is back in place",
      ],
    ],
    [
      "zh",
      [
        "已拿起：Book the venue。方向键移动，空格或回车放下，Esc 取消。",
        "移到：Week 2",
        "不在可放下的位置",
        "已放下：Book the venue",
        "已取消，Book the venue回到原处",
      ],
    ],
  ] as const) {
    const { say, instructions } = spoken(language, name);
    expect([
      say("dragstart")({ operation: { source } }),
      say("dragover")({ operation: { source, target } }),
      say("dragover")({ operation: { source, target: null } }),
      say("dragend")({ operation: { source, target }, canceled: false }),
      say("dragend")({ operation: { source, target }, canceled: true }),
    ]).toEqual(texts);
    expect(instructions).toMatch(language === "zh" ? /空格或回车/u : /Space/u);
  }
});

it("gives a handle the instructions its provider renders and a role in the page's language", () => {
  for (const language of ["en", "zh"] as const) {
    // The same words dnd-kit's own (unreachable) text has, so nothing differs but where.
    expect(dragInstructions(language)).toBe(
      spoken(language, name).instructions,
    );
    expect(dragHandle(language, "hint-1")).toEqual({
      "aria-describedby": "hint-1",
      "aria-roledescription": language === "zh" ? "可拖动" : "draggable",
    });
  }
});

it("never speaks an internal ID: an item without a name says nothing", () => {
  const { say } = spoken("en", () => undefined);
  const said = [
    say("dragstart")({ operation: { source } }),
    say("dragover")({ operation: { source, target } }),
    say("dragend")({ operation: { source, target }, canceled: false }),
    // Over its own place nothing changed.
    spoken("en", name).say("dragover")({
      operation: { source, target: source },
    }),
  ];
  expect(said).toEqual([undefined, undefined, undefined, undefined]);
  for (const text of spokenTexts())
    expect(text).not.toMatch(/review-outcome:|tray:|review-lane:|quick:/u);
});

/** Everything the named drag above says, in both languages. */
function spokenTexts() {
  return (["en", "zh"] as const).flatMap((language) => {
    const { say, instructions } = spoken(language, name);
    return [
      instructions,
      say("dragstart")({ operation: { source } }),
      say("dragover")({ operation: { source, target } }),
      say("dragend")({ operation: { source, target }, canceled: true }),
    ].map(String);
  });
}
