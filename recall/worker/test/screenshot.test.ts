import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { SCREENSHOT_MAX_BYTES } from '../../shared/url.ts';
import { base64Of, screenshotBytes } from '../src/screenshot.ts';

// Native-encoded solid one-pixel fixture, not derived from browsing.
const JPEG = base64Of(readFileSync(fileURLToPath(new URL('./fixtures/screenshot-1x1.jpg', import.meta.url).href)));

function riffChunk(tag: string, payload: Uint8Array): Uint8Array {
  const padded = payload.length + (payload.length % 2);
  const out = new Uint8Array(8 + padded);
  for (let i = 0; i < 4; i++) out[i] = tag.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

function webpContainer(chunks: readonly Uint8Array[]): string {
  const totalPayload = 4 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(8 + totalPayload);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
  new DataView(out.buffer).setUint32(4, totalPayload, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'
  let offset = 12;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return base64Of(out);
}

function vp8xPayload(width: number, height: number, flags = 0): Uint8Array {
  const payload = new Uint8Array(10);
  payload[0] = flags;
  const w = width - 1;
  const h = height - 1;
  payload[4] = w & 0xff;
  payload[5] = (w >>> 8) & 0xff;
  payload[6] = (w >>> 16) & 0xff;
  payload[7] = h & 0xff;
  payload[8] = (h >>> 8) & 0xff;
  payload[9] = (h >>> 16) & 0xff;
  return payload;
}

function vp8KeyFramePayload(width: number, height: number, nonKeyFrame = false): Uint8Array {
  const payload = new Uint8Array(10);
  payload[0] = nonKeyFrame ? 1 : 0;
  payload[3] = 0x9d;
  payload[4] = 0x01;
  payload[5] = 0x2a;
  const view = new DataView(payload.buffer);
  view.setUint16(6, width & 0x3fff, true);
  view.setUint16(8, height & 0x3fff, true);
  return payload;
}

function vp8lPayload(width: number, height: number, signature = 0x2f, oddExtraByte = false): Uint8Array {
  const payload = new Uint8Array(oddExtraByte ? 7 : 6);
  payload[0] = signature;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  new DataView(payload.buffer).setUint32(1, bits, true);
  return payload;
}

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

it('parses WebP RIFF VP8X, VP8 keyframe, VP8L lossless, odd-byte padding, and rejects ANIM/ANMF or animation flags', () => {
  // Lossy VP8 keyframe chunk
  const vp8 = webpContainer([riffChunk('VP8 ', vp8KeyFramePayload(320, 240))]);
  expect(screenshotBytes(vp8, 320, 240, 'image/webp')).not.toBeNull();
  expect(screenshotBytes(vp8, 321, 240, 'image/webp')).toBeNull();

  // Rejects non-keyframe VP8 (bit 0 set) or bad start code
  const nonKeyVp8 = webpContainer([riffChunk('VP8 ', vp8KeyFramePayload(320, 240, true))]);
  expect(screenshotBytes(nonKeyVp8, 320, 240, 'image/webp')).toBeNull();

  // Lossless VP8L chunk with odd-byte payload size (7 bytes + 1 padding byte) followed by another chunk
  const vp8lOdd = webpContainer([
    riffChunk('VP8X', vp8xPayload(640, 480)),
    riffChunk('ICCP', new Uint8Array([1, 2, 3])), // odd-sized metadata chunk (3 bytes + 1 pad byte)
    riffChunk('VP8L', vp8lPayload(640, 480, 0x2f, true)),
  ]);
  expect(screenshotBytes(vp8lOdd, 640, 480, 'image/webp')).not.toBeNull();
  expect(screenshotBytes(vp8lOdd, 640, 481, 'image/webp')).toBeNull();

  // Rejects VP8L with wrong signature byte
  const badVp8l = webpContainer([riffChunk('VP8L', vp8lPayload(640, 480, 0x00))]);
  expect(screenshotBytes(badVp8l, 640, 480, 'image/webp')).toBeNull();

  // Rejects VP8X with animation flag (bit 1 = 0x02) or VP8X without any image chunk
  const animFlagVp8x = webpContainer([
    riffChunk('VP8X', vp8xPayload(320, 240, 0x02)),
    riffChunk('VP8 ', vp8KeyFramePayload(320, 240)),
  ]);
  expect(screenshotBytes(animFlagVp8x, 320, 240, 'image/webp')).toBeNull();
  const vp8xOnly = webpContainer([riffChunk('VP8X', vp8xPayload(320, 240))]);
  expect(screenshotBytes(vp8xOnly, 320, 240, 'image/webp')).toBeNull();

  // Rejects ANIM and ANMF chunks
  const withAnim = webpContainer([
    riffChunk('ANIM', new Uint8Array(6)),
    riffChunk('VP8 ', vp8KeyFramePayload(320, 240)),
  ]);
  expect(screenshotBytes(withAnim, 320, 240, 'image/webp')).toBeNull();
  const withAnmf = webpContainer([
    riffChunk('ANMF', new Uint8Array(16)),
    riffChunk('VP8 ', vp8KeyFramePayload(320, 240)),
  ]);
  expect(screenshotBytes(withAnmf, 320, 240, 'image/webp')).toBeNull();
});

