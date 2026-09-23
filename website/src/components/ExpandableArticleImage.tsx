"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";

import styles from "@/styles/article.module.css";

interface ExpandableArticleImageProps {
  alt: string;
  height: number;
  mediaPath: string;
  width: number;
}

export function ExpandableArticleImage({
  alt,
  height,
  mediaPath,
  width,
}: ExpandableArticleImageProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [size, setSize] = useState<"fit" | "original">("fit");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (isOpen && dialog && !dialog.open) dialog.showModal();
  }, [isOpen]);

  function close() {
    dialogRef.current?.close();
  }

  return (
    <>
      <button
        aria-label={alt ? `Enlarge image: ${alt}` : "Enlarge image"}
        className={styles.imageTrigger}
        onClick={() => {
          setSize("fit");
          setIsOpen(true);
        }}
        ref={triggerRef}
        style={{ width: `min(100%, ${width}px)` }}
        type="button"
      >
        <Image
          alt={alt}
          height={height}
          sizes="(max-width: 719px) calc(100vw - 40px), 680px"
          src={mediaPath}
          width={width}
        />
      </button>
      <dialog
        aria-label={alt ? `Expanded image: ${alt}` : "Expanded image"}
        className={styles.imageDialog}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        onClose={() => {
          setIsOpen(false);
          triggerRef.current?.focus();
        }}
        ref={dialogRef}
      >
        {isOpen ? (
          <div className={styles.imageDialogLayout}>
            <div className={styles.imageDialogToolbar}>
              <div aria-label="Image size" className={styles.imageSizeControls} role="group">
                <button aria-pressed={size === "fit"} onClick={() => setSize("fit")} type="button">
                  Fit
                </button>
                <button
                  aria-pressed={size === "original"}
                  onClick={() => setSize("original")}
                  type="button"
                >
                  Original size
                </button>
              </div>
              <button onClick={close} type="button">
                Close
              </button>
            </div>
            <div
              className={`${styles.imageDialogViewport} ${size === "original" ? styles.imageDialogViewportOriginal : ""}`}
            >
              <Image
                alt={alt}
                className={
                  size === "original" ? styles.imageDialogImageOriginal : styles.imageDialogImageFit
                }
                height={height}
                src={mediaPath}
                unoptimized
                width={width}
              />
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
