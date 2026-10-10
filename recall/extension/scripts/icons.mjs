// The extension's icon, drawn at build time so that no binary file is committed: recall's violet accent (#56419a)
// as a disc with a white ring inside, antialiased, as an RGBA PNG.
import { crc32, deflateSync } from 'node:zlib';

export const ICON_SIZES = [16, 32, 48, 128];
const VIOLET = [0x56, 0x41, 0x9a];
const WHITE = [0xff, 0xff, 0xff];

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, checksum]);
}

/** How much of a pixel (its centre at distance `d` from the icon's centre) lies inside radius `r`. */
const coverage = (d, r) => Math.min(1, Math.max(0, r - d + 0.5));

/** The icon at `size` × `size` pixels, as PNG bytes. */
export function iconPng(size) {
  const centre = size / 2;
  const outer = size * 0.47;
  const ringOuter = size * 0.27;
  const ringInner = size * 0.15;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - centre, y + 0.5 - centre);
      const ring = coverage(d, ringOuter) - coverage(d, ringInner);
      const color = VIOLET.map((channel, i) => Math.round(channel + (WHITE[i] - channel) * ring));
      row.set([...color, Math.round(255 * coverage(d, outer))], 1 + x * 4);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
