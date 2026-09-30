import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// The Todofy gateway's rules: strict type-checked TypeScript everywhere except this file. The project
// service picks test/runtime/tsconfig.json (Node types) for the workerd suite, which runs in Node.
export default defineConfig(
  { ignores: ['node_modules/', '.wrangler/', 'test/stubs/*.js'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  { files: ['eslint.config.js'], extends: [tseslint.configs.disableTypeChecked] },
);
