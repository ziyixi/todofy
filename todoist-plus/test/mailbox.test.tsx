import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createPrototype } from "../design/fixture";
import { App } from "../src/App";
import type {
  Language,
  MailItem,
  PlanningTask,
  PlusActions,
} from "../src/model";

// The fixture's mail project holds two mail tasks (Mail Hero created both) and the weekly review
// task; today is Tue 2026-10-13 in Los Angeles.
const REGISTER = "Fwd: Conference registration opens";
const NOTES = "Re: Shared notes for Friday";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const mailTask = (id: string, fields: Partial<PlanningTask> = {}) => ({
  id,
  title: `Synthetic mail ${id}`,
  parentId: "",
  projectId: "synthetic-mail",
  labels: [],
  area: "unassigned" as const,
  stage: "none" as const,
  priority: 1,
  deadline: "",
  due: "",
  leadDays: 0,
  etag: `${id}-1`,
  mustStart: false,
  missingLead: false,
  ...fields,
});

/** The fixture with more tasks in its mail project, some of them mail Todofy knows. */
function withMail(
  tasks: PlanningTask[],
  items: MailItem[],
  actions: PlusActions = createPrototype(),
) {
  const load = actions.load.bind(actions);
  const lookup = actions.lookupMail.bind(actions);
  vi.spyOn(actions, "load").mockImplementation(async (week) => {
    const data = await load(week);
    const known = new Set(data.plan.tasks.map((task) => task.id));
    data.plan.tasks.push(...tasks.filter((task) => !known.has(task.id)));
    return data;
  });
  vi.spyOn(actions, "lookupMail").mockImplementation(async (ids) => {
    const answer = await lookup(ids);
    answer.items.push(...items.filter((item) => ids.includes(item.taskId)));
    return answer;
  });
  return actions;
}

async function renderMailbox(
  actions: PlusActions = createPrototype(),
  language: Language = "en",
) {
  render(
    <App
      actions={actions}
      view="mailbox"
      language={language}
      onOpenTask={() => {}}
      onSettings={() => {}}
    />,
  );
  const list = await screen.findByRole("list", {
    name: language === "zh" ? "邮件" : "Mail",
  });
  return within(list);
}
const rowButtons = () =>
  screen
    .getAllByRole("listitem")
    .map((item) => item.querySelector<HTMLButtonElement>(".plus-mailbox-row")!);

/** Saves one category, Work · P2, through the Mail categories dialog. */
async function setUpCategories() {
  fireEvent.click(screen.getByRole("button", { name: "Mail categories" }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "Mail categories" }),
  );
  fireEvent.click(
    await dialog.findByRole("button", { name: "Add a category" }),
  );
  fireEvent.change(dialog.getByRole("combobox", { name: "Label 1" }), {
    target: { value: "synthetic-office" },
  });
  fireEvent.change(dialog.getByRole("combobox", { name: "Priority 1" }), {
    target: { value: "2" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Save" }));
  // Saved, the dialog closes and the Mailbox's status line says so.
  await screen.findByText("Mail categories saved");
  expect(screen.queryByRole("dialog", { name: "Mail categories" })).toBeNull();
}
/** The Mailbox's one live region, there from the start. */
const statusLine = () =>
  document.querySelector<HTMLElement>(".plus-mailbox-status")!;

it("lists the mail to clarify newest first: title, brief and time, and the other tasks below", async () => {
  const actions = withMail([mailTask("own")], []);
  const list = await renderMailbox(actions);
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "Mail", level: 1 }),
  );
  expect(screen.getByText("2 emails")).toBeTruthy();
  const rows = rowButtons();
  expect(
    rows.map((row) => row.querySelector(".plus-mailbox-title")?.textContent),
  ).toEqual([REGISTER, NOTES]);
  expect(rows[0]!.getAttribute("aria-label")).toBe(
    `${REGISTER}, Registration is open; the early price ends Oct 20, 09:20`,
  );
  expect(rows[0]!.getAttribute("aria-describedby")).toBeTruthy();
  const times = screen
    .getAllByRole("listitem")
    .map((item) => item.querySelector("time")!);
  expect(times.map((time) => [time.textContent, time.title])).toEqual([
    ["09:20", "Tue, Oct 13, 09:20"],
    ["Yesterday", "Mon, Oct 12, 02:05"],
  ]);
  // The row's name says the time: the time itself is not read a second time.
  expect(
    times.every((time) => time.getAttribute("aria-hidden") === "true"),
  ).toBe(true);
  // The live region is there before any write, empty, so its first message is read out.
  expect(statusLine().getAttribute("role")).toBe("status");
  expect(statusLine().textContent).toBe("");
  // The owner's own task in the mail project is not mail: it shows only as a count.
  expect(list.queryByText("Synthetic mail own")).toBeNull();
  const footer = screen.getByText(/1 other task in the mail project/u);
  expect(
    within(footer)
      .getByRole("link", { name: "Open in Todoist" })
      .getAttribute("href"),
  ).toBe("https://app.todoist.com/app/project/synthetic-mail");
  // No badge, unread mark or sender: the brief is the only second line.
  expect(screen.queryByText(/unread|sender/iu)).toBeNull();
});

it("moves between rows with the arrows, j/k, Home and End, and lets Tab reach only the current row's filing buttons", async () => {
  const actions = withMail(
    [mailTask("third")],
    [
      {
        id: "event-third",
        taskId: "third",
        brief: "",
        receivedAt: "2026-10-01T10:00:00Z",
        hasSummary: false,
      },
    ],
  );
  await renderMailbox(actions);
  await setUpCategories();
  const rows = rowButtons();
  expect(rows.map((row) => row.tabIndex)).toEqual([0, -1, -1]);
  // After its row button, each row has its categories, then Inbox: Tab reaches them in that order.
  const files = () =>
    screen
      .getAllByRole("listitem")
      .map((item) =>
        [...item.querySelectorAll("button")].map((button) => [
          button.textContent,
          button.tabIndex,
        ]),
      );
  expect(files()).toEqual([
    [
      [rows[0]!.textContent, 0],
      ["Work · P2", 0],
      ["Inbox", 0],
    ],
    [
      [rows[1]!.textContent, -1],
      ["Work · P2", -1],
      ["Inbox", -1],
    ],
    [
      [rows[2]!.textContent, -1],
      ["Work · P2", -1],
      ["Inbox", -1],
    ],
  ]);
  rows[0]!.focus();
  fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(rows[1]);
  fireEvent.keyDown(rows[1]!, { key: "j" });
  expect(document.activeElement).toBe(rows[2]);
  fireEvent.keyDown(rows[2]!, { key: "k" });
  expect(document.activeElement).toBe(rows[1]);
  fireEvent.keyDown(rows[1]!, { key: "Home" });
  expect(document.activeElement).toBe(rows[0]);
  fireEvent.keyDown(rows[0]!, { key: "End" });
  expect(document.activeElement).toBe(rows[2]);
  await waitFor(() =>
    expect(rowButtons().map((row) => row.tabIndex)).toEqual([-1, -1, 0]),
  );
  expect(files().map((buttons) => buttons.map(([, tab]) => tab))).toEqual([
    [-1, -1, -1],
    [-1, -1, -1],
    [0, 0, 0],
  ]);
  // A row without a brief shows its title alone.
  expect(
    screen.getAllByRole("listitem")[2]!.querySelector(".plus-mailbox-brief"),
  ).toBeNull();
});

it("expands one row at a time to the full summary as plain text, and Esc folds it", async () => {
  const actions = createPrototype();
  const read = vi.spyOn(actions, "readMailSummary");
  await renderMailbox(actions);
  const [register, notes] = rowButtons();
  fireEvent.click(register!);
  const detail = within(await screen.findByRole("region", { name: REGISTER }));
  await detail.findByText("Registration is open; the early price ends Oct 20.");
  expect(register!.getAttribute("aria-expanded")).toBe("true");
  // Markdown marks go; list marks and line breaks stay, as text.
  expect(detail.getByText("Details")).toBeTruthy();
  expect(detail.getByText("- The early price is 30% lower")).toBeTruthy();
  expect(screen.queryByText("**Details**")).toBeNull();
  // The brief gives way to the summary, whose first line it is.
  expect(register!.querySelector(".plus-mailbox-brief")).toBeNull();
  expect(detail.getByText(/Received Tue, Oct 13, 09:20/u)).toBeTruthy();
  expect(
    detail.getByRole("link", { name: "Open in Todoist" }).getAttribute("href"),
  ).toBe("https://app.todoist.com/app/task/mail-register");
  fireEvent.click(notes!);
  await screen.findByRole("region", { name: NOTES });
  expect(screen.queryByRole("region", { name: REGISTER })).toBeNull();
  // Folded again, the row shows its brief again.
  expect(register!.querySelector(".plus-mailbox-brief")?.textContent).toBe(
    "Registration is open; the early price ends Oct 20.",
  );
  fireEvent.keyDown(notes!, { key: "Escape" });
  expect(screen.queryByRole("region", { name: NOTES })).toBeNull();
  // Read once each and kept for this visit.
  fireEvent.click(register!);
  await screen.findByRole("region", { name: REGISTER });
  expect(read.mock.calls).toEqual([["event-register"], ["event-notes"]]);
});

it("says when a summary is no longer available, keeping the brief and the Todoist link", async () => {
  const actions = createPrototype();
  vi.spyOn(actions, "readMailSummary").mockResolvedValue("");
  await renderMailbox(actions, "zh");
  fireEvent.click(rowButtons()[0]!);
  const detail = within(await screen.findByRole("region", { name: REGISTER }));
  await detail.findByText(/原始摘要已不可用。/u);
  expect(
    screen.getByText("Registration is open; the early price ends Oct 20."),
  ).toBeTruthy();
  expect(detail.getByRole("link", { name: "在 Todoist 中打开" })).toBeTruthy();
});

it("moves a mail into the Todoist Inbox at one click when no category is saved, and moves focus on", async () => {
  const actions = createPrototype();
  const fileMail = vi.spyOn(actions, "fileMail");
  await renderMailbox(actions, "zh");
  // No category: the row offers Inbox alone, and nothing asks for a setup first.
  const [item] = screen.getAllByRole("listitem");
  expect(
    within(item!)
      .getAllByRole("button")
      .slice(1)
      .map((button) => button.textContent),
  ).toEqual(["收件箱"]);
  expect(screen.queryByText(/设置归类/u)).toBeNull();
  fireEvent.click(
    within(item!).getByRole("button", {
      name: `移到 Todoist 收件箱：${REGISTER}`,
    }),
  );
  await waitFor(() =>
    expect(
      rowButtons().map(
        (row) => row.querySelector(".plus-mailbox-title")?.textContent,
      ),
    ).toEqual([NOTES]),
  );
  // No menu and no confirmation: one write, without a category.
  expect(screen.queryByRole("menu")).toBeNull();
  expect(fileMail.mock.calls).toEqual([
    [
      expect.objectContaining({ id: "mail-register", etag: "fixture" }),
      undefined,
      "mail-0",
      expect.any(String),
    ],
  ]);
  expect(statusLine().textContent).toBe(`已移到 Todoist 收件箱：${REGISTER}`);
  // Focus moved to the row now in its place.
  await waitFor(() => expect(document.activeElement).toBe(rowButtons()[0]));
});

it("files by a category at one click: its label and priority, then the move to the Inbox", async () => {
  const actions = createPrototype();
  const fileMail = vi.spyOn(actions, "fileMail");
  const load = vi.spyOn(actions, "load");
  await renderMailbox(actions);
  await setUpCategories();
  fireEvent.click(
    screen.getByRole("button", { name: `File as “Work · P2”: ${REGISTER}` }),
  );
  await waitFor(() => expect(rowButtons()).toHaveLength(1));
  expect(fileMail.mock.calls[0]!.slice(0, 3)).toEqual([
    expect.objectContaining({ id: "mail-register" }),
    expect.objectContaining({ labelId: "synthetic-office", priority: 2 }),
    expect.any(String),
  ]);
  expect(statusLine().textContent).toBe(`Filed as “Work · P2”: ${REGISTER}`);
  // As Todofy answers: labelled, P2, and in the account's Inbox.
  const filed = await fileMail.mock.results[0]!.value;
  expect(filed).toMatchObject({
    labels: ["office"],
    priority: 3,
    projectId: "synthetic-inbox",
  });
  // The filed task is merged as Todofy answered it; nothing is read again.
  expect(load).toHaveBeenCalledOnce();
});

it("offers the saved categories in order, at most four and none whose label is gone, then Inbox", async () => {
  const actions = createPrototype();
  const lookup = actions.lookupMail.bind(actions);
  vi.spyOn(actions, "lookupMail").mockImplementation(async (ids) => ({
    ...(await lookup(ids)),
    categories: [
      { id: "c1", labelId: "synthetic-home", priority: 1 },
      { id: "c2", labelId: "synthetic-gone", priority: 2 },
      { id: "c3", labelId: "synthetic-office", priority: 2 },
      { id: "c4", labelId: "synthetic-office", priority: 4 },
      { id: "c5", labelId: "synthetic-home", priority: 3 },
      { id: "c6", labelId: "synthetic-office", priority: 1 },
    ],
  }));
  await renderMailbox(actions, "zh");
  const actionsOf = (item: HTMLElement) =>
    [...item.querySelectorAll(".plus-mailbox-actions button")].map((button) => [
      button.textContent,
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
    ]);
  expect(actionsOf(screen.getAllByRole("listitem")[1]!)).toEqual([
    ["生活 · P1", `归入「生活 · P1」：${NOTES}`, `归入「生活 · P1」：${NOTES}`],
    ["工作 · P2", `归入「工作 · P2」：${NOTES}`, `归入「工作 · P2」：${NOTES}`],
    ["工作 · P4", `归入「工作 · P4」：${NOTES}`, `归入「工作 · P4」：${NOTES}`],
    ["生活 · P3", `归入「生活 · P3」：${NOTES}`, `归入「生活 · P3」：${NOTES}`],
    [
      "收件箱",
      `移到 Todoist 收件箱：${NOTES}`,
      `移到 Todoist 收件箱：${NOTES}`,
    ],
  ]);
});

it("keeps a long label's priority apart from it, so two of its categories never look alike", async () => {
  const actions = createPrototype();
  const load = actions.load.bind(actions);
  vi.spyOn(actions, "load").mockImplementation(async (week) => {
    const data = await load(week);
    data.plan.availableLabels.push({
      id: "synthetic-reading",
      label: "reading-list-for-the-weekend",
    });
    return data;
  });
  const lookup = actions.lookupMail.bind(actions);
  vi.spyOn(actions, "lookupMail").mockImplementation(async (ids) => ({
    ...(await lookup(ids)),
    categories: [
      { id: "c1", labelId: "synthetic-reading", priority: 4 },
      { id: "c2", labelId: "synthetic-reading", priority: 1 },
    ],
  }));
  await renderMailbox(actions);
  const buttons = [
    ...screen
      .getAllByRole("listitem")[0]!
      .querySelectorAll(".plus-mailbox-action"),
  ];
  // Only the label's part may end in an ellipsis; the priority is a part of its own after it.
  expect(
    buttons.map((button) =>
      [...button.children].map((part) => [part.className, part.textContent]),
    ),
  ).toEqual([
    [
      ["plus-mailbox-action-label", "reading-list-for-the-weekend"],
      ["plus-mailbox-action-priority", " · P4"],
    ],
    [
      ["plus-mailbox-action-label", "reading-list-for-the-weekend"],
      ["plus-mailbox-action-priority", " · P1"],
    ],
    [],
  ]);
  expect(buttons.map((button) => button.textContent)).toEqual([
    "reading-list-for-the-weekend · P4",
    "reading-list-for-the-weekend · P1",
    "Inbox",
  ]);
  expect(buttons[1]!.getAttribute("aria-label")).toBe(
    `File as “reading-list-for-the-weekend · P1”: ${REGISTER}`,
  );
});

it("edits the categories from the header alone: no destination, none at all is fine, and focus returns to the gear", async () => {
  const actions = createPrototype();
  const update = vi.spyOn(actions, "updateMailSettings");
  await renderMailbox(actions);
  await setUpCategories();
  const gear = screen.getByRole("button", { name: "Mail categories" });
  expect(document.activeElement).toBe(gear);
  // No row opens the dialog: a row's buttons only file.
  expect(screen.queryAllByRole("button", { name: /categor/iu }).length).toBe(1);
  fireEvent.click(gear);
  const dialog = within(
    await screen.findByRole("dialog", { name: "Mail categories" }),
  );
  await dialog.findByRole("button", {
    name: "Remove category: Work · P2",
  });
  expect(
    dialog.getByText(
      "Each category is one existing Todoist label and a priority. Filing adds them and moves the task to the Todoist Inbox.",
    ),
  ).toBeTruthy();
  // A label and a priority per category, and nothing else to choose.
  expect(
    dialog
      .getAllByRole("combobox")
      .map((box) => box.getAttribute("aria-label")),
  ).toEqual(["Label 1", "Priority 1"]);
  fireEvent.click(
    dialog.getByRole("button", { name: "Remove category: Work · P2" }),
  );
  fireEvent.click(dialog.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(update.mock.calls.at(-1)).toEqual([[], expect.any(String)]);
  // The same words as the first save, read out again.
  await waitFor(() =>
    expect(statusLine().textContent).toBe("Mail categories saved"),
  );
  expect(document.activeElement).toBe(gear);
  // Without categories each row offers Inbox alone.
  expect(
    within(screen.getAllByRole("listitem")[0]!)
      .getAllByRole("button")
      .slice(1)
      .map((button) => button.textContent),
  ).toEqual(["Inbox"]);
  // Closed without saving, focus goes back to the gear as well.
  fireEvent.click(gear);
  fireEvent.click(
    within(
      await screen.findByRole("dialog", { name: "Mail categories" }),
    ).getByRole("button", { name: "Close" }),
  );
  expect(document.activeElement).toBe(gear);
});

it("keeps a row whose filing was not confirmed, and resends the same request", async () => {
  const actions = createPrototype();
  const fileMail = vi
    .spyOn(actions, "fileMail")
    .mockRejectedValueOnce(new Error("Synthetic Todoist unavailable"));
  await renderMailbox(actions);
  await setUpCategories();
  const inbox = () =>
    screen.getByRole<HTMLButtonElement>("button", {
      name: `Move to Todoist Inbox: ${REGISTER}`,
    });
  fireEvent.click(inbox());
  await screen.findByText(/Synthetic Todoist unavailable/u);
  expect(rowButtons()).toHaveLength(2);
  expect(statusLine().textContent).not.toMatch(/Moved/u);
  await waitFor(() => expect(inbox().disabled).toBe(false));
  fireEvent.click(inbox());
  await waitFor(() => expect(rowButtons()).toHaveLength(1));
  expect(fileMail.mock.calls[1]![3]).toBe(fileMail.mock.calls[0]![3]);
  // A category is another request: filing the other mail by it asks under a new ID.
  fireEvent.click(
    screen.getByRole("button", { name: `File as “Work · P2”: ${NOTES}` }),
  );
  await waitFor(() => expect(fileMail).toHaveBeenCalledTimes(3));
  expect(fileMail.mock.calls[2]![3]).not.toBe(fileMail.mock.calls[0]![3]);
});

it("asks under a new request once the categories changed after a filing by one was not confirmed", async () => {
  const actions = createPrototype();
  const fileMail = vi
    .spyOn(actions, "fileMail")
    .mockRejectedValueOnce(new Error("Synthetic Todoist unavailable"));
  await renderMailbox(actions);
  await setUpCategories();
  const work = () =>
    screen.getByRole<HTMLButtonElement>("button", {
      name: `File as “Work · P2”: ${REGISTER}`,
    });
  fireEvent.click(work());
  await screen.findByText(/Synthetic Todoist unavailable/u);
  await waitFor(() => expect(work().disabled).toBe(false));
  // Another category saved: Work · P2 keeps its ID, and the categories a new etag.
  fireEvent.click(screen.getByRole("button", { name: "Mail categories" }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "Mail categories" }),
  );
  fireEvent.click(
    await dialog.findByRole("button", { name: "Add a category" }),
  );
  fireEvent.change(dialog.getByRole("combobox", { name: "Label 2" }), {
    target: { value: "synthetic-home" },
  });
  fireEvent.change(dialog.getByRole("combobox", { name: "Priority 2" }), {
    target: { value: "3" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(work());
  await waitFor(() => expect(rowButtons()).toHaveLength(1));
  const [first, second] = fileMail.mock.calls;
  expect(second![1]!.id).toBe(first![1]!.id);
  expect(second![2]).not.toBe(first![2]);
  // Todofy refuses another body under the first request's ID.
  expect(second![3]).not.toBe(first![3]);
});

it("deletes all the untouched mail listed, after a confirmation that names the count and keeps the rest", async () => {
  const actions = withMail(
    [mailTask("labelled", { labels: ["reading"] })],
    [
      {
        id: "event-labelled",
        taskId: "labelled",
        brief: "A labelled synthetic mail.",
        receivedAt: "2026-10-13T17:00:00Z",
        hasSummary: false,
      },
    ],
  );
  const deleteMail = vi.spyOn(actions, "deleteMail");
  await renderMailbox(actions);
  fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "Delete 2 emails?" }),
  );
  expect(
    dialog.getByText(
      "Their 2 tasks will be permanently deleted from Todoist. This can't be undone.",
    ),
  ).toBeTruthy();
  expect(
    dialog.getByText(
      "1 you've changed or planned is kept: Synthetic mail labelled.",
    ),
  ).toBeTruthy();
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  expect(document.activeElement).toBe(cancel);
  // Neutral buttons only: the words carry the weight.
  const confirm = dialog.getByRole("button", { name: "Delete 2" });
  expect(confirm.className).toBe("plus-button");
  fireEvent.click(cancel);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(deleteMail).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete 2" }));
  await screen.findByText("Deleted 2 emails");
  // The frozen batch, oldest first; the labelled one was never sent.
  expect(deleteMail.mock.calls).toEqual([
    [["mail-notes", "mail-register"], expect.any(String)],
  ]);
  expect(
    rowButtons().map(
      (row) => row.querySelector(".plus-mailbox-title")?.textContent,
    ),
  ).toEqual(["Synthetic mail labelled"]);
  // Nothing untouched is left to delete.
  expect(screen.queryByRole("button", { name: "Delete all" })).toBeNull();
});

it("keeps the confirmation open when the deletion is not confirmed, and tries again with the same request", async () => {
  const actions = createPrototype();
  const deleteMail = vi
    .spyOn(actions, "deleteMail")
    .mockRejectedValueOnce(new Error("Synthetic deletion unavailable"));
  await renderMailbox(actions, "zh");
  fireEvent.click(screen.getByRole("button", { name: "全部删除" }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "删除 2 封邮件？" }),
  );
  expect(
    dialog.getByText("Todoist 中这 2 个任务会被永久删除，无法撤销。"),
  ).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "删除 2 封" }));
  expect((await dialog.findByRole("alert")).textContent).toBe(
    "未确认删除完成。重试会接着删完剩下的，不会重复删除。",
  );
  fireEvent.click(dialog.getByRole("button", { name: "重试" }));
  await screen.findByText("已删除 2 封邮件");
  expect(deleteMail.mock.calls[1]).toEqual(deleteMail.mock.calls[0]);
  expect(screen.getByText("邮件都处理完了")).toBeTruthy();
});

it("says what Todofy kept on its own check after a deletion", async () => {
  const actions = createPrototype();
  vi.spyOn(actions, "deleteMail").mockResolvedValue({
    deletedTaskIds: ["mail-notes"],
    keptTaskIds: ["mail-register"],
  });
  await renderMailbox(actions);
  fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete 2" }));
  await screen.findByText("Deleted 1; 1 had changes and was kept");
  expect(rowButtons()).toHaveLength(1);
});

it("shows no list when the mail cannot be read, and says when Todofy has no mail project", async () => {
  const actions = createPrototype();
  vi.spyOn(actions, "lookupMail").mockRejectedValue(
    new Error("Synthetic outage"),
  );
  render(
    <App
      actions={actions}
      view="mailbox"
      language="en"
      onOpenTask={() => {}}
      onSettings={() => {}}
    />,
  );
  const alert = await screen.findByText("Couldn't read your mail.");
  expect(
    within(alert.parentElement!).getByRole("button", { name: "Refresh" }),
  ).toBeTruthy();
  expect(screen.queryByRole("list")).toBeNull();
  cleanup();

  const none = createPrototype();
  const load = none.load.bind(none);
  vi.spyOn(none, "load").mockImplementation(async (week) => {
    const data = await load(week);
    data.plan.inboxProjectId = "";
    return data;
  });
  const lookup = vi.spyOn(none, "lookupMail");
  render(
    <App
      actions={none}
      view="mailbox"
      language="zh"
      onOpenTask={() => {}}
      onSettings={() => {}}
    />,
  );
  await screen.findByText("Todofy 没有设置邮件项目");
  expect(lookup).not.toHaveBeenCalled();
});

it("keeps the last result in the status line while the next filing waits, then replaces it", async () => {
  const actions = createPrototype();
  await renderMailbox(actions);
  await setUpCategories();
  const file = (title: string) =>
    screen.getByRole<HTMLButtonElement>("button", {
      name: `File as “Work · P2”: ${title}`,
    });
  fireEvent.click(file(REGISTER));
  await waitFor(() =>
    expect(statusLine().textContent).toBe(`Filed as “Work · P2”: ${REGISTER}`),
  );
  const real = actions.fileMail.bind(actions);
  let release = () => {};
  vi.spyOn(actions, "fileMail").mockImplementationOnce(async (...args) => {
    await new Promise<void>((resolve) => (release = resolve));
    return real(...args);
  });
  await waitFor(() => expect(file(NOTES).disabled).toBe(false));
  fireEvent.click(file(NOTES));
  await waitFor(() =>
    expect(
      document.querySelector(".plus-mailbox-item.is-pending"),
    ).toBeTruthy(),
  );
  // The line is neither cleared nor removed while the write waits: nothing above the list moves.
  expect(statusLine().textContent).toBe(`Filed as “Work · P2”: ${REGISTER}`);
  release();
  await waitFor(() =>
    expect(statusLine().textContent).toBe(`Filed as “Work · P2”: ${NOTES}`),
  );
});

/** The prototype with one mail changed, as a re-read shows it once `changed()` says so. */
function changing(
  change: (data: Awaited<ReturnType<PlusActions["load"]>>) => void,
) {
  const actions = createPrototype();
  const load = actions.load.bind(actions);
  const state = { on: false };
  vi.spyOn(actions, "load").mockImplementation(async (week) => {
    const data = await load(week);
    if (state.on) change(data);
    return data;
  });
  return { actions, changed: () => (state.on = true) };
}
async function reread(actions: PlusActions) {
  const calls = vi.mocked(actions.load).mock.calls.length;
  fireEvent.click(screen.getAllByRole("button", { name: "Refresh" })[0]!);
  await waitFor(() =>
    expect(vi.mocked(actions.load).mock.calls.length).toBeGreaterThan(calls),
  );
}

it("never sends a mail a re-read shows estimated while the confirmation is open: it shows the new count first", async () => {
  // A FlowDay estimate is FlowDay's, which Todofy cannot see when it checks again.
  const { actions, changed } = changing((data) => {
    data.plan.tasks = data.plan.tasks.map((task) =>
      task.id === "mail-notes" ? { ...task, estimatedMinutes: 25 } : task,
    );
  });
  const deleteMail = vi.spyOn(actions, "deleteMail");
  await renderMailbox(actions);
  fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "Delete 2 emails?" }),
  );
  changed();
  await reread(actions); // as App's re-read when the tab is shown again
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
  fireEvent.click(dialog.getByRole("button", { name: "Delete 2" }));
  // Nothing sent: the dialog now asks about one, says why the other stays, and reads the count out.
  await screen.findByRole("dialog", { name: "Delete 1 email?" });
  expect(deleteMail).not.toHaveBeenCalled();
  expect(
    dialog.getByText(`1 you've changed or planned is kept: ${NOTES}.`),
  ).toBeTruthy();
  expect(
    screen.getByRole("dialog").querySelector(".plus-sr-only[role=status]")
      ?.textContent,
  ).toBe("Delete 1 email?");
  fireEvent.click(dialog.getByRole("button", { name: "Delete 1" }));
  await screen.findByText("Deleted 1 email");
  expect(deleteMail.mock.calls).toEqual([
    [["mail-register"], expect.any(String)],
  ]);
});

it("checks the frozen batch again before Try again, under a new request when it shrank", async () => {
  // Put on today's FlowDay queue in another tab after a failed first try.
  const { actions, changed } = changing((data) => {
    data.focus = {
      ...data.focus,
      taskIds: [...data.focus.taskIds, "mail-notes"],
    };
  });
  const deleteMail = vi
    .spyOn(actions, "deleteMail")
    .mockRejectedValueOnce(new Error("Synthetic deletion unavailable"));
  await renderMailbox(actions);
  fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "Delete 2 emails?" }),
  );
  fireEvent.click(dialog.getByRole("button", { name: "Delete 2" }));
  await dialog.findByRole("alert");
  changed();
  await reread(actions);
  await waitFor(() =>
    expect(dialog.getByRole("button", { name: "Try again" })).toBeTruthy(),
  );
  fireEvent.click(dialog.getByRole("button", { name: "Try again" }));
  await screen.findByRole("dialog", { name: "Delete 1 email?" });
  expect(deleteMail).toHaveBeenCalledOnce();
  fireEvent.click(dialog.getByRole("button", { name: "Delete 1" }));
  await waitFor(() => expect(deleteMail).toHaveBeenCalledTimes(2));
  const [first, second] = deleteMail.mock.calls;
  expect(second![0]).toEqual(["mail-register"]);
  // The IDs changed, so the request did too: Todofy refuses another body under a request ID.
  expect(second![1]).not.toBe(first![1]);
});

it("closes the confirmation when every mail in the batch was touched meanwhile, deleting nothing", async () => {
  const { actions, changed } = changing((data) => {
    data.plan.tasks = data.plan.tasks.map((task) =>
      task.id.startsWith("mail-") ? { ...task, labels: ["reading"] } : task,
    );
  });
  const deleteMail = vi.spyOn(actions, "deleteMail");
  await renderMailbox(actions);
  fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
  const dialog = within(await screen.findByRole("dialog"));
  changed();
  await reread(actions);
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Delete all" })).toBeNull(),
  );
  fireEvent.click(dialog.getByRole("button", { name: "Delete 2" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(statusLine().textContent).toBe(
    "Deleted 0; 2 had changes and were kept",
  );
  expect(deleteMail).not.toHaveBeenCalled();
});

it("reads a permanent deletion's warning and what it keeps out with the confirmation's title", async () => {
  const actions = withMail(
    [mailTask("labelled", { labels: ["reading"] })],
    [
      {
        id: "event-labelled",
        taskId: "labelled",
        brief: "",
        receivedAt: "2026-10-13T17:00:00Z",
        hasSummary: false,
      },
    ],
  );
  await renderMailbox(actions, "zh");
  fireEvent.click(screen.getByRole("button", { name: "全部删除" }));
  const dialog = await screen.findByRole("dialog", { name: "删除 2 封邮件？" });
  const described = dialog
    .getAttribute("aria-describedby")!
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent);
  expect(described).toEqual([
    "Todoist 中这 2 个任务会被永久删除，无法撤销。",
    "有改动或已排进计划的 1 封会保留：Synthetic mail labelled。",
  ]);
  expect(document.activeElement?.textContent).toBe("取消");
});
