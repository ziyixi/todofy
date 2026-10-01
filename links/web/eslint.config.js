import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Type-checked TypeScript rules for the launcher (the Worker uses the stricter set). fetch is called in one module
// only, the same-origin API client.
export default defineConfig(
  { ignores: ['node_modules/', 'dist/'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
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
