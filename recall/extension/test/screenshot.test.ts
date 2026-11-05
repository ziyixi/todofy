/** Verify the actual native encoder's reported type, rather than assuming that requesting WebP produced WebP. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressScreenshot, visiblyChanged } from '../src/screenshot.ts';

afterEach(() => { vi.unstubAllGlobals(); });

function canvasWith(types: string[]) {
  const encodings: string[] = [];
  class Canvas {
    getContext() { return { drawImage: () => undefined, getImageData: () => ({ data: new Uint8ClampedArray(4096) }) }; }
    convertToBlob({ type }: { type: string }) { encodings.push(type); return Promise.resolve(new Blob(['synthetic-image'], { type: types.shift() ?? 'image/png' })); }
  }
  vi.stubGlobal('OffscreenCanvas', Canvas);
  vi.stubGlobal('createImageBitmap', () => Promise.resolve({ width: 390, height: 844, close: () => undefined }));
  vi.stubGlobal('fetch', () => Promise.resolve(new Blob(['png']).stream() ? new Response(new Blob(['png'])) : new Response()));
  return encodings;
}

function previewOf(size: string, customize?: (rgba: Uint8Array) => void): string {
  const rgba = new Uint8Array(4096);
  customize?.(rgba);
  let binary = '';
  for (const byte of rgba) binary += String.fromCharCode(byte);
  return `${size}:${btoa(binary)}`;
}

describe('native screenshot encoding', () => {
  it('keeps native WebP and falls back to verified JPEG when WebP produced PNG', async () => {
    const webp = canvasWith(['image/webp']);
    expect((await compressScreenshot('data:image/png;base64,cG5n'))?.mediaType).toBe('image/webp');
    expect(webp).toEqual(['image/webp']);
    const jpeg = canvasWith(['image/png', 'image/jpeg']);
    expect((await compressScreenshot('data:image/png;base64,cG5n'))?.mediaType).toBe('image/jpeg');
    expect(jpeg).toEqual(['image/webp', 'image/jpeg']);
  });
  it('uses the background-page canvas when OffscreenCanvas is absent', async () => {
    const encodings = canvasWith(['image/png', 'image/jpeg']);
    const Canvas = globalThis.OffscreenCanvas;
    vi.stubGlobal('OffscreenCanvas', undefined);
    vi.stubGlobal('document', { createElement: () => {
      const canvas = new Canvas(1, 1);
      return {
        width: 0, height: 0,
        getContext: () => canvas.getContext('2d'),
        toBlob: (done: (blob: Blob) => void, type: string) => { void canvas.convertToBlob({ type }).then(done); },
      };
    } });
    expect((await compressScreenshot('data:image/png;base64,cG5n'))?.mediaType).toBe('image/jpeg');
    expect(encodings).toEqual(['image/webp', 'image/jpeg']);
  });
  it('does not label an unsupported PNG encoder result as JPEG', async () => {
    canvasWith(['image/png', 'image/png']);
    expect(await compressScreenshot('data:image/png;base64,cG5n')).toBeNull();
  });
});

describe('visiblyChanged preview pixel threshold', () => {
  it('requires at least 82 of 1024 pixels to change by >= 24 in RGB, or a size/format change', () => {
    const base = previewOf('800x600');
    expect(visiblyChanged(undefined, base)).toBe(true);
    expect(visiblyChanged(base, base)).toBe(false);
    expect(visiblyChanged(base, previewOf('600x800'))).toBe(true);
    expect(visiblyChanged('800x600:' + btoa('short'), base)).toBe(true);

    // 81 pixels changed by 24 in R channel (< 82 threshold) -> false
    const changed81 = previewOf('800x600', (rgba) => {
      for (let p = 0; p < 81; p++) rgba[p * 4] = 24;
    });
    expect(visiblyChanged(base, changed81)).toBe(false);

    // 82 pixels changed by 24 in G channel (>= 82 threshold) -> true
    const changed82 = previewOf('800x600', (rgba) => {
      for (let p = 0; p < 82; p++) rgba[p * 4 + 1] = 24;
    });
    expect(visiblyChanged(base, changed82)).toBe(true);

    // 200 pixels changed by 23 in B channel and 255 in alpha (< 24 RGB threshold) -> false
    const noiseOnly = previewOf('800x600', (rgba) => {
      for (let p = 0; p < 200; p++) {
        rgba[p * 4 + 2] = 23;
        rgba[p * 4 + 3] = 255;
      }
    });
    expect(visiblyChanged(base, noiseOnly)).toBe(false);
  });
});

