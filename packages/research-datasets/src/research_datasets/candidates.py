"""Candidate rows: securities x sampled signal sessions with point-in-time membership.

A security is in the universe for a signal session T when the latest monthly membership
observation of the rule for the month of its entry session t (warm-up rows excluded)
says member. Versions without membership rows have a static universe: labels then need
an explicit ``allow_static_universe=True``.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from datetime import date
from typing import Any

import numpy as np
import pandas as pd

from . import clocks
from .constants import (
    CANDIDATE_SECURITY_TYPES,
    DEFAULT_UNIVERSE_RULE,
    LABEL_OPEN_TIME,
    SAMPLINGS,
)

MEMBERSHIP_COLUMNS = (
    "rule_version",
    "effective_month",
    "asset_id",
    "member",
    "warmup",
    "observation_sequence",
)


def families(version: Any) -> Mapping[str, Any]:
    """The manifest's frozen data families of a version (empty when it has none)."""
    manifest = getattr(version, "manifest", None)
    found = manifest.get("data_families") if isinstance(manifest, Mapping) else None
    return found if isinstance(found, Mapping) else {}


def records(universe: Any) -> list[Mapping[str, Any]]:
    rows = (
        universe.to_dict("records") if isinstance(universe, pd.DataFrame) else universe
    )
    return [row for row in rows or [] if isinstance(row, Mapping)]


def flagged(row: Mapping[str, Any]) -> bool:
    value = row.get("is_benchmark")
    return isinstance(value, (bool, np.bool_)) and bool(value)


def calendar(version_or_manifest: Any, sessions: Sequence[Any], **options: Any):
    """A ``clocks.Calendar`` with the manifest's early closes, when it has them."""
    manifest = getattr(version_or_manifest, "manifest", version_or_manifest)
    closes = manifest.get("calendar_closes") if isinstance(manifest, Mapping) else None
    return clocks.Calendar(
        sessions, closes if isinstance(closes, Mapping) else None, **options
    )


def membership_rule(present: bool, universe: str) -> str | None:
    """The membership rule ``universe`` asks for, or None for a static universe."""
    if not isinstance(universe, str) or not universe:
        raise ValueError('universe must be "pit", "static" or a rule version')
    if universe == "static":
        return None
    rule = DEFAULT_UNIVERSE_RULE if universe == "pit" else universe
    return rule if present else None


def require_pit(rule: str | None, allow_static_universe: bool) -> str:
    """Label producers refuse a static universe unless the caller accepts it."""
    if rule is None and not allow_static_universe:
        raise ValueError(
            "UNIVERSE_NOT_PIT: this version has no point-in-time universe membership, "
            "so labels over its frozen securities are survivorship-biased; pass "
            "allow_static_universe=True to accept that"
        )
    return "static" if rule is None else "pit"


def default_assets(universe: Any, benchmark_ids: Iterable[str] = ()) -> list[str]:
    """Universe securities a default candidate set keeps: no flagged or chosen
    benchmark and, where a security type is recorded, common shares only."""
    excluded = set(map(str, benchmark_ids))
    kept = []
    for row in records(universe):
        kind = row.get("security_type")
        if (
            not row.get("asset_id")
            or flagged(row)
            or str(row["asset_id"]) in excluded
            or (isinstance(kind, str) and kind and kind not in CANDIDATE_SECURITY_TYPES)
        ):
            continue
        kept.append(str(row["asset_id"]))
    return list(dict.fromkeys(kept))


def unknown(count: int) -> pd.arrays.BooleanArray:
    """An all-NA membership column (static universe)."""
    return pd.arrays.BooleanArray(
        np.zeros(count, dtype=bool), np.ones(count, dtype=bool)
    )


def sample_positions(
    days: Sequence[date], sampling: str, next_session: date | None = None
) -> np.ndarray:
    """Calendar positions of signal sessions: every session, or the last session of
    each completed ISO week or calendar month. A period is complete once a later session
    (or ``next_session``) falls in a later period."""
    if sampling not in SAMPLINGS:
        raise ValueError(f"sampling must be one of {SAMPLINGS}")
    if sampling == "daily":
        return np.arange(len(days), dtype=np.int64)

    def period(value: date) -> tuple[int, int]:
        if sampling == "weekly":
            iso = value.isocalendar()
            return iso.year, iso.week
        return value.year, value.month

    keys = [period(value) for value in days]
    positions = [
        index for index in range(len(days) - 1) if keys[index] != keys[index + 1]
    ]
    if next_session is not None and period(next_session) != keys[-1]:
        positions.append(len(days) - 1)
    return np.array(positions, dtype=np.int64)


def signal_positions(
    cal: clocks.Calendar,
    start: Any = None,
    end: Any = None,
    sampling: str = "daily",
) -> np.ndarray:
    """Sampled signal positions inside [start, end] (whole calendar by default)."""
    first = clocks.day(start) if start is not None else cal.days[0]
    last = clocks.day(end) if end is not None else cal.days[-1]
    if first > last:
        raise ValueError("Require start <= end")
    positions = sample_positions(cal.days, sampling, cal.next_session)
    chosen = [p for p in positions if first <= cal.days[p] <= last]
    if not chosen:
        raise ValueError("No frozen signal sessions in [start, end]")
    return np.array(chosen, dtype=np.int64)


def entry_days(cal: clocks.Calendar, positions: np.ndarray) -> np.ndarray:
    """The entry session after each signal position (None when it is not known)."""
    following = [*cal.days[1:], cal.next_session]
    return np.array([following[p] for p in positions], dtype=object)


def in_universe(
    assets: Sequence[str],
    entries: Sequence[date | None],
    membership: pd.DataFrame | None,
    rule: str,
    months: Mapping[str, Any] | None = None,
) -> pd.arrays.BooleanArray:
    """``member`` of the latest non-warm-up observation for (rule, month of the entry
    session, security). Inside the rule's known months a missing row is False; outside
    them, a warm-up-only month or an unknown entry session gives NA."""
    frame = membership if membership is not None else pd.DataFrame()
    missing = set(MEMBERSHIP_COLUMNS) - set(frame.columns)
    if missing and not frame.empty:
        raise ValueError(f"universe_membership lacks columns: {sorted(missing)}")
    if frame.empty:
        frame = pd.DataFrame(columns=list(MEMBERSHIP_COLUMNS))
    frame = frame[frame["rule_version"].astype(str) == rule].assign(
        asset_id=lambda f: f["asset_id"].astype(str),
        effective_month=lambda f: f["effective_month"].astype(str),
    )
    warm = pd.array(frame["warmup"], dtype="boolean").fillna(False).to_numpy(bool)
    regular = (
        frame[~warm]
        .sort_values("observation_sequence", kind="stable")
        .drop_duplicates(["asset_id", "effective_month"], keep="last")
    )
    warm_pairs = frame.loc[warm, ["asset_id", "effective_month"]].drop_duplicates()
    bounds = list(regular["effective_month"])
    for key in ("first_effective_month", "last_effective_month"):
        value = (months or {}).get(key)
        if isinstance(value, str) and value:
            bounds.append(value)
    codes, uniques = pd.factorize(pd.Series(entries, dtype=object))
    labels = np.array([f"{value:%Y-%m}" for value in uniques] + [None], dtype=object)
    rows = pd.DataFrame(
        {
            "asset_id": pd.Series(assets, dtype=object).astype(str).to_numpy(),
            "effective_month": labels[codes],
        }
    )
    found = rows.merge(
        regular[["asset_id", "effective_month", "member"]],
        on=["asset_id", "effective_month"],
        how="left",
    ).merge(
        warm_pairs.assign(warm_only=True),
        on=["asset_id", "effective_month"],
        how="left",
    )
    result = pd.array(found["member"].astype(object), dtype="boolean")
    month = found["effective_month"]
    inside = (
        month.between(min(bounds), max(bounds)).to_numpy(bool)
        if bounds
        else np.zeros(len(found), dtype=bool)
    )
    inside &= found["warm_only"].isna().to_numpy()
    absent = found["member"].isna().to_numpy()
    result[absent & inside] = False
    result[absent & ~inside] = pd.NA
    return result


def read_membership(version: Any, asset_ids: Sequence[str]) -> pd.DataFrame | None:
    if "universe_membership" not in families(version) or not asset_ids:
        return None
    return version.family(
        "universe_membership", list(asset_ids), columns=list(MEMBERSHIP_COLUMNS)
    )


def membership_months(version_or_manifest: Any) -> Mapping[str, Any]:
    manifest = getattr(version_or_manifest, "manifest", version_or_manifest)
    found = manifest.get("universe_rule") if isinstance(manifest, Mapping) else None
    return found if isinstance(found, Mapping) else {}


def build_candidates(
    version: Any,
    symbols: str | Sequence[str] | None = None,
    *,
    start: str | date | None = None,
    end: str | date | None = None,
    sampling: str = "daily",
    universe: str = "pit",
    keep_non_members: bool = False,
    benchmark: str | None = None,
    next_session: str | date | None = None,
) -> pd.DataFrame:
    """Candidate ``(asset_id, signal_session)`` rows with their decision clocks.

    ``symbols=None`` (or "all") keeps the default set: no flagged or chosen benchmark,
    common shares where the type is recorded. Signals are sampled daily, or on the last
    session of each completed week or month. With membership rows (``universe="pit"``
    or a rule version), rows outside the universe are dropped unless
    ``keep_non_members``; ``in_universe`` is NA for a static universe.
    ``next_session`` gives the last frozen session a live decision instant.
    """
    benchmark_ids = (
        list(map(str, version.resolve(benchmark))) if benchmark is not None else []
    )
    if symbols is None or symbols == "all":
        asset_ids = default_assets(version.universe, benchmark_ids)
    else:
        asset_ids = list(dict.fromkeys(map(str, version.resolve(symbols))))
    if not asset_ids:
        raise ValueError("No candidate securities selected")
    cal = calendar(version, version.calendar, next_session=next_session)
    positions = signal_positions(cal, start, end, sampling)
    rule = membership_rule("universe_membership" in families(version), universe)
    frame = candidate_frame(cal, asset_ids, positions, version.universe)
    total = len(frame)
    if rule is not None:
        frame["in_universe"] = in_universe(
            frame["asset_id"],
            frame["entry_session"],
            read_membership(version, asset_ids),
            rule,
            membership_months(version),
        )
        if not keep_non_members:
            frame = frame[frame["in_universe"].fillna(False).to_numpy(dtype=bool)]
            frame = frame.reset_index(drop=True)
    frame.attrs["parameters"] = {
        "asset_ids": asset_ids,
        "start": str(cal.days[positions[0]]),
        "end": str(cal.days[positions[-1]]),
        "sampling": sampling,
        "universe_basis": "static" if rule is None else "pit",
        "universe_rule": rule,
        "keep_non_members": keep_non_members,
        "next_session": None if cal.next_session is None else str(cal.next_session),
    }
    frame.attrs["counts"] = {
        "grid": total,
        "not_in_universe_dropped": total - len(frame),
    }
    return frame


def candidate_frame(
    cal: clocks.Calendar,
    asset_ids: Sequence[str],
    positions: np.ndarray,
    universe: Any,
) -> pd.DataFrame:
    """Asset-major grid of securities x signal positions with their decision clocks."""
    rows = {
        str(row["asset_id"]): row for row in records(universe) if row.get("asset_id")
    }
    count, length = len(asset_ids), len(positions)
    symbols = [str(rows.get(asset, {}).get("symbol") or "") for asset in asset_ids]
    benchmarks = [flagged(rows.get(asset, {})) for asset in asset_ids]
    tiled = np.tile(positions, count)
    decision = cal.decisions[tiled + 1]
    capture = np.where(decision == clocks.NAT, clocks.NAT, decision + clocks.GRACE_NS)
    entry_known = tiled + 1 < len(cal)
    opens = np.where(
        entry_known, cal.opens[np.minimum(tiled + 1, len(cal) - 1)], clocks.NAT
    )
    if cal.next_session is not None:
        live = clocks.wall_instants([cal.next_session], LABEL_OPEN_TIME)[0]
        opens[~entry_known] = live
    return pd.DataFrame(
        {
            "asset_id": np.repeat(np.array(asset_ids, dtype=object), length),
            "symbol": np.repeat(np.array(symbols, dtype=object), length),
            "signal_session": np.array(cal.days, dtype=object)[tiled],
            "previous_decision_at": clocks.utc(cal.decisions[tiled]),
            "decision_at": clocks.utc(decision),
            "capture_deadline_at": clocks.utc(capture),
            "entry_session": entry_days(cal, tiled),
            "label_start": clocks.utc(opens),
            "in_universe": unknown(len(tiled)),
            "is_benchmark": np.repeat(np.array(benchmarks, dtype=bool), length),
        }
    )
