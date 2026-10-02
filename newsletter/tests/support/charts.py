"""Shared offline charts builders and fakes."""

from __future__ import annotations

from typing import TypedDict

import PIL.Image as Image
import PIL.ImageDraw as ImageDraw
import PIL.ImageFont as ImageFont
import pytest


class DrawRecord(TypedDict):
    """One rendered label and the canvas on which it was measured."""

    text: str
    bbox: tuple[float, float, float, float]
    image_size: tuple[int, int]


def record_draw_text(monkeypatch: pytest.MonkeyPatch) -> list[DrawRecord]:
    """Observe rendered text bounds without storing PNG goldens."""
    records: list[DrawRecord] = []
    original = ImageDraw.ImageDraw.text

    def draw_text(
        draw: ImageDraw.ImageDraw,
        xy: tuple[float, float],
        text: str,
        *,
        font: ImageFont.FreeTypeFont,
        fill: str,
    ) -> None:
        records.append(
            {
                "text": text,
                "bbox": draw.textbbox(xy, text, font=font),
                # Pillow exposes the drawing canvas only on its private field.
                "image_size": draw._image.size,  # noqa: SLF001
            }
        )
        original(draw, xy, text, font=font, fill=fill)

    monkeypatch.setattr(ImageDraw.ImageDraw, "text", draw_text)
    return records


def compact(text: str) -> str:
    """Normalize whitespace when asserting rendered multilingual labels."""
    return "".join(text.split())


def final_text(
    records: list[DrawRecord], image: Image.Image
) -> list[DrawRecord]:
    """Select labels drawn on the final canvas, excluding measurement passes."""
    return [record for record in records if record["image_size"] == image.size]
