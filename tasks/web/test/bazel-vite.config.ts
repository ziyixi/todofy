import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import config from "../vite.config.ts";

// Native bundling canonicalizes input symlinks; keep its root in that same declared output tree.
export default {
  ...config,
  root: dirname(realpathSync("index.html")),
  build: { ...config.build, outDir: resolve("dist") },
};
