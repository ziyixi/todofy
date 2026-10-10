/**
 * capture.js: injected on demand by `scripting.executeScript({files: ['capture.js']})` into one document's isolated
 * world, never as a content script. executeScript answers the value of the script's last statement, which the build
 * appends (scripts/build.mjs: `recallCapture.result;`).
 */
import { readPage } from './page-text.ts';

/** The build's version, set by scripts/build.mjs. */
declare const RECALL_BUILD: string;

export const result = readPage(document, RECALL_BUILD);
