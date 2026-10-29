import { Accessibility, defaultPreset } from "@dnd-kit/dom";
import type { Language } from "./model";

type Announcements = NonNullable<
  NonNullable<ConstructorParameters<typeof Accessibility>[1]>["announcements"]
>;
/**
 * What a dragged item (`source`) or the place it is over (`target`) is called, from its drag data;
 * undefined says nothing.
 */
export type SpokenName = (
  data: Record<string, unknown> | undefined,
  as: "source" | "target",
) => string | undefined;

/** How to drag with the keyboard, in the page's language: every drag handle's description. */
export function dragInstructions(language: Language): string {
  return language === "zh"
    ? "按空格或回车拿起，方向键移动，空格或回车放下，Esc 取消。"
    : "Press Space or Enter to pick it up, the arrow keys to move it, Space or Enter to drop it, and Escape to cancel.";
}

/**
 * A drag handle's description and role description, in the page's language. dnd-kit's
 * Accessibility plugin adds both only to a handle without them, and its own cannot work here:
 * its description is in document.body, which an ID inside Plus's shadow root cannot name, and its
 * role description is English. `hintId` names the instructions the handle's provider renders.
 */
export function dragHandle(language: Language, hintId: string) {
  return {
    "aria-describedby": hintId,
    "aria-roledescription": language === "zh" ? "可拖动" : "draggable",
  };
}

/**
 * DragDropProvider's plugins, with dnd-kit's Accessibility plugin speaking the page's language:
 * titles, lane names and days, never internal IDs. The plugin reads them once, when its provider
 * starts, so another language needs a new provider: key it by the language.
 */
export function spokenDrags(
  language: Language,
  name: SpokenName,
): typeof defaultPreset.plugins {
  const zh = language === "zh";
  const announcements: Announcements = {
    dragstart({ operation }) {
      const source = name(operation.source?.data, "source");
      if (!source) return undefined;
      return zh
        ? `已拿起：${source}。方向键移动，空格或回车放下，Esc 取消。`
        : `Picked up: ${source}. Arrow keys move it, Space or Enter drops it, Escape cancels.`;
    },
    dragover({ operation: { source, target } }) {
      if (!source || source.id === target?.id) return undefined;
      if (!target) return zh ? "不在可放下的位置" : "Not over a drop target";
      const over = name(target.data, "target");
      if (!over) return undefined;
      return zh ? `移到：${over}` : `Over: ${over}`;
    },
    dragend({ operation, canceled }) {
      const source = name(operation.source?.data, "source");
      if (!source) return undefined;
      if (canceled)
        return zh
          ? `已取消，${source}回到原处`
          : `Cancelled: ${source} is back in place`;
      return zh ? `已放下：${source}` : `Dropped: ${source}`;
    },
  };
  const screenReaderInstructions = { draggable: dragInstructions(language) };
  return defaultPreset.plugins.map((plugin) =>
    plugin === Accessibility
      ? {
          plugin: Accessibility,
          options: { announcements, screenReaderInstructions },
        }
      : plugin,
  );
}
