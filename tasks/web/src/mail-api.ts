import { createHttpClient } from "@ziyixi/proto/http-client";
import {
  PlusService,
  type MailCategory,
  type Priority,
} from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";
import type { MailCategories } from "@ziyixi/planning-ui";
import type { MailCategoryActions } from "@ziyixi/planning-ui/MailCategories";
import { send } from "./api";

export const mailApi = createHttpClient(PlusService, send);
function categories(items: MailCategory[], etag: string): MailCategories {
  return {
    etag,
    categories: items.flatMap((item) =>
      item.label?.provider === "tasks"
        ? [
            {
              id: item.id,
              labelId: item.label.externalId,
              priority: item.priority,
            },
          ]
        : [],
    ),
  };
}
export const categoryActions: MailCategoryActions = {
  async readMailSettings() {
    const response = await mailApi.readMailSettings({});
    return categories(response.categories, response.etag);
  },
  async updateMailCategories(items, etag) {
    const response = await mailApi.updateMailCategories({
      categories: items.map((item) => ({
        label: { provider: "tasks", externalId: item.labelId },
        priority: item.priority as Priority,
      })),
      etag,
    });
    return categories(response.categories, response.etag);
  },
};
