/** Bounded still WebP screenshots from the extension's canvas; no image decoding in the Worker. */
import { SCREENSHOT_MAX_BYTES, SCREENSHOT_MAX_EDGE } from '../../shared/url.ts';

/** Checks RIFF/chunk bounds and the encoded dimensions, so client metadata cannot bypass the pixel limit. */
export function screenshotBytes(base64: string, width: number, height: number): Uint8Array | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > SCREENSHOT_MAX_EDGE || height > SCREENSHOT_MAX_EDGE) return null;
  if (base64.length > Math.ceil(SCREENSHOT_MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length < 26 || bytes.length > SCREENSHOT_MAX_BYTES) return null;
  const view = new DataView(bytes.buffer);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP' || view.getUint32(4, true) + 8 !== bytes.length) return null;
  let image = false;
  for (let at = 12; at < bytes.length;) {
    if (at + 8 > bytes.length) return null;
    const kind = tag(at);
    const size = view.getUint32(at + 4, true);
    const start = at + 8;
    const end = start + size + (size % 2);
    if (end > bytes.length || kind === 'ANIM' || kind === 'ANMF') return null;
    let w = width;
    let h = height;
    if (kind === 'VP8X') {
      if (size !== 10 || ((bytes[start] ?? 0) & 2) !== 0) return null;
      w = 1 + (view.getUint32(start + 4, true) & 0xffffff);
      h = 1 + ((bytes[start + 7] ?? 0) | ((bytes[start + 8] ?? 0) << 8) | ((bytes[start + 9] ?? 0) << 16));
    } else if (kind === 'VP8 ') {
      if (size < 10 || bytes[start + 3] !== 0x9d || bytes[start + 4] !== 0x01 || bytes[start + 5] !== 0x2a || ((bytes[start] ?? 0) & 1) !== 0) return null;
      w = view.getUint16(start + 6, true) & 0x3fff;
      h = view.getUint16(start + 8, true) & 0x3fff;
      image = true;
    } else if (kind === 'VP8L') {
      if (size < 5 || bytes[start] !== 0x2f) return null;
      const bits = view.getUint32(start + 1, true);
      w = (bits & 0x3fff) + 1;
      h = ((bits >>> 14) & 0x3fff) + 1;
      image = true;
    }
    if (w !== width || h !== height) return null;
    at = end;
  }
  return image ? bytes : null;
}

export function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
