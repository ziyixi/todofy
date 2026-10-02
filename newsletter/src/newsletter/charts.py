"""Offline static PNG charts, with no template or editorial dependencies.

PNG output is deterministic within a pinned Pillow/FreeType/font environment.
Install fonts-noto-cjk in Docker; NEWSLETTER_CHART_FONT can pin a deployment
font file. macOS uses Hiragino Sans GB when the Linux font is unavailable.
The font path is deployment configuration, never supplied by a draft.
"""

from __future__ import annotations

import decimal
import io
import os
import pathlib
from typing import cast

import PIL.Image as Image
import PIL.ImageDraw as ImageDraw
import PIL.ImageFont as ImageFont

import newsletter.types as types

_INK = "#24332e"
_MUTED = "#64716b"
_GREEN = "#28604e"
_RUST = "#a6573b"
_PAPER = "#ffffff"


def load_font(size: int) -> ImageFont.FreeTypeFont:
    """Load a CJK font, failing closed for an unavailable configured path."""
    configured = os.environ.get("NEWSLETTER_CHART_FONT")
    candidates = (
        [configured]
        if configured
        else [
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
            "/System/Library/Fonts/Hiragino Sans GB.ttc",
            "/System/Library/Fonts/STHeiti Light.ttc",
        ]
    )
    for candidate in candidates:
        if candidate and pathlib.Path(candidate).is_file():
            return ImageFont.truetype(
                candidate, size, layout_engine=ImageFont.Layout.BASIC
            )
    raise ValueError(
        "CHART_FONT_UNAVAILABLE: install fonts-noto-cjk or set "
        "NEWSLETTER_CHART_FONT"
    )


def _wrap(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont,
    width: int,
) -> list[str]:
    """Wrap CJK and long Latin labels without dropping characters."""
    lines: list[str] = []
    for paragraph in text.split("\n"):
        line = ""
        for char in paragraph:
            if line and draw.textlength(line + char, font=font) > width:
                lines.append(line)
                line = char
            else:
                line += char
        lines.append(line)
    return lines


def _lines(
    draw: ImageDraw.ImageDraw,
    lines: list[str],
    xy: tuple[float, float],
    font: ImageFont.FreeTypeFont,
    fill: str = _INK,
    spacing: int = 8,
) -> float:
    x, y = xy
    for line in lines:
        draw.text((x, y), line, font=font, fill=fill)
        y += font.size + spacing
    return y


def _tick(value: decimal.Decimal) -> str:
    if value == 0:
        return "0"
    if -3 <= value.adjusted() <= 6:
        return format(value, ".2f").rstrip("0").rstrip(".")
    return format(value, ".2E")


def chart_metadata(chart: types.Payload) -> str:
    """Describe the measure without repeating units included in its name.

    This is typography only. In particular, the renderer cannot infer whether a
    large effect, percentage or score is good, or invent a comparison baseline.
    """
    metric, unit = chart["metric"].strip(), chart["unit"].strip()
    included = metric == unit or any(
        metric.endswith(f"{left}{unit}{right}")
        for left, right in (("（", "）"), ("(", ")"))
    )
    measure = metric if included else f"{metric}（{unit}）"
    return f"指标：{measure} · 范围：{chart['period']}"


def _draw_bars(
    draw: ImageDraw.ImageDraw,
    values: list[decimal.Decimal | None],
    observed: list[decimal.Decimal],
    label_lines: list[list[str]],
    row_heights: list[float],
    header: float,
    width: int,
    label_font: ImageFont.FreeTypeFont,
    axis_font: ImageFont.FreeTypeFont,
) -> None:
    lower, upper = (
        min(decimal.Decimal(0), min(observed)),
        max(decimal.Decimal(0), max(observed)),
    )
    if upper == lower:
        upper = decimal.Decimal(1)
    left, right = 350, 1150

    def to_x(value: decimal.Decimal) -> float:
        return left + float((value - lower) / (upper - lower)) * (right - left)

    baseline = to_x(decimal.Decimal(0))
    bottom = header + sum(row_heights)
    for index in range(5):
        value = lower + (upper - lower) * decimal.Decimal(index) / 4
        x = to_x(value)
        draw.line((x, header, x, bottom), fill="#e5e8df", width=2)
        label = _tick(value)
        draw.text(
            (
                x - draw.textlength(label, font=axis_font) / 2,
                bottom + 18,
            ),
            label,
            font=axis_font,
            fill=_MUTED,
        )
    draw.line((baseline, header, baseline, bottom), fill=_INK, width=3)
    y = header
    for observed_value, labels, row_height in zip(
        values, label_lines, row_heights, strict=True
    ):
        _lines(draw, labels, (60, y + 15), label_font)
        middle = y + row_height / 2
        if observed_value is None:
            draw.text(
                (left + 20, middle - 19),
                "缺失 · 未作零值",
                font=label_font,
                fill=_MUTED,
            )
        elif observed_value == 0:
            draw.ellipse(
                (baseline - 5, middle - 5, baseline + 5, middle + 5),
                fill=_GREEN,
            )
            draw.text(
                (baseline + 13, middle - 19),
                "0",
                font=label_font,
                fill=_GREEN,
            )
        else:
            x = to_x(observed_value)
            draw.rectangle(
                (
                    min(baseline, x),
                    middle - 20,
                    max(baseline, x),
                    middle + 20,
                ),
                fill=_GREEN if observed_value > 0 else _RUST,
            )
            label = _tick(observed_value)
            label_width = draw.textlength(label, font=axis_font)
            label_x = x + 10 if observed_value > 0 else x - label_width - 10
            label_x = max(left, min(label_x, width - label_width - 24))
            draw.text((label_x, middle - 18), label, font=axis_font, fill=_INK)
        y += row_height


def _draw_line(
    draw: ImageDraw.ImageDraw,
    values: list[decimal.Decimal | None],
    observed: list[decimal.Decimal],
    header: float,
    line_labels: dict[int, list[str]],
    axis_font: ImageFont.FreeTypeFont,
) -> None:
    low, high = min(observed), max(observed)
    if low == high:
        margin = abs(low) / 10 if low else decimal.Decimal(1)
    else:
        margin = (high - low) / 10
    lower, upper = low - margin, high + margin
    left, right, top, bottom = 150, 1190, header + 25, header + 380

    def to_y(value: decimal.Decimal) -> float:
        return bottom - float((value - lower) / (upper - lower)) * (
            bottom - top
        )

    def line_x(index: int) -> float:
        return (
            (left + right) / 2
            if len(values) == 1
            else left + index / (len(values) - 1) * (right - left)
        )

    for index in range(5):
        value = lower + (upper - lower) * decimal.Decimal(index) / 4
        y = to_y(value)
        draw.line((left, y, right, y), fill="#e5e8df", width=2)
        label = _tick(value)
        draw.text(
            (
                left - draw.textlength(label, font=axis_font) - 16,
                y - 18,
            ),
            label,
            font=axis_font,
            fill=_MUTED,
        )
    previous = None
    for index, line_value in enumerate(values):
        x = line_x(index)
        if line_value is None:
            previous = None
            draw.text(
                (x - 26, bottom + 10),
                "缺失",
                font=axis_font,
                fill=_RUST,
            )
        else:
            y = to_y(line_value)
            if previous is not None:
                draw.line((*previous, x, y), fill=_GREEN, width=5)
            draw.ellipse((x - 7, y - 7, x + 7, y + 7), fill=_GREEN)
            previous = (x, y)
        if index in line_labels:
            _lines(
                draw,
                line_labels[index],
                (max(24, min(x - 60, 1110)), bottom + 53),
                axis_font,
                _MUTED,
                4,
            )


def render_chart_png(chart: types.Payload, is_fixture: bool) -> bytes:
    """Render a self-contained figure with the supplied explanation verbatim.

    Editorial context belongs in the image, not only in the surrounding email.
    All text is measured before allocating the canvas; long supplied text grows
    it rather than being clipped or silently shortened. No model or URL is used.
    """
    points = chart["points"]
    if not 1 <= len(points) <= 32:
        raise ValueError("CHART_SIZE_UNSUPPORTED: chart requires 1–32 points")
    values = [
        decimal.Decimal(p["decimal_value"]) if "decimal_value" in p else None
        for p in points
    ]
    observed = [v for v in values if v is not None]
    if not observed or not all(v.is_finite() for v in observed):
        raise ValueError(
            "CHART_VALUES_INVALID: at least one finite value is required"
        )
    width = 1280
    title_font, caption_font, detail_font = (
        load_font(46),
        load_font(36),
        load_font(28),
    )
    label_font, axis_font = (
        (load_font(44), load_font(40))
        if chart["kind"] == "bar"
        else (load_font(30), load_font(26))
    )
    image = Image.new("RGB", (width, 100), _PAPER)
    draw = ImageDraw.Draw(image)
    title_lines = _wrap(
        draw, chart.get("question") or chart["metric"], title_font, 1160
    )
    caption_lines = (
        _wrap(draw, chart["caption"], caption_font, 1160)
        if chart.get("caption")
        else []
    )
    metadata_lines = _wrap(draw, chart_metadata(chart), detail_font, 1160)
    header = 34 + len(title_lines) * (title_font.size + 8) + 18
    if caption_lines:
        header += len(caption_lines) * (caption_font.size + 8) + 18
    header += len(metadata_lines) * (detail_font.size + 8) + 28
    limitations = chart.get("limitations", [])
    if isinstance(limitations, str):
        limitations = [limitations] if limitations else []
    notes = [f"边界：{value}" for value in limitations]
    if chart.get("source_note"):
        notes.append(chart["source_note"])
    footer_lines = [_wrap(draw, note, detail_font, 1160) for note in notes]
    if chart["kind"] == "bar":
        label_lines = [_wrap(draw, p["label"], label_font, 274) for p in points]
        row_heights = [
            max(100, len(lines) * (label_font.size + 8) + 22)
            for lines in label_lines
        ]
        plot_end = header + sum(row_heights) + 100
    elif chart["kind"] == "line":
        label_count = min(6, len(points))
        label_indices = {
            round(index * (len(points) - 1) / max(1, label_count - 1))
            for index in range(label_count)
        }
        line_labels = {
            index: _wrap(draw, points[index]["label"], axis_font, 145)
            for index in label_indices
        }
        label_height = max(len(lines) for lines in line_labels.values()) * (
            axis_font.size + 4
        )
        plot_end = header + max(500, 380 + 53 + label_height + 30)
    else:
        raise ValueError("CHART_KIND_UNSUPPORTED")
    convention = (
        "条形从零开始；缺失不作零值。"
        if chart["kind"] == "bar"
        else "纵轴按数值范围标注；缺失值断线。"
    )
    footer_lines.insert(0, _wrap(draw, convention, detail_font, 1160))
    height = (
        plot_end
        + 20
        + sum(
            len(lines) * (detail_font.size + 8) + 12 for lines in footer_lines
        )
    )
    height += 76 if is_fixture else 28
    # Font sizes passed to load_font are integers; Pillow types them as float.
    image = Image.new("RGB", (width, cast(int, height)), _PAPER)
    draw = ImageDraw.Draw(image)
    y = _lines(draw, title_lines, (60, 34), title_font) + 18
    if caption_lines:
        y = _lines(draw, caption_lines, (60, y), caption_font) + 18
    _lines(draw, metadata_lines, (60, y), detail_font, _MUTED)
    with decimal.localcontext() as context:
        context.prec = 100
        if chart["kind"] == "bar":
            _draw_bars(
                draw,
                values,
                observed,
                label_lines,
                row_heights,
                header,
                width,
                label_font,
                axis_font,
            )
        else:
            _draw_line(draw, values, observed, header, line_labels, axis_font)
    y = plot_end + 20
    draw.line((60, y - 10, width - 60, y - 10), fill="#e5e8df", width=2)
    for lines in footer_lines:
        y = _lines(draw, lines, (60, y), detail_font, _MUTED) + 12
    if is_fixture:
        label = "模拟数据 · 试刊样张"
        # Default text coordinates include font-specific vertical offsets.
        # Anchor the visible glyph bounds, not a guessed offset from the canvas.
        _, _, label_right, label_bottom = draw.textbbox(
            (0, 0), label, font=axis_font
        )
        draw.text(
            (width - label_right - 50, height - label_bottom - 24),
            label,
            font=axis_font,
            fill=_RUST,
        )
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=False, compress_level=9)
    return buffer.getvalue()
