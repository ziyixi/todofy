"""Vectorized event counts and source coverage per decision window.

Window j of the computed sessions holds clocks in (b[j], b[j+1]], where b are the
06:00 New York decision instants of consecutive sessions; the last window has no
decision unless a next session is known. ``tests/reference.py`` is the plain-loop
definition these arrays must reproduce exactly.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from . import clocks
from .clocks import GRACE_NS, NAT, NEVER
from .constants import (
    NOT_LISTED_CODES,
    SOURCE_CONTRACTS,
    STORY_WINDOW,
    VETO_CODES,
    SourceContract,
)

STORY_NS = int(STORY_WINDOW / timedelta(microseconds=1)) * 1000
ROLLING_WINDOWS = (5, 21, 63)
RANK_WINDOW = 21
WARMUP_SESSIONS = max(ROLLING_WINDOWS) - 1
LABELS = (
    "unknown",
    "checked",
    "empty",
    "read_complete",
    "mapping_missing",
    "not_listed",
    "partial",
)
UNKNOWN, CHECKED, EMPTY, READ_COMPLETE = 0, 1, 2, 3
BASES = ("", "observed", "reconstructed")
COUNTABLE, VETO, NOT_LISTED, SOFT, ERROR, NO_CHECK = range(6)
_COUNTABLE_STATUSES = ("checked", "empty", "not_changed")


@dataclass(frozen=True)
class EventSpec:
    """One count feature: a source plus filters on version attributes.

    ``where`` maps a column to its allowed values (``form`` ignores an "/A" suffix) and
    ``items_any`` keeps filings listing any of these SEC items. A version without a value
    inherits its chain's latest earlier value. public_reconstructed filters by the latest
    version, observed_content by the version selected at each decision. Observations
    that lack a filtered column are refused (CAPABILITY_MISSING), except by the default
    ``sec`` form filter, which counts every filing of bundles saved before ``form``.
    """

    name: str
    source: str
    where: Mapping[str, frozenset[str]] = field(default_factory=dict)
    items_any: frozenset[str] = frozenset()
    kinds_any: frozenset[str] = frozenset()

    def __post_init__(self) -> None:
        def values(allowed: Any) -> frozenset[str]:
            if isinstance(allowed, str) or not all(
                isinstance(value, str) for value in allowed
            ):
                raise ValueError(f"{self.name}: filters need collections of strings")
            return frozenset(allowed)

        if not (isinstance(self.name, str) and self.name):
            raise ValueError("EventSpec needs a name")
        where = {str(column): values(allowed) for column, allowed in self.where.items()}
        object.__setattr__(self, "where", where)
        object.__setattr__(self, "items_any", values(self.items_any))
        object.__setattr__(self, "kinds_any", values(self.kinds_any))

    def columns(self) -> list[str]:
        """Observation columns the filters read."""
        return [*self.where, *(["items"] if self.items_any else [])]

    def record(self) -> dict[str, Any]:
        """JSON form for run records."""
        payload: dict[str, Any] = {
            "name": self.name,
            "source": self.source,
            "where": {column: sorted(values) for column, values in self.where.items()},
            "items_any": sorted(self.items_any),
        }
        if self.kinds_any:
            payload["kinds_any"] = sorted(self.kinds_any)
        return payload


def default_specs() -> tuple[EventSpec, ...]:
    """One specification per count source, named after it."""
    return tuple(
        EventSpec(
            name,
            name,
            {} if contract.count_forms is None else {"form": contract.count_forms},
        )
        for name, contract in SOURCE_CONTRACTS.items()
        if contract.counts
    )


def story_keys(news_versions: pd.DataFrame | None) -> pd.DataFrame | None:
    """(source, event_id) -> story key of the article's earliest saved text version."""
    if (
        news_versions is None
        or news_versions.empty
        or not {"event_id", "story_key"}.issubset(news_versions.columns)
    ):
        return None
    frame = news_versions
    if "provider_updated_at" in frame.columns:
        frame = frame.sort_values(
            ["provider_updated_at", "story_key"], kind="stable", na_position="last"
        )
    story = frame["story_key"].to_numpy(dtype=object)
    event = frame["event_id"].to_numpy(dtype=object)
    source = (
        frame["source"].to_numpy(dtype=object)
        if "source" in frame.columns
        else np.full(len(frame), None, dtype=object)
    )
    keep = np.fromiter(
        (
            isinstance(s, str) and s != "" and e is not None
            for s, e in zip(story, event)
        ),
        bool,
        len(frame),
    )
    keys = pd.DataFrame(
        {
            "source": [
                value if isinstance(value, str) and value else "alpaca_news"
                for value in source[keep]
            ],
            "event_id": [str(value) for value in event[keep]],
            "story_key": story[keep],
        }
    )
    return keys.drop_duplicates(["source", "event_id"], keep="first")


def _present(cells: np.ndarray) -> np.ndarray:
    return np.fromiter(
        (isinstance(value, str) and value != "" for value in cells), bool, len(cells)
    )


@dataclass
class _Rows:
    """Count-source observation versions sorted by (source, event_uid, sequence)."""

    frame: pd.DataFrame
    chain: np.ndarray  # chain number; one source's chains are contiguous
    seq: np.ndarray
    public: np.ndarray
    invalid: np.ndarray
    story: np.ndarray
    ranges: dict[str, tuple[int, int]]
    pair_row: np.ndarray  # (row, asset) links whose asset is computed
    pair_asset: np.ndarray
    pair_clock: np.ndarray  # association clock (observed_content only)


def _sequences(frame: pd.DataFrame) -> np.ndarray:
    message = "Observation requires a nonnegative observation_sequence"
    if "observation_sequence" not in frame.columns:
        raise ValueError(message)
    column = frame["observation_sequence"]
    if pd.api.types.is_bool_dtype(column) or column.isna().any():
        raise ValueError(message)
    if pd.api.types.is_object_dtype(column):
        if not all(
            isinstance(value, (int, np.integer)) and not isinstance(value, bool)
            for value in column
        ):
            raise ValueError(message)
    elif not pd.api.types.is_integer_dtype(column):
        raise ValueError(message)
    values = column.to_numpy(dtype=np.int64)
    if (values < 0).any():
        raise ValueError(message)
    return values


def _rows(
    observations: pd.DataFrame,
    assets: pd.Index,
    sources: set[str],
    policy: str,
    zones: Mapping[str, str],
    stories: pd.DataFrame | None,
) -> tuple[_Rows | None, dict[str, int]]:
    """Validate and sort the rows of ``sources``; count rows of unknown sources."""
    skipped: dict[str, int] = {}
    if observations is None or observations.empty:
        return None, skipped
    if "source" in observations.columns:
        codes, uniques = pd.factorize(observations["source"])
    else:
        codes, uniques = np.full(len(observations), -1), pd.Index([])
    tally = np.bincount(codes[codes >= 0], minlength=len(uniques))
    for value, rows in zip(uniques, tally):
        if not (isinstance(value, str) and value in SOURCE_CONTRACTS) and rows:
            name = value if isinstance(value, str) and value else "(missing)"
            skipped[name] = skipped.get(name, 0) + int(rows)
    if (codes < 0).any():
        skipped["(missing)"] = skipped.get("(missing)", 0) + int((codes < 0).sum())
    wanted = np.array([value in sources for value in uniques] + [False], dtype=bool)
    frame = observations[wanted[codes]]
    if frame.empty:
        return None, skipped
    if (
        "event_uid" not in frame.columns
        or (frame["event_uid"].isna() | (frame["event_uid"].astype(str) == "")).any()
    ):
        raise ValueError("Observation requires a logical event_uid")
    seq = _sequences(frame)
    source_code, source_names = pd.factorize(frame["source"], sort=True)
    uid_code, _ = pd.factorize(frame["event_uid"].astype(str), sort=True)
    keys = pd.DataFrame({"s": source_code, "u": uid_code, "q": seq})
    if keys.duplicated().any():
        raise ValueError("Duplicate observation_sequence for one logical event")
    order = np.lexsort((seq, uid_code, source_code))
    frame = frame.iloc[order].reset_index(drop=True)
    seq, source_code, uid_code = seq[order], source_code[order], uid_code[order]
    chain = (
        np.cumsum(
            np.r_[
                True,
                (source_code[1:] != source_code[:-1]) | (uid_code[1:] != uid_code[:-1]),
            ]
        )
        - 1
    )
    ranges = {
        str(name): (
            int(np.searchsorted(source_code, code, "left")),
            int(np.searchsorted(source_code, code, "right")),
        )
        for code, name in enumerate(source_names)
    }
    public, invalid = clocks.public_clocks(frame, zones)
    links = (
        frame["asset_ids"]
        if "asset_ids" in frame.columns
        else pd.Series(None, index=frame.index, dtype=object)
    )
    exploded = pd.Series(links.to_numpy(dtype=object), index=np.arange(len(frame)))
    exploded = exploded.explode().dropna()
    asset_code = assets.get_indexer(exploded.astype(str))
    pairs = pd.DataFrame(
        {
            "row": exploded.index.to_numpy()[asset_code >= 0],
            "asset": asset_code[asset_code >= 0],
        }
    ).drop_duplicates()
    pair_row = pairs["row"].to_numpy(dtype=np.int64)
    pair_asset = pairs["asset"].to_numpy(dtype=np.int64)
    pair_clock = np.full(len(pair_row), NAT, dtype=np.int64)
    if policy == "observed_content" and len(pair_row):
        cells = (
            frame["asset_first_seen_at"].to_numpy(dtype=object)
            if "asset_first_seen_at" in frame.columns
            else np.full(len(frame), None, dtype=object)
        )
        names = assets.to_numpy(dtype=object)
        raw = np.empty(len(pair_row), dtype=object)
        last, current = -1, {}
        for position, (row, asset) in enumerate(
            zip(pair_row.tolist(), pair_asset.tolist())
        ):
            if row != last:
                current, last = clocks.mapping(cells[row]), row
            raw[position] = current.get(names[asset])
        pair_clock = clocks.instants(raw)
    return (
        _Rows(
            frame=frame,
            chain=chain,
            seq=seq,
            public=public,
            invalid=invalid,
            story=_row_stories(frame, stories),
            ranges=ranges,
            pair_row=pair_row,
            pair_asset=pair_asset,
            pair_clock=pair_clock,
        ),
        skipped,
    )


def _row_stories(frame: pd.DataFrame, stories: pd.DataFrame | None) -> np.ndarray:
    """A version's own story key, else its article's earliest text version's key."""
    result = np.full(len(frame), None, dtype=object)
    if stories is not None and not stories.empty and "event_id" in frame.columns:
        event = frame["event_id"].to_numpy(dtype=object)
        lookup = pd.Series(
            stories["story_key"].to_numpy(dtype=object),
            index=pd.MultiIndex.from_arrays([stories["source"], stories["event_id"]]),
        )
        found = lookup.reindex(
            pd.MultiIndex.from_arrays(
                [frame["source"].astype(str), [str(value) for value in event]]
            )
        ).to_numpy(dtype=object)
        known = _present(event) & np.fromiter(
            (isinstance(value, str) for value in found), bool, len(found)
        )
        result[known] = found[known]
    if "story_key" in frame.columns:
        own = frame["story_key"].to_numpy(dtype=object)
        present = _present(own)
        result[present] = own[present]
    return result


def _carried(frame: pd.DataFrame, column: str, chain: np.ndarray) -> pd.Series:
    cells = frame[column].to_numpy(dtype=object)
    values = pd.Series(np.where(_present(cells), cells, None), dtype=object)
    return values.groupby(chain).ffill()


def _carried_kinds(frame: pd.DataFrame, chain: np.ndarray) -> list[tuple[str, ...]]:
    """Carry forward ``event_kinds`` per observation chain, or classify from form/items."""
    if "event_kinds" in frame.columns:
        raw_cells = frame["event_kinds"].to_numpy(dtype=object)
        out: list[tuple[str, ...]] = []
        last_chain = -1
        current: tuple[str, ...] = ()
        for ch, cell in zip(chain.tolist(), raw_cells):
            if ch != last_chain:
                last_chain = ch
                current = ()
            if isinstance(cell, (list, tuple, np.ndarray)):
                current = tuple(str(x) for x in cell if x is not None and str(x) != "")
            out.append(current)
        return out
    from .sec_events import classify_sec_filing

    forms = _carried(frame, "form", chain).to_numpy(dtype=object)
    items = (
        _carried(frame, "items", chain).to_numpy(dtype=object)
        if "items" in frame.columns
        else np.full(len(frame), "", dtype=object)
    )
    return [tuple(classify_sec_filing(f, it)) for f, it in zip(forms, items)]


def _passes(frame: pd.DataFrame, chain: np.ndarray, spec: EventSpec) -> np.ndarray:
    """Whether each version matches the specification's attribute filters."""
    result = np.ones(len(frame), dtype=bool)
    absent = [column for column in spec.columns() if column not in frame.columns]
    if (
        spec.kinds_any
        and "event_kinds" not in frame.columns
        and "form" not in frame.columns
    ):
        absent.append("event_kinds")
    if absent and spec not in default_specs():
        raise ValueError(
            f"CAPABILITY_MISSING: {spec.name} filters on {absent}, "
            "which these observations lack"
        )
    for column, allowed in spec.where.items():
        if column in frame.columns:
            values = _carried(frame, column, chain)
            if column == "form":
                values = values.str.removesuffix("/A")
            result &= values.isin(list(allowed)).to_numpy()
    if spec.items_any and "items" in frame.columns:
        result &= (
            _carried(frame, "items", chain)
            .map(
                lambda value: (
                    isinstance(value, str)
                    and any(item.strip() in spec.items_any for item in value.split(","))
                )
            )
            .to_numpy(dtype=bool)
        )
    if spec.kinds_any:
        carried_kinds = _carried_kinds(frame, chain)
        result &= np.fromiter(
            (any(k in spec.kinds_any for k in kinds) for kinds in carried_kinds),
            dtype=bool,
            count=len(frame),
        )
    return result


def _expand(starts: np.ndarray, counts: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Ragged expansion: (owner, item) for items starts[i]..starts[i]+counts[i]-1."""
    owner = np.repeat(np.arange(len(starts)), counts)
    offsets = np.arange(int(counts.sum())) - np.repeat(
        np.cumsum(counts) - counts, counts
    )
    return owner, np.repeat(starts, counts) + offsets


def _mark(
    shape: tuple[int, int], asset: np.ndarray, first: np.ndarray, last: np.ndarray
) -> np.ndarray:
    """Windows first..last (inclusive, clipped) of each asset."""
    first, last = np.maximum(first, 0), np.minimum(last, shape[1] - 1)
    keep = first <= last
    diff = np.zeros((shape[0], shape[1] + 1), dtype=np.int64)
    np.add.at(diff, (asset[keep], first[keep]), 1)
    np.add.at(diff, (asset[keep], last[keep] + 1), -1)
    return np.cumsum(diff, axis=1)[:, : shape[1]] > 0


def _decisions_in(
    b: np.ndarray, low: np.ndarray, high: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Windows whose decision b[j+1] lies in [low, high)."""
    return np.searchsorted(b, low, "left") - 1, np.searchsorted(b, high, "left") - 2


def _first_of_story(
    asset: np.ndarray, story: np.ndarray, instant: np.ndarray, uid: np.ndarray
) -> np.ndarray:
    """Per (asset, story), keep the first entry and each one STORY_WINDOW after the
    last kept one (entries ordered by instant, then uid); no story: always kept."""
    kept = np.fromiter((value is None for value in story), bool, len(story))
    rows = np.flatnonzero(~kept)
    if not rows.size:
        return kept
    group, _ = pd.factorize(pd.MultiIndex.from_arrays([asset[rows], story[rows]]))
    uid_rank, _ = pd.factorize(uid[rows], sort=True)
    order = np.lexsort((uid_rank, instant[rows], group))
    group, times = group[order], instant[rows][order]
    values = np.unique(np.concatenate([times, times + STORY_NS]))
    width = len(values) + 1
    key = group * width + np.searchsorted(values, times)
    target = group * width + np.searchsorted(values, times + STORY_NS)
    following = np.searchsorted(key, target, "left")
    following[following >= len(key)] = -1
    following[(following >= 0) & (group[np.maximum(following, 0)] != group)] = -1
    keep = np.zeros(len(order), dtype=bool)
    current = np.flatnonzero(np.r_[True, group[1:] != group[:-1]])
    while current.size:
        keep[current] = True
        current = following[current]
        current = current[current >= 0]
    kept[rows[order]] = keep
    return kept


def _midnight(ordinal: int, zone: ZoneInfo) -> int:
    instant = pd.Timestamp(datetime.combine(date.fromordinal(ordinal), time(), zone))
    return int(instant.tz_convert("UTC").as_unit("ns").value)


@dataclass
class EventMatrices:
    counts: np.ndarray  # int64 [assets, decided windows]
    clock_missing: np.ndarray
    public_missing: np.ndarray
    undatable: int = 0


def _reconstructed(
    rows: _Rows,
    span: tuple[int, int],
    passes: np.ndarray,
    b: np.ndarray,
    shape: tuple[int, int],
    zone: ZoneInfo,
    selected: int,
) -> EventMatrices:
    """Links of each chain's latest version, placed at its earliest public clock.

    Undatable chains (no clock, no date) are counted when they link a selected asset.
    """
    low, high = span
    chain = rows.chain[low:high]
    starts = np.flatnonzero(np.r_[True, chain[1:] != chain[:-1]])
    latest = np.r_[starts[1:], high - low] - 1
    public = rows.public[low:high]
    first = np.minimum.reduceat(np.where(public == NAT, NEVER, public), starts)
    inside = (rows.pair_row >= low) & (rows.pair_row < high)
    pair_row, asset = rows.pair_row[inside] - low, rows.pair_asset[inside]
    owner = np.searchsorted(starts, pair_row, "right") - 1
    chosen = (pair_row == latest[owner]) & passes[latest][owner]
    owner, asset = owner[chosen], asset[chosen]
    counts = np.zeros(shape, dtype=np.int64)
    timed = first[owner] != NEVER
    if timed.any():
        uid = (
            rows.frame["event_uid"].astype(str).to_numpy(dtype=object)[low:high][latest]
        )
        kept = _first_of_story(
            asset[timed],
            rows.story[low:high][latest][owner[timed]],
            first[owner[timed]],
            uid[owner[timed]],
        )
        window = np.searchsorted(b, first[owner[timed]][kept], "left") - 1
        valid = (window >= 0) & (window < shape[1])
        np.add.at(counts, (asset[timed][kept][valid], window[valid]), 1)
    missing = np.zeros(shape, dtype=bool)
    undatable = 0
    if (~timed).any():
        chains = np.unique(owner[~timed])
        ordinal = np.zeros(len(starts), dtype=np.int64)
        ordinal[chains] = clocks.date_ordinals(
            rows.frame.iloc[low + latest[chains]], ("event_date", "filing_date")
        )
        lost = ~timed & (ordinal[owner] == 0) & (asset < selected)
        undatable = len(np.unique(owner[lost]))
        untimed = ~timed & (ordinal[owner] != 0)
        days = ordinal[owner[untimed]]
        start = clocks.map_unique(days, lambda value: _midnight(int(value), zone))
        end = clocks.map_unique(days + 1, lambda value: _midnight(int(value), zone))
        missing = _mark(
            shape,
            asset[untimed],
            np.searchsorted(b, start, "left") - 1,
            np.searchsorted(b, end, "left") - 1,
        )
    return EventMatrices(counts, missing, np.zeros(shape, dtype=bool), undatable)


def _observed(
    rows: _Rows,
    span: tuple[int, int],
    passes: np.ndarray,
    b: np.ndarray,
    shape: tuple[int, int],
) -> EventMatrices:
    """Version chains with capture-bounded clocks and association times."""
    low, high = span
    frame = rows.frame.iloc[low:high]
    chain = rows.chain[low:high] - rows.chain[low]
    seq, public = rows.seq[low:high], rows.public[low:high]
    starts = np.flatnonzero(np.r_[True, chain[1:] != chain[:-1]])
    kept_chain = np.logical_or.reduceat(passes, starts)
    keep = kept_chain[chain]
    captures = tuple(
        clocks.instants(frame[name].to_numpy(dtype=object))
        if name in frame.columns
        else np.full(len(frame), NAT, dtype=np.int64)
        for name in ("content_first_seen_at", "observation_recorded_at")
    )
    available = clocks.available_at(
        public, rows.invalid[low:high], "observed_content", captures
    )
    recorded = captures[1]
    inside = (rows.pair_row >= low) & (rows.pair_row < high)
    pair_row, pair_asset = rows.pair_row[inside] - low, rows.pair_asset[inside]
    pair_clock = rows.pair_clock[inside]
    linked = keep[pair_row]
    pair_row, pair_asset, pair_clock = (
        pair_row[linked],
        pair_asset[linked],
        pair_clock[linked],
    )
    reach = available[pair_row]
    association = np.where(
        (pair_clock != NAT) & (reach != NAT),
        np.maximum(reach, pair_clock - GRACE_NS),
        NAT,
    )
    pair_start = np.searchsorted(pair_row, np.arange(len(frame)), "left")
    pair_count = np.searchsorted(pair_row, np.arange(len(frame)), "right") - pair_start
    counts = np.zeros(shape, dtype=np.int64)
    missing = np.zeros(shape, dtype=bool)
    # The selected version at a decision is the highest sequence available by then.
    timed = np.flatnonzero(keep & (available != NAT))
    timed = timed[np.lexsort((seq[timed], available[timed], chain[timed]))]
    owner = chain[timed]
    running = pd.Series(seq[timed]).groupby(owner).cummax().to_numpy()
    previous = np.r_[-1, running[:-1]]
    previous[np.r_[True, owner[1:] != owner[:-1]]] = -1
    segment = timed[seq[timed] > previous]
    seg_chain, seg_low = chain[segment], available[segment]
    seg_high = np.r_[seg_low[1:], NEVER]
    seg_high[np.r_[seg_chain[1:] != seg_chain[:-1], True]] = NEVER
    which, pair = _expand(pair_start[segment], pair_count[segment])
    version, asset, reached = segment[which], pair_asset[pair], association[pair]
    counting = passes[version]
    visible = counting & (reached != NAT)
    lows = np.maximum(seg_low[which], reached)[visible]
    highs = seg_high[which][visible]
    open_ = lows < highs
    vis_chain = seg_chain[which][visible][open_]
    vis_asset, vis_low, vis_high = asset[visible][open_], lows[open_], highs[open_]
    vis_public_missing = (public[version] == NAT)[visible][open_]
    unknown = counting & (reached == NAT)
    marks = [
        (
            asset[unknown],
            *_decisions_in(b, seg_low[which][unknown], seg_high[which][unknown]),
        )
    ]
    # A later version without a capture clock leaves the decision unresolved until a
    # still later version becomes available.
    blind = np.flatnonzero(keep & (available == NAT))
    if blind.size:
        later = pd.Series(np.where(available != NAT, available, NEVER)[::-1])
        suffix = later.groupby(chain[::-1]).cummin().to_numpy()[::-1]
        after = np.r_[suffix[1:], NEVER]
        after[np.r_[chain[1:] != chain[:-1], True]] = NEVER
        members = pd.DataFrame({"chain": chain[pair_row], "asset": pair_asset})
        members = members.drop_duplicates().sort_values(["chain", "asset"])
        member_chain = members["chain"].to_numpy()
        member_asset = members["asset"].to_numpy()
        lo = np.searchsorted(member_chain, chain[blind], "left")
        hi = np.searchsorted(member_chain, chain[blind], "right")
        which_blind, member = _expand(lo, hi - lo)
        start = np.where(recorded[blind] != NAT, recorded[blind] - GRACE_NS, NAT)[
            which_blind
        ]
        marks.append(
            (member_asset[member], *_decisions_in(b, start, after[blind][which_blind]))
        )
    for asset_marks, first_window, last_window in marks:
        missing |= _mark(shape, asset_marks, first_window, last_window)
    public_missing = _mark(
        shape,
        vis_asset[vis_public_missing],
        *_decisions_in(b, vis_low[vis_public_missing], vis_high[vis_public_missing]),
    )
    # An event counts once, in the window of its first known association clock, when
    # it is linked and visible at that window's decision (one per story and 72 h).
    width = shape[0]
    known = (
        pd.Series(np.where(association != NAT, association, NEVER))
        .groupby(chain[pair_row] * width + pair_asset)
        .min()
    )
    known = known[known != NEVER]
    entry_key = known.index.to_numpy(dtype=np.int64)
    entry_first = known.to_numpy(dtype=np.int64)
    entry_chain, entry_asset = entry_key // width, entry_key % width
    window = np.searchsorted(b, entry_first, "left") - 1
    valid = (window >= 0) & (window < shape[1])
    decision = np.where(
        valid, b[np.minimum(np.maximum(window + 1, 0), len(b) - 1)], NAT
    )
    intervals = pd.DataFrame(
        {"key": vis_chain * width + vis_asset, "low": vis_low, "high": vis_high}
    )
    probe = pd.DataFrame({"key": entry_key[valid], "entry": np.flatnonzero(valid)})
    probe["decision"] = decision[valid]
    joined = probe.merge(intervals, on="key")
    hit = joined[
        (joined["low"] <= joined["decision"]) & (joined["decision"] < joined["high"])
    ]
    seen = np.zeros(len(entry_key), dtype=bool)
    seen[hit["entry"].to_numpy(dtype=np.int64)] = True
    latest = np.r_[starts[1:], len(frame)] - 1
    story = rows.story[low:high][latest][entry_chain]
    uid = frame["event_uid"].astype(str).to_numpy(dtype=object)[latest][entry_chain]
    counted = _story_counted(
        seen, entry_key, entry_asset, entry_first, decision, story, uid, intervals
    )
    np.add.at(counts, (entry_asset[counted], window[counted]), 1)
    return EventMatrices(counts, missing, public_missing)


def _story_counted(
    seen: np.ndarray,
    key: np.ndarray,
    asset: np.ndarray,
    first: np.ndarray,
    decision: np.ndarray,
    story: np.ndarray,
    uid: np.ndarray,
    intervals: pd.DataFrame,
) -> np.ndarray:
    """observed_content story dedupe: an event visible at its window's decision counts
    unless an earlier visible event of its story and security anchors it (72 h chain).
    Visibility changes over time, so shared stories are evaluated per decision."""
    counted = seen.copy()
    storied = np.flatnonzero([value is not None for value in story])
    if not storied.size:
        return counted
    group, _ = pd.factorize(pd.MultiIndex.from_arrays([asset[storied], story[storied]]))
    shared = np.bincount(group)[group] > 1
    spans: dict[int, list[tuple[int, int]]] = {}
    wanted = set(key[storied[shared]].tolist())
    for item, low, high in intervals.itertuples(index=False):
        if item in wanted:
            spans.setdefault(item, []).append((low, high))
    members_of: dict[int, list[int]] = {}
    for entry, code in zip(storied[shared].tolist(), group[shared].tolist()):
        members_of.setdefault(code, []).append(entry)
    for members in members_of.values():
        ordered = sorted(members, key=lambda item: (first[item], uid[item]))
        for entry in members:
            if not seen[entry]:
                continue
            moment, anchor, kept = decision[entry], None, False
            for other in ordered:
                if not any(
                    low <= moment < high for low, high in spans.get(key[other], ())
                ):
                    continue
                if anchor is None or first[other] >= anchor + STORY_NS:
                    anchor, kept = first[other], other == entry
                if other == entry:
                    break
            counted[entry] = kept
    return counted


def event_matrices(
    observations: pd.DataFrame,
    *,
    assets: Sequence[str],
    boundaries: np.ndarray,
    policy: str,
    zones: Mapping[str, str],
    news_versions: pd.DataFrame | None = None,
    specs: Sequence[EventSpec] | None = None,
    selected: int | None = None,
) -> tuple[dict[str, EventMatrices], dict[str, int]]:
    """Per specification, counts and clock flags of each (asset, decided window).

    ``boundaries`` are the finite decision instants b[0..W]; window j is (b[j], b[j+1]].
    Rows of sources the SDK does not read are skipped and counted, never fatal.
    Undatable events count only those linked to the first ``selected`` assets (all
    by default).
    """
    specs = default_specs() if specs is None else tuple(specs)
    selected = len(assets) if selected is None else selected
    if len({spec.name for spec in specs}) != len(specs):
        raise ValueError("EventSpec names must be unique")
    for spec in specs:
        contract = SOURCE_CONTRACTS.get(spec.source)
        if contract is None or not contract.counts:
            raise ValueError(f"{spec.source} has no count contract")
    index = pd.Index([str(asset) for asset in assets])
    shape = (len(index), max(len(boundaries) - 1, 0))
    rows, skipped = _rows(
        observations,
        index,
        {spec.source for spec in specs},
        policy,
        zones,
        story_keys(news_versions),
    )
    result = {}
    for spec in specs:
        span = rows.ranges.get(spec.source) if rows is not None else None
        if rows is None or span is None or shape[1] == 0:
            empty = np.zeros(shape, dtype=bool)
            result[spec.name] = EventMatrices(
                np.zeros(shape, dtype=np.int64), empty, empty
            )
            continue
        passes = _passes(
            rows.frame.iloc[span[0] : span[1]], rows.chain[span[0] : span[1]], spec
        )
        if policy == "public_reconstructed":
            zone = clocks.source_zone(spec.source, zones)
            result[spec.name] = _reconstructed(
                rows, span, passes, boundaries, shape, zone, selected
            )
        else:
            result[spec.name] = _observed(rows, span, passes, boundaries, shape)
    return result, dict(sorted(skipped.items()))


# --- coverage ------------------------------------------------------------------------


@dataclass
class _Checks:
    asset: np.ndarray
    checked: np.ndarray
    start: np.ndarray  # date ordinals, 0 = unbounded
    end: np.ndarray
    kind: np.ndarray  # COUNTABLE .. ERROR
    label: np.ndarray  # code into the vocabulary
    status: np.ndarray  # code of the raw status string


def _ordinals(cells: np.ndarray) -> np.ndarray:
    def ordinal(value: Any) -> int:
        if isinstance(value, date) and not isinstance(value, datetime):
            return value.toordinal()
        return clocks.day_str(str(value)).toordinal()

    cleaned = np.where(
        np.fromiter(
            (isinstance(value, str) and value == "" for value in cells),
            bool,
            len(cells),
        ),
        None,
        cells,
    )
    result = clocks.map_unique(cleaned, ordinal)
    result[result == NAT] = 0
    return result


def _classify(
    status: np.ndarray, code: np.ndarray, contract: SourceContract
) -> tuple[np.ndarray, np.ndarray]:
    """Coverage class and label of each check (see constants.VETO_CODES)."""
    veto = np.isin(code, list(VETO_CODES))
    absent = ~veto & np.isin(code, list(NOT_LISTED_CODES))
    rest = ~veto & ~absent
    usual = np.isin(status, _COUNTABLE_STATUSES)
    plain = rest & usual & (code == "")
    partial = rest & ~plain & ((status == "partial") | usual)
    complete = partial & np.isin(code, list(contract.read_complete_codes))
    limited = partial & ~complete & np.isin(code, list(contract.countable_partial))
    soft = partial & ~complete & ~limited
    other = rest & ~plain & ~partial
    kind = np.where(other & (status == "error"), ERROR, SOFT)
    kind = np.where(plain | complete | limited, COUNTABLE, kind)
    kind = np.where(veto, VETO, np.where(absent, NOT_LISTED, kind))
    label = np.where(status == "", "unknown", status).astype(object)
    label[plain] = np.where(status[plain] == "empty", "empty", "checked")
    label[complete] = "read_complete"
    label[limited] = "checked"
    label[soft] = "partial"
    label[veto] = "mapping_missing"
    label[absent] = "not_listed"
    return kind, label


def _parse_checks(
    checks: pd.DataFrame, source: str, assets: pd.Index, vocabulary: dict[str, int]
) -> _Checks:
    frame = checks
    if frame is None or frame.empty or "source" not in frame.columns:
        frame = pd.DataFrame(columns=["source"])
    frame = frame[frame["source"].to_numpy(dtype=object) == source]

    def column(name: str) -> np.ndarray:
        if name in frame.columns:
            return frame[name].to_numpy(dtype=object)
        return np.full(len(frame), None, dtype=object)

    asset = assets.get_indexer(pd.Index(column("asset_id")).astype(str))
    checked = clocks.instants(column("checked_at"))
    keep = (asset >= 0) & (checked != NAT)
    status = np.array(
        [
            value if isinstance(value, str) else "unknown"
            for value in column("status")[keep]
        ],
        dtype=object,
    )
    code = np.array(
        [
            value if isinstance(value, str) else ""
            for value in column("error_code")[keep]
        ],
        dtype=object,
    )
    starts, ends = column("checked_start")[keep], column("checked_end")[keep]
    bounded = np.fromiter(
        (
            not (
                start is None
                or start == ""
                or (not isinstance(start, date) and pd.isna(start))
            )
            and not (
                end is None or end == "" or (not isinstance(end, date) and pd.isna(end))
            )
            for start, end in zip(starts, ends)
        ),
        bool,
        len(starts),
    )
    start = np.zeros(len(starts), dtype=np.int64)
    end = np.zeros(len(starts), dtype=np.int64)
    start[bounded] = _ordinals(starts[bounded])
    end[bounded] = _ordinals(ends[bounded])
    kind, label = _classify(status, code, SOURCE_CONTRACTS[source])

    def codes(values: np.ndarray) -> np.ndarray:
        return np.array(
            [
                vocabulary.setdefault(value, len(vocabulary))
                for value in values.tolist()
            ],
            dtype=np.int64,
        )

    return _Checks(
        asset[keep], checked[keep], start, end, kind, codes(label), codes(status)
    )


def _cells(
    parsed: _Checks, order: np.ndarray, first: int, days: int
) -> tuple[np.ndarray, np.ndarray]:
    """(cell key, check) for every day of bounded checks inside the day domain; a
    window ending before it starts covers no day, so the check is ignored."""
    order = order[parsed.start[order] != 0]
    low = np.maximum(parsed.start[order], first) - first
    high = np.minimum(parsed.end[order], first + days - 1) - first
    order, low, high = order[low <= high], low[low <= high], high[low <= high]
    which, offset = _expand(low, high - low + 1)
    check = order[which]
    return parsed.asset[check] * days + offset, check


@dataclass
class CoverageMatrices:
    label: np.ndarray  # vocabulary code per (asset, decided window)
    basis: np.ndarray  # index into BASES


@dataclass
class _Days:
    """Calendar days of each window in the source's zone: window j covers days
    start[j] .. start[j] + lengths[j] - 1, counted from the domain's first day."""

    first: int
    count: int
    start: np.ndarray
    lengths: np.ndarray
    deadline: np.ndarray
    shape: tuple[int, int]

    def offsets(self) -> list[tuple[np.ndarray, np.ndarray]]:
        """(window has this day, day index) for each day offset inside a window."""
        return [
            (offset < self.lengths, np.minimum(self.start + offset, self.count - 1))
            for offset in range(int(self.lengths.max(initial=0)))
        ]


def _painted(
    parsed: _Checks, days: _Days, kind: np.ndarray, checked: np.ndarray
) -> tuple[list[np.ndarray], np.ndarray]:
    """public_reconstructed day states (latest strong check unless a later soft one
    replaces a non-countable state) and each window's latest first-countable clock."""
    count, size = len(parsed.asset), days.shape[0] * days.count
    order = np.lexsort((np.arange(count), parsed.checked, parsed.asset))
    rank = np.empty(count, dtype=np.int64)
    rank[order] = np.arange(count)
    key, check = _cells(parsed, order, days.first, days.count)
    k, cls = rank[check], parsed.kind[check]

    def latest(mask: np.ndarray) -> np.ndarray:
        result = np.full(size, -1, dtype=np.int64)
        np.maximum.at(result, key[mask], k[mask])
        return result

    strong = np.isin(cls, (COUNTABLE, VETO, NOT_LISTED))
    last_strong, last_soft = latest(strong), latest(~strong)
    # A countable day dates from the first countable check after the last veto.
    run = (cls == COUNTABLE) & (k > latest(np.isin(cls, (VETO, NOT_LISTED)))[key])
    run_start = np.full(size, count, dtype=np.int64)
    np.minimum.at(run_start, key[run], k[run])
    by_rank = np.r_[order, -1]
    strong_check = by_rank[np.where(last_strong >= 0, last_strong, count)]
    soft_check = by_rank[np.where(last_soft >= 0, last_soft, count)]
    keep = (kind[strong_check] == COUNTABLE) | (last_soft < last_strong)
    state = np.where(keep, strong_check, soft_check)
    first_ok = np.where(kind[state] == COUNTABLE, checked[by_rank[run_start]], NAT)
    state = state.reshape(days.shape[0], days.count)
    first_ok = first_ok.reshape(days.shape[0], days.count)
    states, latest_ok = [], np.full(days.shape, NAT, dtype=np.int64)
    for valid, day in days.offsets():
        states.append(np.where(valid, state[:, day], -1))
        latest_ok = np.maximum(latest_ok, np.where(valid, first_ok[:, day], NAT))
    return states, latest_ok


def _visible(parsed: _Checks, days: _Days) -> tuple[list[np.ndarray], np.ndarray]:
    """observed_content day states (latest covering check by each decision plus the
    grace; ties go to the earlier row) and the latest unbounded check per window."""
    count = len(parsed.asset)
    order = np.lexsort((-np.arange(count), parsed.checked, parsed.asset))
    values = np.unique(parsed.checked)
    width = len(values) + 1
    rank = np.searchsorted(values, parsed.checked, "right")
    visible = np.searchsorted(values, days.deadline, "right")
    assets = np.arange(days.shape[0])[:, None]

    def last_visible(
        keys: np.ndarray, items: np.ndarray, wanted: np.ndarray
    ) -> np.ndarray:
        """Per wanted key, the last item with that key and a rank up to the deadline."""
        if not keys.size:
            return np.full(days.shape, -1, dtype=np.int64)
        wanted = np.broadcast_to(wanted, days.shape).ravel()
        query = (wanted.reshape(days.shape) * width + visible[None, :]).ravel()
        position = np.searchsorted(keys * width + rank[items], query, "right") - 1
        found = (position >= 0) & (keys[np.maximum(position, 0)] == wanted)
        return np.where(found, items[np.maximum(position, 0)], -1).reshape(days.shape)

    key, check = _cells(parsed, order, days.first, days.count)
    by_cell = np.lexsort((-check, parsed.checked[check], key))
    key, check = key[by_cell], check[by_cell]
    states = [
        np.where(valid, last_visible(key, check, assets * days.count + day), -1)
        for valid, day in days.offsets()
    ]
    unbounded = order[parsed.start[order] == 0]
    return states, last_visible(parsed.asset[unbounded], unbounded, assets)


def _reduce(
    states: list[np.ndarray], lengths: np.ndarray, kind: np.ndarray, label: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Window labels from day states: the first day that is not countable decides,
    else empty / read_complete / checked. Returns (label, every day countable)."""
    shape = states[0].shape
    result = np.full(shape, UNKNOWN, dtype=np.int64)
    open_ = np.ones(shape, dtype=bool)
    all_empty = np.ones(shape, dtype=bool)
    any_complete = np.zeros(shape, dtype=bool)
    for offset, state in enumerate(states):
        valid = offset < lengths
        countable = valid & (kind[state] == COUNTABLE)
        decided = open_ & valid & ~countable
        result[decided] = label[state][decided]
        open_ &= ~decided
        all_empty &= ~valid | (countable & (label[state] == EMPTY))
        any_complete |= countable & (label[state] == READ_COMPLETE)
    tail = np.where(all_empty, EMPTY, np.where(any_complete, READ_COMPLETE, CHECKED))
    result[open_] = tail[open_]
    return result, open_


def coverage_matrices(
    checks: pd.DataFrame,
    *,
    assets: Sequence[str],
    boundaries: np.ndarray,
    policy: str,
    zones: Mapping[str, str],
    sources: Sequence[str],
) -> tuple[dict[str, CoverageMatrices], list[str]]:
    """Per source, the coverage label and basis of each (asset, decided window).

    public_reconstructed paints saved check windows in check order whenever they ran:
    countable, veto and not-listed checks overwrite, other checks only fill days that are
    not countable, unbounded checks are ignored. observed_content keeps, per day, the
    latest covering check captured by the decision plus CAPTURE_GRACE.
    """
    index = pd.Index([str(asset) for asset in assets])
    vocabulary = {name: code for code, name in enumerate(LABELS)}
    shape = (len(index), max(len(boundaries) - 1, 0))
    result = {}
    for source in sources:
        parsed = _parse_checks(checks, source, index, vocabulary)
        if shape[1] == 0:
            empty = np.zeros(shape, dtype=np.int64)
            result[source] = CoverageMatrices(empty, empty.copy())
            continue
        ordinals = clocks.local_ordinals(boundaries, clocks.source_zone(source, zones))
        days = _Days(
            first=int(ordinals[0]),
            count=int(ordinals[-1] - ordinals[0] + 1),
            start=ordinals[:-1] - ordinals[0],
            lengths=ordinals[1:] - ordinals[:-1] + 1,
            deadline=boundaries[1:] + GRACE_NS,
            shape=shape,
        )
        # Index -1 (no check) reads the sentinels appended here.
        kind = np.r_[parsed.kind, NO_CHECK]
        label = np.r_[parsed.label, UNKNOWN]
        checked = np.r_[parsed.checked, NAT]
        if policy == "public_reconstructed":
            states, latest_ok = _painted(parsed, days, kind, checked)
            labels, countable = _reduce(states, days.lengths, kind, label)
            basis = np.where(countable, np.where(latest_ok <= days.deadline, 1, 2), 0)
        else:
            states, unbounded = _visible(parsed, days)
            labels, countable = _reduce(states, days.lengths, kind, label)
            basis = countable.astype(np.int64)
            seen = np.any([state >= 0 for state in states], axis=0)
            newest = np.max([checked[state] for state in states], axis=0)
            # A later unbounded failure overrides the window (observed only).
            status = np.r_[parsed.status, UNKNOWN]
            settled = np.isin(status, [vocabulary["checked"], vocabulary["empty"]])
            override = seen & (unbounded >= 0) & (checked[unbounded] >= newest)
            override &= ~settled[unbounded]
            labels = np.where(override, status[unbounded], labels)
            basis[override] = 0
            alone = kind[unbounded] == COUNTABLE
            labels = np.where(seen, labels, label[unbounded])
            basis = np.where(seen, basis, alone.astype(np.int64))
        result[source] = CoverageMatrices(labels, basis)
    return result, list(vocabulary)


# --- features ------------------------------------------------------------------------


def _rolling(values: np.ndarray, size: int) -> np.ndarray:
    """Sums of ``size`` consecutive windows; NaN unless every one is known."""
    known = ~np.isnan(values)
    total = np.pad(np.cumsum(np.where(known, values, 0.0), axis=1), ((0, 0), (1, 0)))
    gaps = np.pad(np.cumsum(~known, axis=1), ((0, 0), (1, 0)))
    result = np.full(values.shape, np.nan)
    if values.shape[1] >= size:
        complete = gaps[:, size:] - gaps[:, :-size] == 0
        sums = total[:, size:] - total[:, :-size]
        result[:, size - 1 :] = np.where(complete, sums, np.nan)
    return result


def event_features(
    observations: pd.DataFrame,
    checks: pd.DataFrame,
    *,
    assets: Sequence[str],
    selected: int,
    decisions: np.ndarray,
    first_signal: int,
    policy: str,
    zones: Mapping[str, str],
    news_versions: pd.DataFrame | None = None,
    population: Sequence[int] = (),
    specs: Sequence[EventSpec] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Event feature columns, asset-major, for the first ``selected`` assets and the
    windows from ``first_signal`` on, plus the reduction summary.

    ``decisions`` holds one more instant than there are windows (NAT when the last
    session has no known successor). Counts and coverage are computed for every asset
    so that ``{name}_events_rank_21d`` ranks the ``population`` positions of ``assets``.
    """
    specs = default_specs() if specs is None else tuple(specs)
    windows = len(decisions) - 1
    decided = windows - int(decisions[-1] == NAT)
    boundaries = decisions[: decided + 1]
    matrices, skipped = event_matrices(
        observations,
        assets=assets,
        boundaries=boundaries,
        policy=policy,
        zones=zones,
        news_versions=news_versions,
        specs=specs,
        selected=selected,
    )
    coverage, vocabulary = coverage_matrices(
        checks,
        assets=assets,
        boundaries=boundaries,
        policy=policy,
        zones=zones,
        sources=list(dict.fromkeys(spec.source for spec in specs)),
    )
    labels, bases = np.array(vocabulary, dtype=object), np.array(BASES, dtype=object)
    population = np.asarray(population, dtype=np.int64)

    def full(matrix: np.ndarray, fill: Any) -> np.ndarray:
        return np.pad(matrix, ((0, 0), (0, windows - decided)), constant_values=fill)

    def rows(matrix: np.ndarray) -> np.ndarray:
        return matrix[:selected, first_signal:].ravel()

    columns: dict[str, Any] = {}
    observed_basis = reconstructed_basis = 0
    for item in coverage.values():
        basis = rows(full(item.basis, 0))
        observed_basis = observed_basis | (basis == 1)
        reconstructed_basis = reconstructed_basis | (basis == 2)
    for spec in specs:
        item, events = coverage[spec.source], matrices[spec.name]
        basis = full(item.basis, 0)
        counts = full(events.counts, 0)
        clock_missing = full(events.clock_missing, False)
        complete = (basis != 0) & ~clock_missing
        name = spec.name
        columns[f"{name}_events_1d"] = pd.arrays.IntegerArray(
            rows(counts), ~rows(complete)
        )
        columns[f"{name}_observed_events_1d"] = rows(counts)
        columns[f"{name}_coverage"] = pd.Categorical(labels[rows(full(item.label, 0))])
        columns[f"{name}_coverage_basis"] = pd.Categorical(bases[rows(basis)])
        columns[f"{name}_clock_missing"] = rows(clock_missing)
        columns[f"{name}_public_clock_missing"] = rows(
            full(events.public_missing, False)
        )
        daily = np.where(complete, counts, np.nan)
        for size in ROLLING_WINDOWS:
            total = _rolling(daily, size)
            columns[f"{name}_events_{size}d"] = rows(total)
            if size == RANK_WINDOW:
                rank = np.full(total.shape, np.nan)
                if population.size:
                    rank[population] = (
                        pd.DataFrame(total[population].T)
                        .rank(axis=1, pct=True)
                        .to_numpy()
                        .T
                    )
                columns[f"{name}_events_rank_{size}d"] = rows(rank)
        if name == spec.source:
            columns[f"{name}_new_event_count"] = columns[f"{name}_events_1d"].copy()
            columns[f"{name}_observed_new_event_count"] = rows(counts).copy()
    columns["info_regime"] = pd.Categorical(
        np.where(
            observed_basis & reconstructed_basis,
            "mixed",
            np.where(
                observed_basis,
                "observed",
                np.where(reconstructed_basis, "reconstructed", ""),
            ),
        )
    )
    # Coverage belongs to a source: its first spec's columns describe it.
    coverage_columns: dict[str, str] = {}
    for spec in specs:
        coverage_columns.setdefault(spec.source, spec.name)
    summary = {
        "coverage_columns": coverage_columns,
        "specs": [spec.record() for spec in specs],
        "skipped_sources": skipped,
        "undatable_events": {
            spec.name: matrices[spec.name].undatable
            for spec in specs
            if matrices[spec.name].undatable
        },
        "rank_population": {
            "basis": "universe_non_benchmark",
            "members": int(population.size),
            "selected": int((population < selected).sum()),
            "ranked": bool(population.size),
        },
    }
    return columns, summary
