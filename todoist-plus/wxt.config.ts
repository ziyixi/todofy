import { execFileSync } from "node:child_process";
import { defineConfig } from "wxt";
const sha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const date = new Date(
  execFileSync("git", ["show", "-s", "--format=%cI", "HEAD"], {
    encoding: "utf8",
  }).trim(),
);
const version = `${date.getUTCFullYear()}.${(date.getUTCMonth() + 1) * 100 + date.getUTCDate()}.${date.getUTCHours() * 60 + date.getUTCMinutes()}.${parseInt(sha.slice(0, 4), 16)}`;
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Todoist Plus",
    version,
    version_name: sha.slice(0, 7),
    description:
      "Weekly choices, small steps and FlowDay focus inside Todoist.",
    permissions: ["storage"],
    host_permissions: ["https://app.todoist.com/*"],
    optional_host_permissions: ["https://*/*"],
  },
});
