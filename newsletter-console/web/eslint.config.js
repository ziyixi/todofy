import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Type-checked TypeScript rules for the UI (the Worker uses the stricter set). Model, feed and mail text is untrusted:
// it is rendered as text, so raw HTML injection is banned outright.
export default defineConfig(
  { ignores: ['node_modules/', 'dist/'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
        message: 'Untrusted text is rendered as text; the mail HTML only in its sandboxed frame.',
      }],
    },
  },
  { files: ['eslint.config.js'], extends: [tseslint.configs.disableTypeChecked] },
  {
    // Node build scripts (plain ESM, outside the TypeScript project).
    files: ['scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly' } },
  },
);
