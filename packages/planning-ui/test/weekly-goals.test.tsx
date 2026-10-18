import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createPrototype } from "./fixture";
import { App } from "../src/App";
import { BetNotSaved } from "../src/bets";
import { WeeklyGoals } from "../src/WeeklyGoals";
import type { Language, PlusActions } from "../src/model";

// The fixture's week starts 2026-10-12: its Work Bet is saved (etag 2), its Personal Bet is empty,
// and last week's Personal Bet was "A quiet, unhurried weekend".
const WORK = "Get the website refresh ready for review";
const LAST_PERSONAL = "A quiet, unhurried weekend";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderPlan(
  actions: PlusActions = createPrototype(),
  language: Language = "en",
) {
  const view = render(
    <App
      actions={actions}
      view="plan"
      language={language}
      onOpenTask={() => {}}
      onSettings={() => {}}
    />,
  );
  const region = await screen.findByRole("region", {
    name: language === "zh" ? "本周目标" : "Weekly goals",
  });
  return { view, goals: within(region) };
}
async function edit(goals: ReturnType<typeof within>, name: string | RegExp) {
  fireEvent.click(goals.getByRole("button", { name }));
  return goals.getByRole("textbox");
}

it("shows each area's line of text in place, and an empty one last week's with Keep", async () => {
  const { goals } = await renderPlan();
  expect(goals.getByRole("heading", { name: "Work" })).toBeTruthy();
  const work = goals.getByRole("button", { name: `Edit work goal: ${WORK}` });
  expect(work.textContent).toBe(WORK);
  expect(
    goals.getByRole("button", { name: "Write this week's personal goal" }),
  ).toBeTruthy();
  const previous = goals.getByText(`Last week: ${LAST_PERSONAL}`);
  expect(previous.getAttribute("title")).toBe(LAST_PERSONAL);
  expect(
    goals.getByRole("button", {
      name: `Keep last week's personal goal: ${LAST_PERSONAL}`,
    }).textContent,
  ).toBe("Keep");
  // No task picker, no marks, no warnings: a Bet is the owner's text alone.
  expect(goals.queryByRole("dialog")).toBeNull();
  expect(goals.queryByText(/Unassigned|More than one/u)).toBeNull();
});

it("saves the edited line on Enter, once and from the etag shown, and returns focus to it", async () => {
  const actions = createPrototype();
  const save = vi.spyOn(actions, "setWeeklyBet");
  const { goals } = await renderPlan(actions);
  const input = await edit(goals, `Edit work goal: ${WORK}`);
  expect(input.getAttribute("aria-label")).toBe("This week's work goal");
  expect(input.getAttribute("maxlength")).toBe("160");
  expect(document.activeElement).toBe(input);
  expect((input as HTMLInputElement).selectionStart).toBe(WORK.length);
  expect(goals.getByText("Enter to save · Esc to cancel")).toBeTruthy();
  fireEvent.change(input, {
    target: { value: "  Send the refresh\tto review " },
  });
  fireEvent.keyDown(input, { key: "Enter" });
  const saved = await goals.findByRole("button", {
    name: "Edit work goal: Send the refresh to review",
  });
  await waitFor(() => expect(document.activeElement).toBe(saved));
  expect(save.mock.calls).toEqual([
    [
      {
        weekStart: "2026-10-12",
        area: "work",
        text: "Send the refresh to review",
        etag: "2",
      },
    ],
  ]);
  expect(goals.getByRole("status").textContent).toBe("Work goal saved");
});

it("reads a second save out again, though its message is the same", async () => {
  const { goals } = await renderPlan();
  const status = () => goals.getByRole("status").textContent;
  let input = await edit(goals, `Edit work goal: ${WORK}`);
  fireEvent.change(input, { target: { value: "First synthetic goal" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await goals.findByRole("button", {
    name: "Edit work goal: First synthetic goal",
  });
  expect(status()).toBe("Work goal saved");
  input = await edit(goals, "Edit work goal: First synthetic goal");
  fireEvent.change(input, { target: { value: "Second synthetic goal" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await goals.findByRole("button", {
    name: "Edit work goal: Second synthetic goal",
  });
  // Cleared, then set again: the region changes, so it is read out a second time.
  expect(status()).toBe("");
  await waitFor(() => expect(status()).toBe("Work goal saved"));
});

it("writes nothing for an input method's Enter, an unchanged line or Esc", async () => {
  const actions = createPrototype();
  const save = vi.spyOn(actions, "setWeeklyBet");
  const { goals } = await renderPlan(actions);
  const input = await edit(goals, `Edit work goal: ${WORK}`);
  fireEvent.change(input, { target: { value: "周末" } });
  // Enter while composing Chinese confirms the composition, not the goal.
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  expect(goals.getByRole("textbox")).toBe(input);
  fireEvent.keyDown(input, { key: "Escape" });
  const restored = goals.getByRole("button", {
    name: `Edit work goal: ${WORK}`,
  });
  await waitFor(() => expect(document.activeElement).toBe(restored));
  // Opened and left as it was: closed without a write.
  const again = await edit(goals, `Edit work goal: ${WORK}`);
  fireEvent.keyDown(again, { key: "Enter" });
  expect(goals.queryByRole("textbox")).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it("saves a changed line when focus moves elsewhere in the page, but not for another window or an empty line", async () => {
  const actions = createPrototype();
  const save = vi.spyOn(actions, "setWeeklyBet");
  const focused = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const { goals } = await renderPlan(actions);
  const input = await edit(goals, `Edit work goal: ${WORK}`);
  fireEvent.change(input, { target: { value: "A draft for later" } });
  // Switching to another window or app: the draft stays open, unsaved.
  fireEvent.blur(input);
  expect(goals.getByRole("textbox")).toHaveProperty(
    "value",
    "A draft for later",
  );
  // Leaving it empty within the page restores the saved line; it never clears.
  focused.mockReturnValue(true);
  fireEvent.change(input, { target: { value: "   " } });
  fireEvent.blur(input);
  expect(
    goals.getByRole("button", { name: `Edit work goal: ${WORK}` }),
  ).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  // A changed line is saved when focus moves on, which is not pulled back.
  const next = await edit(goals, `Edit work goal: ${WORK}`);
  fireEvent.change(next, { target: { value: "Saved on the way out" } });
  const personal = goals.getByRole("button", {
    name: "Write this week's personal goal",
  });
  act(() => personal.focus());
  await goals.findByRole("button", {
    name: "Edit work goal: Saved on the way out",
  });
  expect(save).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(personal);
});

it("clears the Bet only on Enter in an empty line", async () => {
  const actions = createPrototype();
  const save = vi.spyOn(actions, "setWeeklyBet");
  const { goals } = await renderPlan(actions);
  const input = await edit(goals, `Edit work goal: ${WORK}`);
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.keyDown(input, { key: "Enter" });
  const empty = await goals.findByRole("button", {
    name: "Write this week's work goal",
  });
  await waitFor(() => expect(document.activeElement).toBe(empty));
  expect(save.mock.calls[0]![0]).toMatchObject({ text: "", etag: "2" });
  expect(goals.getByRole("status").textContent).toBe("Work goal cleared");
  // Last week had no Work Bet, so there is nothing to keep.
  expect(
    goals.queryByRole("button", { name: /Keep last week's work/u }),
  ).toBeNull();
});

it("keeps last week's text as this week's on Keep, and focuses the saved line", async () => {
  const actions = createPrototype();
  const save = vi.spyOn(actions, "setWeeklyBet");
  const { goals } = await renderPlan(actions);
  fireEvent.click(
    goals.getByRole("button", {
      name: `Keep last week's personal goal: ${LAST_PERSONAL}`,
    }),
  );
  const kept = await goals.findByRole("button", {
    name: `Edit personal goal: ${LAST_PERSONAL}`,
  });
  await waitFor(() => expect(document.activeElement).toBe(kept));
  expect(save.mock.calls).toEqual([
    [
      {
        weekStart: "2026-10-12",
        area: "personal",
        text: LAST_PERSONAL,
        etag: "",
      },
    ],
  ]);
  expect(goals.queryByText(/^Last week:/u)).toBeNull();
  expect(goals.getByRole("status").textContent).toBe(
    "Kept last week's personal goal",
  );
});

it("keeps the draft when the Bet changed elsewhere: Enter then replaces the latest, Esc shows it", async () => {
  const actions = createPrototype();
  const save = vi.spyOn(actions, "setWeeklyBet");
  const { goals } = await renderPlan(actions);
  // Another tab saves the Work Bet after this page read it.
  await actions.setWeeklyBet({
    weekStart: "2026-10-12",
    area: "work",
    text: "Saved in another tab",
    etag: "2",
  });
  save.mockClear();
  const input = await edit(goals, `Edit work goal: ${WORK}`);
  fireEvent.change(input, { target: { value: "My version" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect((await goals.findByRole("alert")).textContent).toBe(
    "This goal was changed elsewhere. Press Enter again to replace it with your text, or Esc to see the latest.",
  );
  expect(goals.getByRole("textbox")).toHaveProperty("value", "My version");
  // No other banner: the line says what happened.
  expect(screen.queryByText(/Couldn’t save/u)).toBeNull();
  fireEvent.keyDown(goals.getByRole("textbox"), { key: "Escape" });
  expect(
    goals.getByRole("button", { name: "Edit work goal: Saved in another tab" }),
  ).toBeTruthy();
  // Seen now: the second attempt replaces the latest, from its etag.
  const retry = await edit(goals, "Edit work goal: Saved in another tab");
  fireEvent.change(retry, { target: { value: "My version" } });
  fireEvent.keyDown(retry, { key: "Enter" });
  await goals.findByRole("button", { name: "Edit work goal: My version" });
  expect(save.mock.calls.map(([bet]) => bet.etag)).toEqual(["2", "3"]);
});

it("replaces the latest on a second Enter after a refusal", async () => {
  const actions = createPrototype();
  const { goals } = await renderPlan(actions);
  await actions.setWeeklyBet({
    weekStart: "2026-10-12",
    area: "work",
    text: "Saved in another tab",
    etag: "2",
  });
  const input = await edit(goals, `Edit work goal: ${WORK}`);
  fireEvent.change(input, { target: { value: "Mine wins" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await goals.findByRole("alert");
  // A blur after the refusal decides nothing; only Enter or Esc does.
  fireEvent.blur(goals.getByRole("textbox"));
  expect(goals.getByRole("textbox")).toHaveProperty("value", "Mine wins");
  fireEvent.keyDown(goals.getByRole("textbox"), { key: "Enter" });
  await goals.findByRole("button", { name: "Edit work goal: Mine wins" });
});

it("keeps the draft when the week has ended, or a save fails, with what happened", async () => {
  const actions = createPrototype();
  const save = vi
    .spyOn(actions, "setWeeklyBet")
    .mockRejectedValueOnce(new BetNotSaved("ended"))
    .mockRejectedValueOnce(new Error("Synthetic save unavailable"));
  const { goals } = await renderPlan(actions);
  const input = await edit(goals, `Edit work goal: ${WORK}`);
  fireEvent.change(input, { target: { value: "Too late" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect((await goals.findByRole("alert")).textContent).toBe(
    "That week has ended, so this wasn't saved.",
  );
  // Enter cannot save it any more; Esc closes it.
  fireEvent.keyDown(goals.getByRole("textbox"), { key: "Enter" });
  expect(save).toHaveBeenCalledOnce();
  fireEvent.keyDown(goals.getByRole("textbox"), { key: "Escape" });
  await waitFor(() => expect(goals.queryByRole("textbox")).toBeNull());
  // A failed save keeps the draft in the input and shows the banner.
  const second = await edit(goals, `Edit work goal: ${WORK}`);
  fireEvent.change(second, { target: { value: "Not confirmed" } });
  fireEvent.keyDown(second, { key: "Enter" });
  expect(await screen.findByText(/Synthetic save unavailable/u)).toBeTruthy();
  expect(goals.getByRole("textbox")).toHaveProperty("value", "Not confirmed");
});

it("counts the characters left near the limit and stays read-only while saving", async () => {
  const actions = createPrototype();
  let finish!: () => void;
  const real = actions.setWeeklyBet.bind(actions);
  vi.spyOn(actions, "setWeeklyBet").mockImplementation(async (bet) => {
    await new Promise<void>((resolve) => (finish = resolve));
    return real(bet);
  });
  const { goals } = await renderPlan(actions);
  const input = await edit(goals, `Edit work goal: ${WORK}`);
  fireEvent.change(input, { target: { value: "a".repeat(140) } });
  expect(
    goals.getByText("Enter to save · Esc to cancel · 20 characters left"),
  ).toBeTruthy();
  fireEvent.change(input, { target: { value: "a".repeat(159) } });
  expect(goals.getByText(/· 1 character left$/u)).toBeTruthy();
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(input).toHaveProperty("readOnly", true));
  expect(goals.getByRole("img", { name: "Updating…" })).toBeTruthy();
  // Esc waits for the answer; the write is not abandoned.
  fireEvent.keyDown(input, { key: "Escape" });
  expect(goals.getByRole("textbox")).toBe(input);
  await act(async () => finish());
  await goals.findByRole("button", {
    name: `Edit work goal: ${"a".repeat(159)}`,
  });
});

it("drops an open draft without a write when Plus is mounted again", async () => {
  const actions = createPrototype();
  const save = vi.spyOn(actions, "setWeeklyBet");
  const { goals, view } = await renderPlan(actions);
  const input = await edit(goals, `Edit work goal: ${WORK}`);
  fireEvent.change(input, { target: { value: "Unsaved draft" } });
  view.unmount();
  const again = await renderPlan(actions);
  expect(
    again.goals.getByRole("button", { name: `Edit work goal: ${WORK}` }),
  ).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
});

it("waits for other writes before an edit or Keep starts, without taking focus away", async () => {
  const actions = createPrototype();
  const save = vi.spyOn(actions, "setWeeklyBet");
  const { plan } = await actions.load();
  render(
    <WeeklyGoals
      plan={plan}
      language="en"
      busy
      run={async () => true}
      actions={actions}
    />,
  );
  const text = screen.getByRole("button", { name: `Edit work goal: ${WORK}` });
  const keep = screen.getByRole("button", {
    name: /^Keep last week's personal goal/u,
  });
  for (const button of [text, keep]) {
    expect(button.getAttribute("aria-disabled")).toBe("true");
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
  }
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it("speaks Chinese in the owner's words", async () => {
  const { goals } = await renderPlan(createPrototype(), "zh");
  expect(goals.getByRole("heading", { name: "工作" })).toBeTruthy();
  expect(
    goals.getByRole("button", { name: "写下这周的生活目标" }),
  ).toBeTruthy();
  expect(goals.getByText(`上周：${LAST_PERSONAL}`)).toBeTruthy();
  expect(
    goals.getByRole("button", { name: `沿用上周的生活目标：${LAST_PERSONAL}` })
      .textContent,
  ).toBe("沿用");
  const input = await edit(goals, `编辑工作目标：${WORK}`);
  expect(input.getAttribute("aria-label")).toBe("本周工作目标");
  expect(input.getAttribute("placeholder")).toBe("这周最想推进的一件事");
  fireEvent.change(input, { target: { value: "写".repeat(145) } });
  expect(goals.getByText("回车保存 · Esc 取消 · 还可输入 15 字")).toBeTruthy();
});
