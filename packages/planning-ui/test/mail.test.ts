import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  MailCategoriesDialog,
  type MailCategoryActions,
} from "../src/MailCategories";
import { categoryName, localDate } from "../src/mail";
import type { MailCategories } from "../src/model";

afterEach(cleanup);

const LABELS = [
  { id: "l-office", name: "Work" },
  { id: "l-quick", name: "Quick" },
] as const;

it("names a mail category by its label and priority, and none once its label is gone", () => {
  const labels = [
    { id: "l-office", name: "工作" },
    { id: "l-quick", name: "quick" },
  ];
  expect(categoryName({ labelId: "l-office", priority: 2 }, labels)).toBe(
    "工作 · P2",
  );
  expect(categoryName({ labelId: "l-quick", priority: 4 }, labels)).toBe(
    "quick · P4",
  );
  expect(
    categoryName({ labelId: "gone", priority: 1 }, labels),
  ).toBeUndefined();
});

it("tells an instant's day in the account's time zone", () => {
  // 06:00 UTC on the 16th is still the 15th in Los Angeles.
  expect(localDate("2026-10-16T06:00:00Z", "America/Los_Angeles")).toBe(
    "2026-10-15",
  );
  expect(localDate("2026-10-16T16:42:00Z", "America/Los_Angeles")).toBe(
    "2026-10-16",
  );
  expect(localDate("2026-10-16T06:00:00Z", "UTC")).toBe("2026-10-16");
});

it("shows loading state and reports an error alert when reading mail categories fails", async () => {
  let rejectRead: (reason?: unknown) => void = () => {};
  const actions: MailCategoryActions = {
    readMailSettings: () =>
      new Promise<MailCategories>((_resolve, reject) => {
        rejectRead = reject;
      }),
    updateMailCategories: vi.fn(),
  };
  const onClose = vi.fn();
  render(
    createElement(MailCategoriesDialog, {
      headingId: "mail-heading",
      labels: LABELS,
      language: "en",
      busy: false,
      actions,
      onSaved: vi.fn(),
      onClose,
    }),
  );
  expect(screen.getByRole("status").textContent).toBe(
    "Loading the categories…",
  );
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledOnce();

  rejectRead(new Error("read failed"));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe(
      "Couldn't read the mail categories.",
    ),
  );
});

it("validates missing, deleted, and duplicate categories, enforces the 4-category cap, and saves updates", async () => {
  const initial: MailCategories = {
    etag: "etag-1",
    categories: [
      { id: "c-1", labelId: "l-office", priority: 2 },
      { id: "c-2", labelId: "l-deleted", priority: 1 },
    ],
  };
  const savedResult: MailCategories = {
    etag: "etag-2",
    categories: [
      { id: "c-1", labelId: "l-office", priority: 1 },
      { id: "c-3", labelId: "l-quick", priority: 4 },
    ],
  };
  const updateMailCategories = vi
    .fn<MailCategoryActions["updateMailCategories"]>()
    .mockRejectedValueOnce(new Error("Temporary save error"))
    .mockResolvedValueOnce(savedResult);
  const actions: MailCategoryActions = {
    readMailSettings: vi.fn().mockResolvedValue(initial),
    updateMailCategories,
  };
  const onSaved = vi.fn();

  render(
    createElement(MailCategoriesDialog, {
      headingId: "mail-heading",
      labels: LABELS,
      language: "en",
      busy: false,
      actions,
      onSaved,
      onClose: vi.fn(),
    }),
  );

  await screen.findByText("That label no longer exists. Choose another.");
  // Saving while a label is gone reports labelGone without calling updateMailCategories.
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert").textContent).toBe(
    "That label no longer exists. Choose another.",
  );
  expect(updateMailCategories).not.toHaveBeenCalled();

  // Remove the deleted-label row.
  fireEvent.click(
    screen.getByRole("button", {
      name: "Remove category: Choose a label · P1",
    }),
  );
  expect(screen.queryByRole("alert")).toBeNull();

  // Add a blank category -> saving requires a label.
  fireEvent.click(screen.getByRole("button", { name: "Add a category" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert").textContent).toBe(
    "Choose a label for each category.",
  );

  // Set second row to same label + priority as first row -> duplicate error.
  fireEvent.change(screen.getByRole("combobox", { name: "Label 2" }), {
    target: { value: "l-office" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Priority 2" }), {
    target: { value: "2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert").textContent).toBe(
    "That category already exists.",
  );

  // Add two more categories to reach MAX_CATEGORIES (4) and check add button is disabled.
  const addButton = screen.getByRole<HTMLButtonElement>("button", {
    name: "Add a category",
  });
  fireEvent.click(addButton);
  fireEvent.click(addButton);
  expect(addButton.disabled).toBe(true);
  expect(addButton.title).toBe("Up to 4");

  // Remove the two extra blank categories and make row 1 P1 and row 2 l-quick P4.
  const removeButtons = screen.getAllByRole("button", {
    name: /^Remove category:/,
  });
  fireEvent.click(removeButtons[3]!);
  fireEvent.click(removeButtons[2]!);
  fireEvent.change(screen.getByRole("combobox", { name: "Priority 1" }), {
    target: { value: "1" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Label 2" }), {
    target: { value: "l-quick" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Priority 2" }), {
    target: { value: "4" },
  });

  // First save fails with error alert.
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("Temporary save error"),
  );
  expect(onSaved).not.toHaveBeenCalled();

  // Second save succeeds and invokes onSaved.
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(savedResult));
  expect(updateMailCategories).toHaveBeenLastCalledWith(
    [
      { labelId: "l-office", priority: 1 },
      { labelId: "l-quick", priority: 4 },
    ],
    "etag-1",
  );
});

it("renders Chinese copy when language is zh", async () => {
  const actions: MailCategoryActions = {
    readMailSettings: vi.fn().mockResolvedValue({
      etag: "etag-zh",
      categories: [],
    }),
    updateMailCategories: vi.fn(),
  };
  render(
    createElement(MailCategoriesDialog, {
      headingId: "mail-heading-zh",
      labels: LABELS,
      language: "zh",
      busy: false,
      actions,
      onSaved: vi.fn(),
      onClose: vi.fn(),
    }),
  );
  await screen.findByRole("button", { name: "添加归类" });
  expect(screen.getByRole("heading", { name: "邮件归类" })).toBeTruthy();
});
