// The custom `next/image` loader (next.config.ts `images.loaderFile`). It runs at build time for
// server components and in the browser for client components, so it must stay synchronous and tiny.
// The map is written by the content step (`pnpm content:prepare*`), before any Next.js command.
import variantMap from "../../../.generated/images.json";

import { resolveImageVariant, type ImageVariantMap } from "./config";

interface LoaderProps {
  src: string;
  width: number;
  quality?: number;
}

export default function imageLoader({ src, width }: LoaderProps): string {
  return resolveImageVariant(variantMap as ImageVariantMap, src, width);
}
