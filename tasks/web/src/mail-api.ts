import { createHttpClient } from "@ziyixi/proto/http-client";
import type { MailCategories as ApiCategories } from "@ziyixi/proto/tasks/ui/v1/mail_pb";
import { MailService } from "@ziyixi/proto/todofy/mail/v1/mail_service_pb";
import type { MailCategories } from "@ziyixi/planning-ui";
import type { MailCategoryActions } from "@ziyixi/planning-ui/MailCategories";
import { api, send } from "./api";

/**
 * Todofy's Mail entry, through Tasks' same-origin `/api/mail/v1/*`: the list, one mail with its summary and deleting
 * summaries. Converting a mail and the categories are Tasks' own (`api`).
 */
export const mailApi = createHttpClient(MailService, send);

function categories(saved: ApiCategories): MailCategories {
  return {
    etag: saved.etag,
    categories: saved.categories.map((category) => ({
      id: category.id,
      labelId: category.labelId,
      priority: category.priority,
    })),
  };
}
export const categoryActions: MailCategoryActions = {
  async readMailSettings() {
    return categories(await api.getMailCategories({ name: "mailCategories" }));
  },
  async updateMailCategories(items, etag) {
    return categories(
      await api.updateMailCategories({
        mailCategories: {
          name: "mailCategories",
          categories: items.map((item) => ({
            labelId: item.labelId,
            priority: item.priority,
          })),
        },
        updateMask: { paths: ["categories"] },
        etag,
      }),
    );
  },
};
