import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    ignores: ["node_modules/", "dist/", "test-results/", "playwright-report/"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  { files: ["public/sw.js"], languageOptions: { globals: { self: "readonly", Response: "readonly" } } },
  {
    languageOptions: {
      globals: {
        document: "readonly",
        window: "readonly",
        navigator: "readonly",
        URL: "readonly",
        fetch: "readonly",
        crypto: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
);
