import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      ".wxt/",
      ".output/",
      "dist/",
      "test-results/",
      "playwright-report/",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        document: "readonly",
        window: "readonly",
        location: "readonly",
        history: "readonly",
        navigator: "readonly",
        MutationObserver: "readonly",
        HTMLElement: "readonly",
        Element: "readonly",
        HTMLInputElement: "readonly",
        HTMLTextAreaElement: "readonly",
        HTMLSelectElement: "readonly",
        URL: "readonly",
        fetch: "readonly",
        crypto: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        process: "readonly",
      },
    },
  },
);
