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
  // The workerd suite never reads the wall clock (test/runtime/flows.ts): ticks run at the instants a test
  // passes, owner requests at the pinned DEV_NOW. Parsing and formatting fixed instants stays allowed.
  {
    files: ['test/runtime/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Runtime tests choose their instants (tick(at), DEV_NOW): use NOW from flows.ts or a fixed timestamp.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'Runtime tests choose their instants (tick(at), DEV_NOW): use NOW from flows.ts or a fixed timestamp.',
        },
      ],
    },
  },
);
