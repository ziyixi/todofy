import { createHttpClient } from "@ziyixi/proto/http-client";
import {
  PlusService,
  type MailCategory,
  type Priority,
} from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";
import type { MailCategories } from "@ziyixi/planning-ui";
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
export const categoryActions = {
  async readMailSettings() {
    const response = await mailApi.readMailSettings({});
    return categories(response.categories, response.etag);
  },
  async updateMailSettings(
    items: Omit<MailCategories["categories"][number], "id">[],
    etag: string,
  ) {
    const response = await mailApi.updateMailSettings({
      categories: items.map((item) => ({
        label: { provider: "tasks", externalId: item.labelId },
        priority: item.priority as Priority,
      })),
      etag,
    });
    return categories(response.categories, response.etag);
  },
};
