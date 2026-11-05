import { afterEach, expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import {
  MailCategoriesSchema,
  MailCategorySchema,
} from "@ziyixi/proto/tasks/ui/v1/mail_pb";
import { api } from "./api";
import { categoryActions, mailApi } from "./mail-api";

afterEach(() => {
  vi.restoreAllMocks();
});

it("exposes mailApi client methods and maps readMailSettings and updateMailCategories through api", async () => {
  expect(typeof mailApi.listMails).toBe("function");
  expect(typeof mailApi.getMail).toBe("function");

  const stored = create(MailCategoriesSchema, {
    name: "mailCategories",
    etag: "5",
    categories: [
      create(MailCategorySchema, {
        id: "cat-1",
        labelId: "label-urgent",
        priority: 1,
      }),
    ],
  });

  const getSpy = vi.spyOn(api, "getMailCategories").mockResolvedValue(stored);
  const readResult = await categoryActions.readMailSettings();
  expect(getSpy).toHaveBeenCalledWith({ name: "mailCategories" });
  expect(readResult).toEqual({
    etag: "5",
    categories: [{ id: "cat-1", labelId: "label-urgent", priority: 1 }],
  });

  const updated = create(MailCategoriesSchema, {
    name: "mailCategories",
    etag: "6",
    categories: [
      create(MailCategorySchema, {
        id: "cat-2",
        labelId: "label-later",
        priority: 3,
      }),
    ],
  });
  const updateSpy = vi
    .spyOn(api, "updateMailCategories")
    .mockResolvedValue(updated);
  const updateResult = await categoryActions.updateMailCategories(
    [{ id: "cat-2", labelId: "label-later", priority: 3 }],
    "5",
  );
  expect(updateSpy).toHaveBeenCalledWith({
    mailCategories: {
      name: "mailCategories",
      categories: [{ labelId: "label-later", priority: 3 }],
    },
    updateMask: { paths: ["categories"] },
    etag: "5",
  });
  expect(updateResult).toEqual({
    etag: "6",
    categories: [{ id: "cat-2", labelId: "label-later", priority: 3 }],
  });
});
