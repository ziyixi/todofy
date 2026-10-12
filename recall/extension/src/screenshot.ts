/** Chrome captures only the visible tab; the caller verifies its focus and page before and after this call. */
import { SCREENSHOT_MAX_BYTES, SCREENSHOT_MAX_EDGE, SCREENSHOT_QUALITY } from '../../shared/url.ts';

export interface Screenshot {
  readonly base64: string;
  readonly mediaType?: 'image/webp' | 'image/jpeg';
  readonly preview: string;
  readonly width: number;
  readonly height: number;
}

type CaptureCanvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(width: number, height: number): CaptureCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function encode(canvas: CaptureCanvas, type: string): Promise<Blob | null> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality: SCREENSHOT_QUALITY });
  return new Promise((resolve) => { canvas.toBlob(resolve, type, SCREENSHOT_QUALITY); });
}

async function decode(png: string): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap !== 'undefined') return createImageBitmap(await (await fetch(png)).blob());
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => { resolve(); };
    image.onerror = () => { reject(new Error('screenshot_decode')); };
    image.src = png;
  });
  return image;
}

/** Resize natively. WebKit may encode unsupported WebP as PNG; then request and verify JPEG explicitly. */
export async function compressScreenshot(png: string): Promise<Screenshot | null> {
  if (!png.startsWith('data:image/png;base64,')) return null;
  const bitmap = await decode(png);
  try {
    if (bitmap.width <= 0 || bitmap.height <= 0) return null;
    const scale = Math.min(1, SCREENSHOT_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = makeCanvas(width, height);
    const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (context === null) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    let blob = await encode(canvas, 'image/webp');
    if (blob?.type !== 'image/webp') blob = await encode(canvas, 'image/jpeg');
    if (blob === null || (blob.type !== 'image/webp' && blob.type !== 'image/jpeg') || blob.size === 0 || blob.size > SCREENSHOT_MAX_BYTES) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const tiny = makeCanvas(32, 32);
    const tinyContext = tiny.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (tinyContext === null) return null;
    tinyContext.drawImage(bitmap, 0, 0, 32, 32);
    const pixels = tinyContext.getImageData(0, 0, 32, 32).data;
    const preview = `${String(width)}x${String(height)}:${btoa(String.fromCharCode(...pixels))}`;
    return { base64: btoa(binary), preview, width, height, mediaType: blob.type };
  } finally {
    if ('close' in bitmap) bitmap.close();
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
