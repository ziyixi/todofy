import { beforeEach, vi } from 'vitest';

// workerd's non-standard SubtleCrypto.timingSafeEqual, which Node does not have.
if (!('timingSafeEqual' in crypto.subtle)) {
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    value(a: ArrayBufferView, b: ArrayBufferView): boolean {
      const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      if (left.byteLength !== right.byteLength) throw new TypeError('lengths differ');
      let diff = 0;
      for (const [index, byte] of left.entries()) diff |= byte ^ (right[index] ?? 0);
      return diff === 0;
    },
  });
}

// Error envelopes log one JSON line each; tests read them through this spy.
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
