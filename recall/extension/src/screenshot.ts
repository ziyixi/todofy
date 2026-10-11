/** Chrome captures only the visible tab; the caller verifies its focus and page before and after this call. */
import { SCREENSHOT_MAX_BYTES, SCREENSHOT_MAX_EDGE, SCREENSHOT_QUALITY } from '../../shared/url.ts';

export interface Screenshot {
  readonly base64: string;
  readonly preview: string;
  readonly width: number;
  readonly height: number;
}

/** A viewport-sized PNG from Chrome, resized and encoded with the browser's native WebP encoder. */
export async function compressScreenshot(png: string): Promise<Screenshot | null> {
  if (!png.startsWith('data:image/png;base64,')) return null;
  const bitmap = await createImageBitmap(await (await fetch(png)).blob());
  try {
    if (bitmap.width <= 0 || bitmap.height <= 0) return null;
    const scale = Math.min(1, SCREENSHOT_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context === null) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: SCREENSHOT_QUALITY });
    if (blob.type !== 'image/webp' || blob.size === 0 || blob.size > SCREENSHOT_MAX_BYTES) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const tiny = new OffscreenCanvas(32, 32);
    const tinyContext = tiny.getContext('2d');
    if (tinyContext === null) return null;
    tinyContext.drawImage(bitmap, 0, 0, 32, 32);
    const pixels = tinyContext.getImageData(0, 0, 32, 32).data;
    const preview = `${String(width)}x${String(height)}:${btoa(String.fromCharCode(...pixels))}`;
    return { base64: btoa(binary), preview, width, height };
  } finally {
    bitmap.close();
  }
}

/** Ignore small clocks, cursors and encoding noise: at least 8% of the 32x32 preview must visibly change. */
export function visiblyChanged(previous: string | undefined, current: string): boolean {
  if (previous === undefined) return true;
  if (previous === current) return false;
  const [oldSize, oldPixels = ''] = previous.split(':');
  const [newSize, newPixels = ''] = current.split(':');
  if (oldSize !== newSize) return true;
  const before = atob(oldPixels);
  const after = atob(newPixels);
  if (before.length !== 4096 || after.length !== 4096) return true;
  let changed = 0;
  for (let i = 0; i < before.length; i += 4) {
    if ([0, 1, 2].some((channel) => Math.abs(before.charCodeAt(i + channel) - after.charCodeAt(i + channel)) >= 24)) changed += 1;
  }
  return changed >= 82;
}
