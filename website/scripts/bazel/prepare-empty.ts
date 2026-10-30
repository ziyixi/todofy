import { mkdir, readFile } from "node:fs/promises";

import { prepareContent } from "../content/prepare.ts";
import { prepareSiteImages } from "../images/prepare.ts";

const baseline = JSON.parse(await readFile("tests/fixtures/baseline-empty.json", "utf8"));
const time = new Date("2000-01-01T00:00:00Z");
await prepareContent({ source: "empty", baseline, cutoff: time, completedAt: time });
await prepareSiteImages({});
await mkdir("public/media", { recursive: true });
await mkdir("public/_img", { recursive: true });
