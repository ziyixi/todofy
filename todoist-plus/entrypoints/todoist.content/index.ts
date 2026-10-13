import { defineContentScript } from "wxt/utils/define-content-script";
import { mountTodoist } from "../../src/mount";
import "../../src/styles.css";
export default defineContentScript({
  matches: ["https://app.todoist.com/*"],
  cssInjectionMode: "ui",
  runAt: "document_idle",
  main: mountTodoist,
});
