/**
 * Build-time responsive images for the static export (docs/architecture.md, "Images").
 *
 * The site has no image optimizer at request time. `next/image` asks the custom loader for one URL
 * per width in `ALL_IMAGE_WIDTHS`; the content step (`scripts/images/prepare.ts`) writes a WebP
 * file for each of those widths below the source's own width, plus one at the source width, into
 * `public/_img/`. The file name carries a hash of the source bytes, so `/_img/*` can be cached as
 * immutable. Keep these lists short: every width becomes one file per image.
 */

/** Widths for images that are narrower than the viewport (the portrait is 128 or 160 CSS px). */
export const IMAGE_SIZES = [64, 128, 160, 256, 320] as const;
/** Widths for images sized in vw (article images: up to 680 CSS px, 2x on high-density screens). */
export const DEVICE_SIZES = [384, 480, 640, 750, 828, 1080, 1360] as const;

export const ALL_IMAGE_WIDTHS: readonly number[] = [...IMAGE_SIZES, ...DEVICE_SIZES].sort(
  (left, right) => left - right,
);

/** WebP quality, the same default `next/image` uses. */
export const IMAGE_QUALITY = 75;

export const IMAGE_VARIANT_PREFIX = "/_img/";

export interface ImageVariantEntry {
  /** First 20 hex characters of the SHA-256 of the source bytes. */
  id: string;
  width: number;
  height: number;
  /** Ascending widths that exist as files for this source. */
  widths: number[];
}

export interface ImageVariantMap {
  version: 1;
  images: Record<string, ImageVariantEntry>;
}

/** Every configured width below the intrinsic width, plus the intrinsic width (never upscaled). */
export function variantWidths(intrinsicWidth: number): number[] {
  if (!Number.isInteger(intrinsicWidth) || intrinsicWidth <= 0) {
    throw new Error(`Invalid intrinsic image width: ${intrinsicWidth}`);
  }
  const smaller = ALL_IMAGE_WIDTHS.filter((width) => width < intrinsicWidth);
  return [...smaller, intrinsicWidth];
}

/** The smallest existing variant at least as wide as requested, else the widest one. */
export function pickVariantWidth(widths: readonly number[], requested: number): number {
  const sorted = [...widths].sort((left, right) => left - right);
  const widest = sorted.at(-1);
  if (widest === undefined) throw new Error("An image entry must list at least one width.");
  return sorted.find((width) => width >= requested) ?? widest;
}

export function variantPath(id: string, width: number): string {
  if (!/^[a-f0-9]{20}$/.test(id)) throw new Error(`Invalid image variant id: ${id}`);
  return `${IMAGE_VARIANT_PREFIX}${id}-${width}.webp`;
}

/**
 * The URL `next/image` renders for `src` at `width`. Sources without variants (external URLs, SVG,
 * GIF, or a file added after the last content step) keep their original URL.
 */
export function resolveImageVariant(map: ImageVariantMap, src: string, width: number): string {
  const entry = Object.hasOwn(map.images, src) ? map.images[src] : undefined;
  if (!entry) return src;
  return variantPath(entry.id, pickVariantWidth(entry.widths, width));
}
