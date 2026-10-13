// Check the already-built artifact that CI will publish. All requests stay in the synthetic harness.
import { writeFile } from 'node:fs/promises';
import { webkit, expect } from '@playwright/test';
import { checkOrionOptions } from './options-browser.mjs';

const result = await checkOrionOptions({ webkit, expect, folder: './dist' });
await writeFile('./dist/orion-browser-check.json', JSON.stringify(result, null, 2) + '\n');
for (const check of result.results) console.log(`ok - ${check.case}`);
console.log(`WebKit: ${result.results.length} passed (${result.version}, ${result.sha})`);
