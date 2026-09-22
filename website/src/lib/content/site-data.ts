import { readFile } from "node:fs/promises";
import path from "node:path";

import { siteConfig as repositorySiteConfig } from "../../../content/site.config";
import {
  ProfileSchema,
  PublicationsFileSchema,
  RedirectsFileSchema,
  SiteConfigSchema,
  type Profile,
  type Publication,
  type RedirectConfig,
  type SiteConfigData,
} from "./schema";

export interface SiteData {
  siteConfig: SiteConfigData;
  profile: Profile;
  publications: Publication[];
  redirects: RedirectConfig[];
}

export async function readSiteData(
  contentDirectory = path.join(process.cwd(), "content"),
): Promise<SiteData> {
  const [profileText, publicationsText, redirectsText] = await Promise.all([
    readFile(path.join(contentDirectory, "profile.json"), "utf8"),
    readFile(path.join(contentDirectory, "publications.json"), "utf8"),
    readFile(path.join(contentDirectory, "redirects.json"), "utf8"),
  ]);
  const publicationsFile = PublicationsFileSchema.parse(JSON.parse(publicationsText) as unknown);
  return {
    siteConfig: SiteConfigSchema.parse(repositorySiteConfig),
    profile: ProfileSchema.parse(JSON.parse(profileText) as unknown),
    publications: [...publicationsFile.publications].sort(
      (left, right) =>
        right.year - left.year ||
        left.orderWithinYear - right.orderWithinYear ||
        left.id.localeCompare(right.id),
    ),
    redirects: RedirectsFileSchema.parse(JSON.parse(redirectsText) as unknown),
  };
}
