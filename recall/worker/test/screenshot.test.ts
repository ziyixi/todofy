import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { base64Of, screenshotBytes } from '../src/screenshot.ts';
import { SCREENSHOT_MAX_BYTES } from '../../shared/url.ts';

// Native-encoded solid one-pixel fixture, not derived from browsing.
const JPEG = base64Of(readFileSync(fileURLToPath(new URL('./fixtures/screenshot-1x1.jpg', import.meta.url).href)));

it('accepts bounded native JPEG dimensions, rejects mismatched or malformed images and excessive bytes', () => {
  expect(screenshotBytes(JPEG, 1, 1, 'image/jpeg')).not.toBeNull();
  expect(screenshotBytes(JPEG, 2, 1, 'image/jpeg')).toBeNull();
  expect(screenshotBytes(JPEG, 1, 1)).toBeNull();
  expect(screenshotBytes(JPEG.slice(0, -4), 1, 1, 'image/jpeg')).toBeNull();
  expect(screenshotBytes(base64Of(new Uint8Array(SCREENSHOT_MAX_BYTES + 1)), 1, 1, 'image/jpeg')).toBeNull();
  const badLength = Uint8Array.from(atob(JPEG), (value) => value.charCodeAt(0));
  badLength[4] = 0xff;
  expect(screenshotBytes(base64Of(badLength), 1, 1, 'image/jpeg')).toBeNull();
});
