"use client";

import Image from "next/image";
import type { PhotoSwipeOptions } from "photoswipe";
import { Gallery, Item } from "react-photoswipe-gallery";

import styles from "@/styles/article.module.css";

interface ExpandableArticleImageProps {
  alt: string;
  height: number;
  mediaPath: string;
  width: number;
}

const lightboxOptions = {
  allowPanToNext: false,
  arrowKeys: false,
  arrowNext: false,
  arrowPrev: false,
  bgClickAction: "close",
  bgOpacity: 0.97,
  counter: false,
  doubleTapAction: "zoom",
  imageClickAction: "zoom",
  mainClass: styles.articleLightbox,
  padding: { top: 24, right: 24, bottom: 24, left: 24 },
  tapAction: "close",
  zoom: false,
} satisfies PhotoSwipeOptions;

export function ExpandableArticleImage({
  alt,
  height,
  mediaPath,
  width,
}: ExpandableArticleImageProps) {
  return (
    <Gallery
      onBeforeOpen={(pswp) => {
        pswp.on("initialLayout", () => {
          pswp.element?.setAttribute(
            "aria-label",
            alt ? `Expanded image: ${alt}` : "Expanded image",
          );
        });
      }}
      options={lightboxOptions}
    >
      <Item<HTMLAnchorElement> alt={alt} height={height} original={mediaPath} width={width}>
        {({ ref, open }) => (
          <a
            aria-label={alt ? `Enlarge image: ${alt}` : "Enlarge image"}
            className={styles.imageZoom}
            href={mediaPath}
            onClick={(event) => {
              event.preventDefault();
              open(event);
            }}
            ref={ref}
            style={{ width: `min(100%, ${width}px)` }}
          >
            <Image
              alt={alt}
              height={height}
              sizes="(max-width: 719px) calc(100vw - 40px), 680px"
              src={mediaPath}
              width={width}
            />
          </a>
        )}
      </Item>
    </Gallery>
  );
}
