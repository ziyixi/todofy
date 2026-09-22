import { cache } from "react";

import { readContentBundle, readSiteData } from "@/lib/content";

export const getContentBundle = cache(readContentBundle);
export const getSiteData = cache(readSiteData);
