/** Verify the actual native encoder's reported type, rather than assuming that requesting WebP produced WebP. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressScreenshot } from '../src/screenshot.ts';

afterEach(() => { vi.unstubAllGlobals(); });

function canvasWith(types: string[]) {
  const encodings: string[] = [];
  class Canvas {
    getContext() { return { drawImage: () => undefined, getImageData: () => ({ data: new Uint8ClampedArray(4096) }) }; }
    convertToBlob({ type }: { type: string }) { encodings.push(type); return Promise.resolve(new Blob(['synthetic-image'], { type: types.shift() ?? 'image/png' })); }
  }
  vi.stubGlobal('OffscreenCanvas', Canvas);
  vi.stubGlobal('createImageBitmap', () => Promise.resolve({ width: 390, height: 844, close: () => undefined }));
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(new Blob(['png']))));
  return encodings;
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
