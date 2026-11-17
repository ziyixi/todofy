"""Release columns the reader rebuilds from the same row (manifest ``derived_columns``).

A release may leave out a surrogate identity that is a pure function of other columns of
its own row. The manifest then names the formula, ``{"fundamentals": {"fact_id":
"sha256-json-v1"}}``, and the reader recomputes the column exactly as the collector wrote
it. A stored column always wins. A formula id never changes meaning: a new rule needs a
new id, and an id this SDK does not know is refused.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass

import pyarrow as pa
import pyarrow.compute as pc

# fact_id identity fields, in the collector's order (quant_collector/fundamentals.py).
FACT_ID_FIELDS = (
    "cik",
    "taxonomy",
    "tag",
    "unit",
    "period_start",
    "period_end",
    "accession",
)
# news version_id fields (quant_collector/news_metadata.py).
VERSION_ID_FIELDS = (
    "event_id",
    "provider_updated_at",
    "headline_sha256",
    "summary_sha256",
)
# Text json.dumps writes differently from itself: a quote, a backslash, a control
# character or (ensure_ascii) any non-ASCII character.
_JSON_ESCAPED = r'["\\\x00-\x1f]|[^\x00-\x7f]'


@dataclass(frozen=True)
class Formula:
    """One derived column: the family and column it rebuilds and the row fields it reads."""

    family: str
    column: str
    inputs: tuple[str, ...]
    compute: Callable[[pa.Table], pa.Array]


def _strings(table: pa.Table, names: tuple[str, ...]) -> list[pa.Array]:
    return [pc.cast(table.column(name).combine_chunks(), pa.string()) for name in names]


def _sha256_hex(texts: list[str]) -> pa.Array:
    sha = hashlib.sha256
    return pa.array([sha(text.encode()).hexdigest() for text in texts], pa.string())


def fact_ids(table: pa.Table) -> pa.Array:
    """``sha256-json-v1``: SHA-256 of ``json.dumps([cik, taxonomy, tag, unit,
    period_start, period_end, accession], separators=(",", ":"))``.

    Rows whose fields need no JSON escaping are joined directly (the same bytes);
    the others, and rows with a null field, go through ``json.dumps`` itself.
    """
    columns = _strings(table, FACT_ID_FIELDS)
    if not table.num_rows:
        return pa.array([], pa.string())
    slow = pc.or_(
        pc.is_null(columns[0]),
        pc.fill_null(pc.match_substring_regex(columns[0], _JSON_ESCAPED), True),
    )
    for column in columns[1:]:
        slow = pc.or_(
            slow,
            pc.or_(
                pc.is_null(column),
                pc.fill_null(pc.match_substring_regex(column, _JSON_ESCAPED), True),
            ),
        )
    joined = pc.binary_join_element_wise(*columns, '","')
    texts = pc.binary_join_element_wise(
        pa.scalar('["'), joined, pa.scalar('"]'), ""
    ).to_pylist()
    for row in pc.indices_nonzero(slow).to_pylist():
        values = [column[row].as_py() for column in columns]
        texts[row] = json.dumps(values, separators=(",", ":"))
    return _sha256_hex(texts)


def version_ids(table: pa.Table) -> pa.Array:
    """``sha256-pipe-v1``: SHA-256 of ``"|".join((event_id, provider_updated_at,
    headline_sha256, summary_sha256))``. A null field has no value under this rule."""
    columns = _strings(table, VERSION_ID_FIELDS)
    if any(column.null_count for column in columns):
        raise ValueError("news_versions version_id fields must not be null")
    return _sha256_hex(pc.binary_join_element_wise(*columns, "|").to_pylist())


FORMULAS: dict[str, Formula] = {
    "sha256-json-v1": Formula("fundamentals", "fact_id", FACT_ID_FIELDS, fact_ids),
    "sha256-pipe-v1": Formula(
        "news_versions", "version_id", VERSION_ID_FIELDS, version_ids
    ),
}
