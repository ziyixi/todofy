import { expect, it } from "vitest";
import { categoryName, localDate } from "../src/mail";

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
