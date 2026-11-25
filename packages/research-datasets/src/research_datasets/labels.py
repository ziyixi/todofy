"""Forward-return labels from the entry session's open to the exit session's close.

One implementation for every horizon. With the frozen ``daily_returns`` family both legs
are total-return levels (``close = tr_index``, ``open = tr_index * open_raw /
close_raw``) and an exit inside the window ends the asset leg at its terminal row;
versions without it use vendor-adjusted prices (``return_basis="vendor_adjusted"``).
After an exit, cash is held flat and stock consideration follows the successor's total
return when the successor is frozen (else flat, ``post_exit_basis="cash_proxy"``); the
benchmark leg always spans the whole window.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from statistics import NormalDist
from typing import Any

import numpy as np
import pandas as pd

from . import clocks
from .constants import (
    DEFAULT_TERMINAL_POLICY,
    EXIT_TYPES,
    KEYS,
    MAX_HORIZON,
    NEUTRAL_MIN_GROUP,
    SIZE_GROUPS,
)

DAILY_RETURN_COLUMNS = (
    "asset_id",
    "date",
    "row_kind",
    "open_raw",
    "close_raw",
    "tr_index",
    "tr_status",
    "terminal_basis",
    "cash_amount",
)
DELISTING_COLUMNS = (
    "asset_id",
    "exit_type",
    "successor_asset_id",
    "observation_sequence",
)
# Terminal values held flat after the exit, with the post-exit basis they report.
FLAT_EXITS = {
    "cash": "cash",
    "worthless": "worthless",
    "last_close_proxy": "cash_proxy",
}
# Stock consideration follows the successor's total return after the exit.
STOCK_EXITS = {
    "acquirer_close": "successor",
    "cash_and_acquirer_close": "cash_and_successor",
}
CATEGORY_COLUMNS = (
    "return_basis",
    "return_status",
    "exit_type",
    "terminal_basis",
    "post_exit_basis",
)
MASKS = (
    "horizon_beyond_material",
    "entry_price_missing",
    "exit_price_missing",
    "benchmark_missing",
    "disputed_return",
    "terminal_unknown",
    "not_in_universe",
)


@dataclass(frozen=True)
class ReturnSeries:
    """Sessions x securities price levels and per-security exits of one return basis."""

    basis: str  # "total_return" | "vendor_adjusted"
    assets: tuple[str, ...]
    open: np.ndarray  # n x m levels at the open, NaN when missing
    close: np.ndarray  # n x m levels at the close
    missing: np.ndarray  # (n + 1) x m cumulative sessions without a close
    vendor: np.ndarray  # (n + 1) x m cumulative sessions with tr_status "vendor"
    disputed: np.ndarray  # (n + 1) x m cumulative sessions with tr_status "disputed"
    exit_index: np.ndarray  # exit session position per security, -1 when none
    exit_level: np.ndarray  # terminal level at the exit session, NaN when unknown
    exit_basis: np.ndarray  # collector terminal basis
    exit_type: np.ndarray  # delisting type ("" when unknown)
    cash_share: np.ndarray  # cash part of a mixed consideration's value
    successor: np.ndarray  # successor column, -1 when not frozen

    def columns(self, asset_ids: Iterable[Any]) -> np.ndarray:
        position = {asset: index for index, asset in enumerate(self.assets)}
        codes, uniques = pd.factorize(pd.Series(list(asset_ids), dtype=object))
        found = np.array([position[str(asset)] for asset in uniques], dtype=np.int64)
        return found[codes]


def terminal_policy(overrides: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Default terminal assumptions updated by ``overrides``: a return from the last
    close per exit type, or None to mask the label."""
    unknown_types = set(overrides or {}) - EXIT_TYPES
    if unknown_types:
        raise ValueError(
            f"terminal_policy keys must be exit types {sorted(EXIT_TYPES)}, "
            f"not {sorted(map(str, unknown_types))}"
        )
    policy = {**DEFAULT_TERMINAL_POLICY, **(overrides or {})}
    for kind, value in policy.items():
        if value is not None and (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not -1.0 <= float(value) <= 1.0
        ):
            raise ValueError(f"terminal_policy[{kind!r}] must be None or in [-1, 1]")
    return policy


def horizons(value: int | Iterable[int]) -> tuple[list[int], bool]:
    """Validated horizons and whether a single int was given."""
    single = isinstance(value, (int, np.integer)) and not isinstance(value, bool)
    found = [value] if single else list(value)
    if not found or any(
        isinstance(item, bool)
        or not isinstance(item, (int, np.integer))
        or not 1 <= item <= MAX_HORIZON
        for item in found
    ):
        raise ValueError(f"horizons must be integers in [1, {MAX_HORIZON}]")
    return [int(item) for item in dict.fromkeys(found)], single


def _cumulative(flags: np.ndarray) -> np.ndarray:
    result = np.zeros((flags.shape[0] + 1, flags.shape[1]), dtype=np.int32)
    result[1:] = np.cumsum(flags, axis=0)
    return result


def _day_keys(values: Any) -> np.ndarray:
    series = pd.Series(values)
    if pd.api.types.is_datetime64_any_dtype(series.dtype):
        return series.dt.strftime("%Y-%m-%d").to_numpy(dtype=object)
    codes, uniques = pd.factorize(series.astype(object))
    keys = np.array([clocks.day(value).isoformat() for value in uniques] + [""])
    return keys[codes].astype(object)


def _cells(
    frame: pd.DataFrame, days: Sequence[date], assets: Sequence[str]
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Calendar rows, security columns and the rows that fall on the grid."""
    day_position = {value.isoformat(): index for index, value in enumerate(days)}
    asset_position = {asset: index for index, asset in enumerate(assets)}
    rows = pd.Series(_day_keys(frame["date"])).map(day_position)
    cols = frame["asset_id"].astype(str).map(asset_position).reset_index(drop=True)
    keep = (rows.notna() & cols.notna()).to_numpy()
    return (
        rows.fillna(-1).to_numpy(np.int64),
        cols.fillna(-1).to_numpy(np.int64),
        keep,
    )


def _numbers(frame: pd.DataFrame, column: str) -> np.ndarray:
    return pd.to_numeric(frame[column], errors="coerce").to_numpy(dtype=float)


def _counts(values: np.ndarray, unknown: np.ndarray) -> pd.arrays.IntegerArray:
    return pd.arrays.IntegerArray(
        np.where(unknown, 0, values).astype(np.int16), unknown.copy()
    )


def _float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


def _no_exits(count: int) -> dict[str, np.ndarray]:
    return {
        "exit_index": np.full(count, -1, dtype=np.int64),
        "exit_level": np.full(count, np.nan),
        "exit_basis": np.full(count, "", dtype=object),
        "exit_type": np.full(count, "", dtype=object),
        "cash_share": np.full(count, np.nan),
        "successor": np.full(count, -1, dtype=np.int64),
    }


def vendor_series(
    prices: pd.DataFrame, days: Sequence[date], assets: Sequence[str]
) -> ReturnSeries:
    """Vendor-adjusted opens and closes (normalized price rows); no exit handling."""
    shape = (len(days), len(assets))
    open_, close = np.full(shape, np.nan), np.full(shape, np.nan)
    if not prices.empty:
        rows, cols, keep = _cells(prices, days, assets)
        for target, column in ((open_, "open"), (close, "close")):
            values = _numbers(prices, column)[keep]
            target[rows[keep], cols[keep]] = np.where(values > 0, values, np.nan)
    zero = np.zeros((shape[0] + 1, shape[1]), dtype=np.int32)
    return ReturnSeries(
        "vendor_adjusted",
        tuple(assets),
        open_,
        close,
        _cumulative(~np.isfinite(close)),
        zero,
        zero,
        **_no_exits(len(assets)),
    )


def successors(delistings: pd.DataFrame | None) -> dict[str, str]:
    """Latest delisting observation per security: its successor, when one is named."""
    latest = _latest_exits(delistings)
    return {
        asset: str(row["successor_asset_id"])
        for asset, row in latest.iterrows()
        if isinstance(row["successor_asset_id"], str) and row["successor_asset_id"]
    }


def _latest_exits(delistings: pd.DataFrame | None) -> pd.DataFrame:
    if delistings is None or delistings.empty:
        return pd.DataFrame(columns=["exit_type", "successor_asset_id"])
    missing = set(DELISTING_COLUMNS) - set(delistings.columns)
    if missing:
        raise ValueError(f"delistings lacks columns: {sorted(missing)}")
    return (
        delistings.assign(asset_id=delistings["asset_id"].astype(str))
        .sort_values("observation_sequence", kind="stable")
        .drop_duplicates("asset_id", keep="last")
        .set_index("asset_id")[["exit_type", "successor_asset_id"]]
    )


def total_return_series(
    daily: pd.DataFrame,
    days: Sequence[date],
    assets: Sequence[str],
    delistings: pd.DataFrame | None = None,
) -> ReturnSeries:
    """Total-return levels from ``daily_returns`` rows and one exit per security from its
    terminal row (type and successor from the latest ``delistings`` observation)."""
    missing = set(DAILY_RETURN_COLUMNS) - set(daily.columns)
    if missing and not daily.empty:
        raise ValueError(f"daily_returns lacks columns: {sorted(missing)}")
    shape = (len(days), len(assets))
    open_, close = np.full(shape, np.nan), np.full(shape, np.nan)
    vendor, disputed = np.zeros(shape, dtype=bool), np.zeros(shape, dtype=bool)
    exits = _no_exits(len(assets))
    if not daily.empty:
        daily = daily.reset_index(drop=True)
        rows, cols, keep = _cells(daily, days, assets)
        terminal = daily["row_kind"].astype(str).to_numpy() == "terminal"
        level = _numbers(daily, "tr_index")
        raw_open, raw_close = _numbers(daily, "open_raw"), _numbers(daily, "close_raw")
        session = keep & ~terminal
        cells = rows[session] * shape[1] + cols[session]
        if len(np.unique(cells)) != len(cells):
            raise ValueError("Duplicate security/session total-return rows")
        r, c = rows[session], cols[session]
        level_s, open_s, close_s = level[session], raw_open[session], raw_close[session]
        ok = np.isfinite(level_s) & (level_s > 0) & (close_s > 0)
        close[r, c] = np.where(ok, level_s, np.nan)
        ok &= open_s > 0
        open_[r, c] = np.where(
            ok, level_s * open_s / np.where(ok, close_s, 1.0), np.nan
        )
        status = daily["tr_status"].astype(str).to_numpy()[session]
        vendor[r, c], disputed[r, c] = status == "vendor", status == "disputed"
        raw_last = pd.Series(close_s, index=cells)
        _terminal_exits(
            exits,
            daily[keep & terminal],
            rows[keep & terminal],
            cols[keep & terminal],
            close,
            raw_last,
        )
    latest = _latest_exits(delistings)
    position = {asset: index for index, asset in enumerate(assets)}
    for asset, row in latest.iterrows():
        if asset in position:
            kind = row["exit_type"]
            exits["exit_type"][position[asset]] = kind if isinstance(kind, str) else ""
            heir = row["successor_asset_id"]
            exits["successor"][position[asset]] = position.get(heir, -1)
    return ReturnSeries(
        "total_return",
        tuple(assets),
        open_,
        close,
        _cumulative(~np.isfinite(close)),
        _cumulative(vendor),
        _cumulative(disputed),
        **exits,
    )


def _terminal_exits(
    exits: dict[str, np.ndarray],
    rows: pd.DataFrame,
    positions: np.ndarray,
    cols: np.ndarray,
    close: np.ndarray,
    raw_last: pd.Series,
) -> None:
    """Fill one exit per security from its latest terminal row."""
    width = close.shape[1]
    order = np.argsort(positions, kind="stable")
    for index in order:  # later terminal rows of a security win
        col, at = cols[index], positions[index]
        row = rows.iloc[index]
        value = _float(row["tr_index"])
        basis = row["terminal_basis"]
        exits["exit_index"][col] = at
        exits["exit_level"][col] = (
            value if np.isfinite(value) and value >= 0 else np.nan
        )
        exits["exit_basis"][col] = (
            basis if isinstance(basis, str) and basis else "unknown"
        )
        cash = _float(row["cash_amount"])
        previous = close[at - 1, col] if at > 0 else np.nan
        raw = raw_last.get((at - 1) * width + col, np.nan) if at > 0 else np.nan
        # Value of the whole consideration per share: V / tr_index(L) * close_raw(L).
        worth = value / previous * raw if previous > 0 else np.nan
        share = cash / worth if np.isfinite(worth) and worth > 0 else np.nan
        # A mixed consideration has a cash and a stock part: a share outside (0, 1),
        # e.g. an unset cash amount, is unknown and the exit value is held flat.
        exits["cash_share"][col] = share if 0.0 < share < 1.0 else np.nan


def horizon_labels(
    series: ReturnSeries,
    asset: np.ndarray,
    signal: np.ndarray,
    horizon: int,
    *,
    benchmark: int,
    cal: clocks.Calendar,
    last: int,
    policy: Mapping[str, Any],
) -> dict[str, Any]:
    """Label arrays for rows (security column, signal position) at one horizon.

    Entry is the open of session ``signal + 1``, exit the close of ``signal + horizon``
    (the last usable session is ``last``). Interior sessions without a close are counted,
    never masking; a missing entry or exit price masks the pair. ``disputed_sessions``
    and ``return_status`` cover every leg: the asset until its exit, the successor it
    follows after the exit and the benchmark.
    """
    n = len(cal)
    entry, end = signal + 1, signal + horizon
    beyond = end > last
    entry_known = entry <= last
    tc, ec = np.minimum(entry, n - 1), np.minimum(end, n - 1)
    start_level = series.open[tc, asset]
    entry_ok = entry_known & np.isfinite(start_level) & (start_level > 0)
    level = series.close[ec, asset].copy()
    exit_ok = np.isfinite(level) & (level > 0)
    exit_at = series.exit_index[asset]
    delisted = ~beyond & (exit_at > entry) & (exit_at <= end)
    basis = series.exit_basis[asset]
    value = series.exit_level[asset]
    terminal = np.where(delisted, basis, "").astype(object)
    post = np.full(len(asset), "", dtype=object)
    known = delisted & np.isfinite(value)
    flat = known & np.isin(basis, list(FLAT_EXITS))
    level[flat] = value[flat]
    post[flat] = [FLAT_EXITS[item] for item in basis[flat]]
    stock = known & np.isin(basis, list(STOCK_EXITS))
    heir = series.successor[asset]
    xc = np.clip(exit_at, 0, n - 1)
    heir_from = series.close[xc, np.maximum(heir, 0)]
    heir_to = series.close[ec, np.maximum(heir, 0)]
    share = np.where(basis == "acquirer_close", 0.0, series.cash_share[asset])
    follow = stock & (heir >= 0) & (heir_from > 0) & (heir_to > 0) & np.isfinite(share)
    level[stock] = value[stock]
    post[stock] = "cash_proxy"
    growth = heir_to[follow] / heir_from[follow]
    level[follow] = value[follow] * (share[follow] + (1 - share[follow]) * growth)
    post[follow] = [STOCK_EXITS[item] for item in basis[follow]]
    # Exits without a stored terminal value take the reader's policy, or mask.
    assumed = delisted & ~flat & ~stock
    kinds = series.exit_type[asset]
    codes, uniques = pd.factorize(pd.Series(kinds, dtype=object))
    rates = [policy.get(kind, policy.get("unknown")) for kind in uniques]
    rate = np.array([np.nan if item is None else item for item in [*rates, None]])
    rate = rate.astype(float)[codes]
    last_close = series.close[np.clip(exit_at - 1, 0, n - 1), asset]
    applied = assumed & np.isfinite(rate) & (last_close > 0)
    level[applied] = last_close[applied] * (1 + rate[applied])
    terminal[applied], post[applied] = "policy", "cash_proxy"
    terminal_unknown = assumed & ~applied
    asset_ok = entry_ok & ~beyond & np.where(delisted, ~terminal_unknown, exit_ok)
    exit_missing = ~beyond & ~delisted & ~exit_ok
    bench_ok = np.zeros(len(asset), dtype=bool)
    bench_start = bench_end = np.full(len(asset), np.nan)
    if benchmark >= 0:
        bench_start, bench_end = series.open[tc, benchmark], series.close[ec, benchmark]
        bench_ok = (bench_start > 0) & (bench_end > 0)
    benchmark_missing = ~beyond & ~bench_ok
    pair_valid = ~beyond & entry_ok & ~exit_missing & ~benchmark_missing
    pair_valid &= ~terminal_unknown
    with np.errstate(invalid="ignore", divide="ignore"):
        asset_return = np.where(asset_ok, level / start_level - 1, np.nan)
        benchmark_return = np.where(
            ~beyond & bench_ok, bench_end / bench_start - 1, np.nan
        )
    stop = np.where(delisted, exit_at, end)
    sc = np.clip(stop, 0, n - 1)
    interior = series.missing[sc, asset] - series.missing[tc, asset]

    def sessions(flags: np.ndarray) -> np.ndarray:
        """Flagged sessions of every leg: the asset over (t, stop], the successor it
        follows over (x, e] and the benchmark over (t, e]."""
        total = flags[sc + 1, asset] - flags[tc + 1, asset]
        hc = np.maximum(heir, 0)
        total += np.where(follow, flags[ec + 1, hc] - flags[xc + 1, hc], 0)
        if benchmark >= 0:
            bench = flags[ec + 1, benchmark] - flags[tc + 1, benchmark]
            total += np.where(asset != benchmark, bench, 0)
        return total

    disputed, vendor = sessions(series.disputed), sessions(series.vendor)
    if series.basis == "total_return":
        status = np.select([disputed > 0, vendor > 0], ["disputed", "vendor"], "ok")
        status = np.where(beyond, "", status)
    else:
        status = np.full(len(asset), "", dtype=object)
    days = np.array([*cal.days, None], dtype=object)
    return {
        "entry_session": days[np.minimum(entry, n)],
        "exit_session": days[np.minimum(end, n)],
        "label_start": clocks.utc(np.where(entry_known, cal.opens[tc], clocks.NAT)),
        "label_end": clocks.utc(np.where(beyond, clocks.NAT, cal.closes[ec])),
        "asset_return": asset_return,
        "benchmark_return": benchmark_return,
        "excess_return": np.where(pair_valid, asset_return - benchmark_return, np.nan),
        "return_basis": np.full(len(asset), series.basis, dtype=object),
        "return_status": status,
        "horizon_beyond_material": beyond,
        "entry_price_missing": entry_known & ~entry_ok,
        "exit_price_missing": exit_missing,
        "benchmark_missing": benchmark_missing,
        "interior_missing_sessions": _counts(interior, beyond),
        "disputed_sessions": _counts(disputed, beyond),
        "delisted_in_window": delisted,
        "exit_type": np.where(delisted, kinds, "").astype(object),
        "terminal_basis": terminal,
        "terminal_unknown": terminal_unknown,
        "post_exit_basis": post,
        "post_exit_sessions": pd.array(
            np.where(delisted, end - exit_at, 0), dtype="Int16"
        ),
        "return_reliable": pair_valid & (disputed == 0) & (post != "cash_proxy"),
        "pair_valid": pair_valid,
    }


def label_frame(
    samples: pd.DataFrame,
    series: ReturnSeries,
    cal: clocks.Calendar,
    *,
    horizon_list: Sequence[int],
    single: bool,
    benchmark_id: str,
    cutoff: date,
    policy: Mapping[str, Any],
    in_universe: pd.arrays.BooleanArray,
    static: bool,
) -> pd.DataFrame:
    """Labels for ``samples`` rows (order kept): standard columns for one int horizon,
    ``h{H}_`` prefixes for several, plus ``forward_excess_return_{H}d`` and
    ``trainable_{H}d = pair_valid & member & ~terminal_unknown & no disputed session``
    (membership NA counts as member only for a static universe)."""
    signal = cal.positions(samples["signal_session"])
    asset = series.columns(samples["asset_id"].astype(str))
    position = {asset: index for index, asset in enumerate(series.assets)}
    last = int(np.searchsorted(np.array(cal.days, dtype=object), cutoff, "right")) - 1
    member = np.asarray(in_universe.fillna(static), dtype=bool)
    result = samples[KEYS].reset_index(drop=True).copy()
    for horizon in horizon_list:
        values = horizon_labels(
            series,
            asset,
            signal,
            horizon,
            benchmark=position.get(benchmark_id, -1),
            cal=cal,
            last=last,
            policy=policy,
        )
        for name in CATEGORY_COLUMNS:
            values[name] = pd.Categorical(values[name])
        prefix = "" if single else f"h{horizon}_"
        part = pd.DataFrame({f"{prefix}{key}": item for key, item in values.items()})
        result = pd.concat([result, part], axis=1)
        result[f"forward_excess_return_{horizon}d"] = values["excess_return"]
        result[f"trainable_{horizon}d"] = (
            values["pair_valid"]
            & member
            & ~values["terminal_unknown"]
            & (values["disputed_sessions"].fillna(1).to_numpy(int) == 0)
        )
    result["in_universe"] = in_universe
    return result


def mask_counts(
    frame: pd.DataFrame,
    horizon_list: Sequence[int],
    single: bool,
    static: bool,
    dropped: int = 0,
) -> dict[str, Any]:
    """Masks per horizon: price gaps, disputed windows, unknown exits, non-members
    (the frame's rows outside the universe plus ``dropped`` rows removed before)."""
    member = np.asarray(frame["in_universe"].fillna(static), dtype=bool)
    result: dict[str, Any] = {}
    for horizon in horizon_list:
        prefix = "" if single else f"h{horizon}_"
        counts = {
            name: int(frame[f"{prefix}{name}"].sum())
            for name in MASKS
            if f"{prefix}{name}" in frame
        }
        counts["disputed_return"] = int(
            (frame[f"{prefix}disputed_sessions"].fillna(0) > 0).sum()
        )
        counts["not_in_universe"] = int((~member).sum()) + dropped
        counts["pair_valid"] = int(frame[f"{prefix}pair_valid"].sum())
        counts["trainable"] = int(frame[f"trainable_{horizon}d"].sum())
        counts["return_unreliable"] = int(
            (frame[f"{prefix}pair_valid"] & ~frame[f"{prefix}return_reliable"]).sum()
        )
        result[str(horizon)] = counts
    return result


def label_overlap(signal: np.ndarray, horizon_list: Sequence[int]) -> dict[str, float]:
    """H / median sessions between consecutive sampled signals (1 when there is one)."""
    steps = np.diff(np.unique(signal))
    step = float(np.median(steps)) if len(steps) else 1.0
    return {str(horizon): horizon / step for horizon in horizon_list}


def split_membership(
    frame: pd.DataFrame,
    *,
    train_end: date | str,
    validation_end: date | str,
    cal: clocks.Calendar,
    embargo_sessions: int = 0,
) -> pd.DataFrame:
    """Chronological train/validation/test membership. A row of an earlier split is
    purged when its label ends at or after the first decision of any later split (or
    has no end), and embargoed when its signal is within ``embargo_sessions`` sessions
    before the first signal of the nearest later split that has rows."""
    if isinstance(embargo_sessions, bool) or not isinstance(embargo_sessions, int):
        raise TypeError("embargo_sessions must be a non-negative integer")
    if embargo_sessions < 0:
        raise ValueError("embargo_sessions must be a non-negative integer")
    train_end, validation_end = clocks.day(train_end), clocks.day(validation_end)
    if not train_end < validation_end:
        raise ValueError("Require train_end < validation_end")
    result = frame[[*KEYS, "decision_at", "label_end"]].reset_index(drop=True).copy()
    signal = cal.positions(result["signal_session"])
    days = np.array(cal.days, dtype=object)[signal]
    order = np.select([days <= train_end, days <= validation_end], [0, 1], 2)
    result["split"] = np.array(["train", "validation", "test"], dtype=object)[order]
    result["purged"] = False
    result["purge_reason"] = ""
    # Each split is purged against every later one: an empty middle split must not
    # let train labels run into the test period.
    for split in (0, 1):
        later = order > split
        earlier = order == split
        if not later.any():
            continue
        next_decision = result.loc[later, "decision_at"].min()
        if pd.notna(next_decision):
            purge = (
                earlier
                & (
                    result["label_end"].isna() | (result["label_end"] >= next_decision)
                ).to_numpy()
            )
            result.loc[purge, "purged"] = True
            result.loc[purge, "purge_reason"] = "label_end_not_before_next_split"
        first = signal[later].min()
        embargo = (
            earlier
            & ~result["purged"].to_numpy()
            & (signal >= first - embargo_sessions)
        )
        result.loc[embargo, "purged"] = True
        result.loc[embargo, "purge_reason"] = "embargo"
    return result


def neutral_groups(
    frame: pd.DataFrame, name: str, universe_rows: Mapping[str, Mapping[str, Any]]
) -> pd.Series:
    """Group labels per row: ``size`` quintiles per signal session (market cap, else
    21-session or one-session dollar volume), a column of ``frame``, or a (non point-in-
    time) field of the universe entries."""
    if name == "size":
        for column in (
            "market_cap_issuer_value",
            "market_cap",
            "dollar_volume_21d_log",
            "raw_dollar_volume",
        ):
            if column in frame:
                ranks = frame.groupby("signal_session", sort=False)[column].rank(
                    pct=True
                )
                return np.ceil(ranks * SIZE_GROUPS).clip(1, SIZE_GROUPS)
        raise ValueError("size neutralization needs a size column in the samples")
    if name in frame:
        col = frame[name]
        if pd.api.types.is_object_dtype(col) or pd.api.types.is_string_dtype(col):
            return col.map(lambda v: None if v == "" else v)
        return col
    values = [
        universe_rows.get(str(asset), {}).get(name) for asset in frame["asset_id"]
    ]
    if all(value is None for value in values):
        raise ValueError(f"No neutralization group {name!r} in samples or universe")
    return pd.Series(values, index=frame.index, dtype=object)


def neutralize(
    labels: pd.DataFrame,
    groups: Mapping[str, pd.Series],
    horizon_list: Sequence[int],
    eligible: np.ndarray,
) -> pd.DataFrame:
    """``excess_return_{H}d_{group}``: excess return minus the mean over trainable,
    non-benchmark rows of the same signal session and group; groups with fewer than
    NEUTRAL_MIN_GROUP such rows use the session mean (``neutral_fallback_{H}d_{group}``).
    """
    result = labels
    for horizon in horizon_list:
        excess = labels[f"forward_excess_return_{horizon}d"]
        population = eligible & labels[f"trainable_{horizon}d"].to_numpy(bool)
        population &= np.isfinite(excess.to_numpy(float))
        session = labels["signal_session"]
        base = excess.where(population)
        session_mean = base.groupby(session).transform("mean")
        for name, group in groups.items():
            keys = [session, group.reset_index(drop=True)]
            group_mean = base.groupby(keys, dropna=False).transform("mean")
            group_size = base.groupby(keys, dropna=False).transform("count")
            fallback = (group_size < NEUTRAL_MIN_GROUP) | group.isna().to_numpy()
            mean = group_mean.where(~fallback, session_mean)
            result[f"excess_return_{horizon}d_{name}"] = excess - mean
            result[f"neutral_fallback_{horizon}d_{name}"] = fallback.to_numpy(bool) & (
                excess.notna().to_numpy()
            )
    return result


def limitations(
    universe_basis: str, return_basis: str, universe_groups: Sequence[str] = ()
) -> list[str]:
    lines = [
        (
            "Labels run from the entry session's open to the exit session's close at "
            "its frozen close time (16:00 New York when the version has none); "
            "interior sessions without a close are counted, a missing entry or exit "
            "price masks the label."
        )
    ]
    if return_basis == "total_return":
        lines.append(
            "Total-return labels follow daily_returns; after an exit inside the window "
            "cash is held flat and stock consideration follows the successor when it is "
            "frozen (else flat, cash_proxy); exits without a stored terminal value use "
            "terminal_policy (performance delistings -30 % from the last close by "
            "default, unknown exits masked); a disputed session of the asset, the "
            "successor it follows or the benchmark excludes the label from training."
        )
    else:
        lines.append(
            "Labels use vendor-adjusted prices (this version has no daily_returns): "
            "delistings inside the window mask the label."
        )
    if universe_basis == "static":
        lines.append(
            "Universe basis static: candidates are the frozen securities, not a "
            "point-in-time membership, so labels carry survivorship bias."
        )
    else:
        lines.append(
            "Universe basis pit: a row is a member when the monthly membership of its "
            "entry session's month says so."
        )
    if universe_groups:
        lines.append(
            f"Neutralization groups {', '.join(universe_groups)} use the frozen "
            "universe entries' current values, not point-in-time values."
        )
    return lines


def _prefix_window_sums(arr: np.ndarray, window: int) -> np.ndarray:
    """Causal rolling sum over ``[t - window + 1 .. t]`` along axis=1 for ``[N, T]``."""
    n_assets, n_sess = arr.shape
    csum = np.zeros((n_assets, n_sess + 1), dtype=np.float64)
    np.cumsum(arr, axis=1, out=csum[:, 1:])
    if window <= 1 or n_sess == 0:
        return arr.astype(np.float64, copy=True)
    left = np.zeros((n_assets, n_sess), dtype=np.float64)
    if n_sess > window:
        left[:, window:] = csum[:, 1 : n_sess - window + 1]
    return csum[:, 1:] - left


def welch_beta_252d(
    ret: np.ndarray,
    mkt_ret: np.ndarray,
    rf_daily: np.ndarray | None = None,
    *,
    bar_invalid: np.ndarray | None = None,
    window: int = 252,
    min_periods: int = 200,
) -> np.ndarray:
    """Causal Welch (2022) slope-winsorized 252d market beta without extra shrinkage.

    Clips each stock's daily excess return to ``[min(-2 r_m, 4 r_m), max(-2 r_m, 4 r_m)]``
    before regressing on ``r_m``. Sessions with ``< min_periods`` valid bars fall back to
    the same-day cross-sectional median beta.
    """
    r_arr = np.asarray(ret, dtype=np.float64)
    n_assets, n_sess = r_arr.shape
    out = np.full((n_assets, n_sess), np.nan, dtype=np.float64)
    if n_assets == 0 or n_sess == 0:
        return out
    mkt = np.asarray(mkt_ret, dtype=np.float64)[:n_sess]
    rf = (
        np.where(np.isfinite(rf_daily[:n_sess]), rf_daily[:n_sess], 0.0).astype(
            np.float64
        )
        if rf_daily is not None
        else np.zeros(n_sess, dtype=np.float64)
    )
    rm = mkt - rf
    ri = r_arr - rf[None, :]
    if bar_invalid is not None:
        bad = np.isfinite(bar_invalid) & (bar_invalid > 0.5)
        ri = np.where(bad, np.nan, ri)

    lo = np.minimum(-2.0 * rm, 4.0 * rm)
    hi = np.maximum(-2.0 * rm, 4.0 * rm)
    valid = np.isfinite(ri) & np.isfinite(rm)[None, :]
    ri_w = np.where(valid, np.clip(ri, lo[None, :], hi[None, :]), 0.0)
    x = np.where(valid, rm[None, :], 0.0)
    v_num = valid.astype(np.float64)

    w = int(window)
    mp = max(2, int(min_periods))
    cnt = _prefix_window_sums(v_num, w)
    sx = _prefix_window_sums(x, w)
    sy = _prefix_window_sums(ri_w, w)
    sxx = _prefix_window_sums(x * x, w)
    sxy = _prefix_window_sums(x * ri_w, w)

    with np.errstate(invalid="ignore", divide="ignore"):
        denom = sxx - (sx * sx) / cnt
        numer = sxy - (sx * sy) / cnt
        ok = (cnt >= mp) & (denom > 1e-12)
        out[ok] = numer[ok] / denom[ok]

    # Cross-sectional median fallback per day for newly listed / <min_periods stocks
    for t in range(n_sess):
        col = out[:, t]
        fin = np.isfinite(col)
        if fin.any() and not fin.all():
            med = float(np.median(col[fin]))
            out[~fin, t] = med
    return out


def residual_vol_63d(
    ret: np.ndarray,
    mkt_ret: np.ndarray,
    beta: np.ndarray,
    rf_daily: np.ndarray | None = None,
    *,
    bar_invalid: np.ndarray | None = None,
    window: int = 63,
    min_periods: int = 42,
    floor_quantile: float = 0.10,
) -> np.ndarray:
    """Causal 63d daily residual return volatility with cross-sectional floor protection."""
    r_arr = np.asarray(ret, dtype=np.float64)
    b_arr = np.asarray(beta, dtype=np.float64)
    n_assets, n_sess = r_arr.shape
    out = np.full((n_assets, n_sess), np.nan, dtype=np.float64)
    if n_assets == 0 or n_sess == 0:
        return out
    mkt = np.asarray(mkt_ret, dtype=np.float64)[:n_sess]
    rf = (
        np.where(np.isfinite(rf_daily[:n_sess]), rf_daily[:n_sess], 0.0).astype(
            np.float64
        )
        if rf_daily is not None
        else np.zeros(n_sess, dtype=np.float64)
    )
    rm = mkt - rf
    ri = r_arr - rf[None, :]
    if bar_invalid is not None:
        bad = np.isfinite(bar_invalid) & (bar_invalid > 0.5)
        ri = np.where(bad, np.nan, ri)

    valid = np.isfinite(ri) & np.isfinite(rm)[None, :]
    x = np.where(valid, rm[None, :], 0.0)
    y = np.where(valid, ri, 0.0)
    v_num = valid.astype(np.float64)

    w = int(window)
    mp = max(2, int(min_periods))
    cnt = _prefix_window_sums(v_num, w)
    sx = _prefix_window_sums(x, w)
    sy = _prefix_window_sums(y, w)
    sxx = _prefix_window_sums(x * x, w)
    syy = _prefix_window_sums(y * y, w)
    sxy = _prefix_window_sums(x * y, w)

    with np.errstate(invalid="ignore", divide="ignore"):
        dof = cnt - 1.0
        v_xx = (sxx - (sx * sx) / cnt) / dof
        v_yy = (syy - (sy * sy) / cnt) / dof
        c_xy = (sxy - (sx * sy) / cnt) / dof
        ok = (cnt >= mp) & np.isfinite(b_arr)
        resid_var = np.maximum(0.0, v_yy - 2.0 * b_arr * c_xy + (b_arr**2) * v_xx)
        out[ok] = np.sqrt(resid_var[ok])

    if 0.0 < floor_quantile < 1.0:
        for t in range(n_sess):
            col = out[:, t]
            fin = np.isfinite(col) & (col > 0.0)
            if fin.any():
                floor_t = float(np.quantile(col[fin], floor_quantile))
                out[fin, t] = np.maximum(col[fin], floor_t)
    return out


def gauss_rank_cross_section(
    values: np.ndarray,
    sessions: np.ndarray,
    valid_mask: np.ndarray,
) -> np.ndarray:
    """Cross-sectional GaussRank ``Phi^-1((rank - 0.5) / M)`` per signal session."""
    vals = np.asarray(values, dtype=np.float64)
    sess = np.asarray(sessions)
    mask = np.asarray(valid_mask, dtype=bool) & np.isfinite(vals)
    out = np.full(len(vals), np.nan, dtype=np.float64)
    if not mask.any():
        return out
    nd = NormalDist()
    inv_cdf = nd.inv_cdf
    valid_idx = np.flatnonzero(mask)
    sub_s = pd.Series(vals[valid_idx])
    sub_g = pd.Series(sess[valid_idx])
    for grp_pos in sub_g.groupby(sub_g, sort=False).groups.values():
        pos = np.asarray(grp_pos, dtype=np.int64)
        m = len(pos)
        if m == 0:
            continue
        ranks = sub_s.iloc[pos].rank(method="average").to_numpy(dtype=np.float64)
        u = np.clip((ranks - 0.5) / float(m), 1e-6, 1.0 - 1e-6)
        out[valid_idx[pos]] = np.fromiter(
            (inv_cdf(float(p)) for p in u), dtype=np.float64, count=m
        )
    return out


def attach_risk_adjusted_labels(
    labels_df: pd.DataFrame,
    anchors_frame: pd.DataFrame,
    price_store: Any,
    *,
    cal: clocks.Calendar,
    horizons: Sequence[int],
    rf_daily: Sequence[float] | np.ndarray | None = None,
    cutoff_date: date | None = None,
    benchmark_idx: int | None = None,
) -> pd.DataFrame:
    """Attach Welch 252d beta-adjusted IR / GaussRank labels and cutoff-clamped dense risk targets."""
    result = labels_df.copy()
    n_rows = len(result)
    if n_rows == 0 or price_store is None or price_store.data.shape[1] == 0:
        return result

    n_assets, n_sess = price_store.data.shape[0], price_store.data.shape[1]
    ret = price_store.channel("ret_1d").astype(np.float64)
    bar_inv = price_store.channel("bar_invalid").astype(np.float64)
    close_raw = price_store.channel("close_raw").astype(np.float64)
    vol_raw = price_store.channel("volume_raw").astype(np.float64)
    tr_lvl = price_store.channel("tr_index").astype(np.float64)
    adj_lvl = price_store.channel("close_adj").astype(np.float64)
    has_tr = np.any(np.isfinite(tr_lvl) & (tr_lvl > 0.0), axis=1, keepdims=True)
    lvl = np.where(has_tr, tr_lvl, adj_lvl)
    bad_mask = np.isfinite(bar_inv) & (bar_inv > 0.5)
    lvl = np.where(bad_mask | ~(np.isfinite(lvl) & (lvl > 0.0)), np.nan, lvl)

    b_idx = price_store.benchmark_idx if benchmark_idx is None else int(benchmark_idx)
    if 0 <= b_idx < n_assets:
        mkt_ret = ret[b_idx].copy()
        mkt_ret[bad_mask[b_idx]] = np.nan
    else:
        with np.errstate(invalid="ignore"):
            mkt_ret = np.nanmean(np.where(bad_mask, np.nan, ret), axis=0)

    rf_arr = np.zeros(n_sess, dtype=np.float64)
    if rf_daily is not None:
        raw_rf = np.asarray(rf_daily, dtype=np.float64)
        k_rf = min(len(raw_rf), n_sess)
        rf_arr[:k_rf] = np.where(np.isfinite(raw_rf[:k_rf]), raw_rf[:k_rf], 0.0)

    beta_mat = welch_beta_252d(
        ret, mkt_ret, rf_arr, bar_invalid=bar_inv, window=252, min_periods=200
    )
    rvol_mat = residual_vol_63d(
        ret,
        mkt_ret,
        beta_mat,
        rf_arr,
        bar_invalid=bar_inv,
        window=63,
        min_periods=42,
        floor_quantile=0.10,
    )

    ai = anchors_frame["asset_idx"].to_numpy(dtype=np.int64, copy=False)
    si = anchors_frame["session_idx"].to_numpy(dtype=np.int64, copy=False)
    in_bounds = (ai >= 0) & (ai < n_assets) & (si >= 0) & (si < n_sess)

    beta_row = np.full(n_rows, np.nan, dtype=np.float64)
    rvol_row = np.full(n_rows, np.nan, dtype=np.float64)
    beta_row[in_bounds] = beta_mat[ai[in_bounds], si[in_bounds]]
    rvol_row[in_bounds] = rvol_mat[ai[in_bounds], si[in_bounds]]
    result["welch_beta_252d"] = beta_row
    result["resid_vol_63d"] = rvol_row

    last_idx = n_sess - 1
    if cutoff_date is not None and len(cal.days):
        last_idx = min(
            last_idx,
            int(
                np.searchsorted(
                    np.array(cal.days, dtype=object), cutoff_date, side="right"
                )
            )
            - 1,
        )

    # Prefix log(1 + rf) for O(1) compounded horizon risk-free return over [entry .. end]
    log_rf_csum = np.zeros(n_sess + 1, dtype=np.float64)
    np.cumsum(np.log1p(np.clip(rf_arr, -0.5, 1.0)), out=log_rf_csum[1:])

    # Trailing 21d mean dollar volume & prefix sums for forward relative dollar volume
    ok_dv = (
        ~bad_mask
        & np.isfinite(close_raw)
        & (close_raw > 0.0)
        & np.isfinite(vol_raw)
        & (vol_raw >= 0.0)
    )
    dvol = np.where(ok_dv, close_raw * vol_raw, 0.0)
    dv_cnt_csum = np.zeros((n_assets, n_sess + 1), dtype=np.int32)
    dv_sum_csum = np.zeros((n_assets, n_sess + 1), dtype=np.float64)
    np.cumsum(ok_dv.astype(np.int32), axis=1, out=dv_cnt_csum[:, 1:])
    np.cumsum(dvol, axis=1, out=dv_sum_csum[:, 1:])

    # Prefix sums of daily excess returns & market excess returns for forward residual vol
    rm = mkt_ret - rf_arr
    ri = np.where(bad_mask, np.nan, ret - rf_arr[None, :])
    rv_ok = np.isfinite(ri) & np.isfinite(rm)[None, :]
    rx = np.where(rv_ok, rm[None, :], 0.0)
    ry = np.where(rv_ok, ri, 0.0)
    rc_csum = np.zeros((n_assets, n_sess + 1), dtype=np.int32)
    rx_csum = np.zeros((n_assets, n_sess + 1), dtype=np.float64)
    ry_csum = np.zeros((n_assets, n_sess + 1), dtype=np.float64)
    rxx_csum = np.zeros((n_assets, n_sess + 1), dtype=np.float64)
    ryy_csum = np.zeros((n_assets, n_sess + 1), dtype=np.float64)
    rxy_csum = np.zeros((n_assets, n_sess + 1), dtype=np.float64)
    np.cumsum(rv_ok.astype(np.int32), axis=1, out=rc_csum[:, 1:])
    np.cumsum(rx, axis=1, out=rx_csum[:, 1:])
    np.cumsum(ry, axis=1, out=ry_csum[:, 1:])
    np.cumsum(rx * rx, axis=1, out=rxx_csum[:, 1:])
    np.cumsum(ry * ry, axis=1, out=ryy_csum[:, 1:])
    np.cumsum(rx * ry, axis=1, out=rxy_csum[:, 1:])

    is_bench = (
        anchors_frame["is_benchmark"].fillna(False).to_numpy(dtype=bool)
        if "is_benchmark" in anchors_frame.columns
        else np.zeros(n_rows, dtype=bool)
    )
    sessions_col = result["signal_session"].to_numpy()

    for h in horizons:
        h_int = int(h)
        src_prefix = f"h{h_int}_" if f"h{h_int}_asset_return" in result.columns else ""
        a_ret = pd.to_numeric(
            result.get(f"{src_prefix}asset_return"), errors="coerce"
        ).to_numpy(dtype=np.float64)
        b_ret = pd.to_numeric(
            result.get(f"{src_prefix}benchmark_return"), errors="coerce"
        ).to_numpy(dtype=np.float64)
        pair_ok = (
            result[f"{src_prefix}pair_valid"].fillna(False).to_numpy(dtype=bool)
            if f"{src_prefix}pair_valid" in result.columns
            else (np.isfinite(a_ret) & np.isfinite(b_ret))
        )
        trainable = (
            result[f"trainable_{h_int}d"].fillna(False).to_numpy(dtype=bool)
            if f"trainable_{h_int}d" in result.columns
            else pair_ok
        )

        entry = si + 1
        end = si + h_int
        in_cut = in_bounds & (entry >= 0) & (end <= last_idx)

        rf_h = np.full(n_rows, np.nan, dtype=np.float64)
        if in_cut.any():
            e_ic = entry[in_cut]
            x_ic = end[in_cut]
            rf_h[in_cut] = np.expm1(log_rf_csum[x_ic + 1] - log_rf_csum[e_ic])

        beta_adj = np.where(
            pair_ok & in_cut & np.isfinite(beta_row) & np.isfinite(rf_h),
            (a_ret - rf_h) - beta_row * (b_ret - rf_h),
            np.nan,
        )
        sigma_h = rvol_row * math.sqrt(float(h_int))
        ir_ret = np.where(
            np.isfinite(beta_adj) & np.isfinite(sigma_h) & (sigma_h > 1e-8),
            beta_adj / sigma_h,
            np.nan,
        )
        gr_rank = gauss_rank_cross_section(
            ir_ret, sessions_col, trainable & ~is_bench & in_cut
        )

        # Cutoff-clamped dense forward risk targets over [entry .. end]
        fwd_rvol = np.full(n_rows, np.nan, dtype=np.float64)
        fwd_rel_dvol = np.full(n_rows, np.nan, dtype=np.float64)
        fwd_max_dd = np.full(n_rows, np.nan, dtype=np.float64)

        req_days = max(3, int(0.75 * h_int))
        if in_cut.any():
            ic_pos = np.flatnonzero(in_cut)
            a_ic = ai[ic_pos]
            e_ic = entry[ic_pos]
            x_ic = end[ic_pos]
            s_ic = si[ic_pos]
            b_ic = beta_row[ic_pos]

            c_w = (rc_csum[a_ic, x_ic + 1] - rc_csum[a_ic, e_ic]).astype(np.float64)
            sx_w = rx_csum[a_ic, x_ic + 1] - rx_csum[a_ic, e_ic]
            sy_w = ry_csum[a_ic, x_ic + 1] - ry_csum[a_ic, e_ic]
            sxx_w = rxx_csum[a_ic, x_ic + 1] - rxx_csum[a_ic, e_ic]
            syy_w = ryy_csum[a_ic, x_ic + 1] - ryy_csum[a_ic, e_ic]
            sxy_w = rxy_csum[a_ic, x_ic + 1] - rxy_csum[a_ic, e_ic]
            with np.errstate(invalid="ignore", divide="ignore"):
                dof_w = c_w - 1.0
                vxx_w = (sxx_w - (sx_w * sx_w) / c_w) / dof_w
                vyy_w = (syy_w - (sy_w * sy_w) / c_w) / dof_w
                cxy_w = (sxy_w - (sx_w * sy_w) / c_w) / dof_w
                ok_rv = (c_w >= req_days) & np.isfinite(b_ic)
                rvar_w = np.maximum(0.0, vyy_w - 2.0 * b_ic * cxy_w + (b_ic**2) * vxx_w)
                fwd_rvol[ic_pos[ok_rv]] = np.sqrt(rvar_w[ok_rv])

            # Forward mean dollar volume vs trailing 21d mean dollar volume
            f_cnt = dv_cnt_csum[a_ic, x_ic + 1] - dv_cnt_csum[a_ic, e_ic]
            f_sum = dv_sum_csum[a_ic, x_ic + 1] - dv_sum_csum[a_ic, e_ic]
            t_lo = np.maximum(0, s_ic - 20)
            t_cnt = dv_cnt_csum[a_ic, s_ic + 1] - dv_cnt_csum[a_ic, t_lo]
            t_sum = dv_sum_csum[a_ic, s_ic + 1] - dv_sum_csum[a_ic, t_lo]
            ok_dv_h = (
                (f_cnt >= req_days) & (t_cnt >= 15) & (f_sum > 0.0) & (t_sum > 0.0)
            )
            if ok_dv_h.any():
                f_mean = f_sum[ok_dv_h] / f_cnt[ok_dv_h]
                t_mean = t_sum[ok_dv_h] / t_cnt[ok_dv_h]
                fwd_rel_dvol[ic_pos[ok_dv_h]] = np.log(f_mean / t_mean)

            # Max peak-to-trough drawdown over [entry .. end]
            for j in range(len(ic_pos)):
                seg = lvl[a_ic[j], e_ic[j] : x_ic[j] + 1]
                fin = seg[np.isfinite(seg) & (seg > 0.0)]
                if len(fin) >= 2:
                    run_max = np.maximum.accumulate(fin)
                    fwd_max_dd[ic_pos[j]] = float(np.min(fin / run_max - 1.0))

        result[f"h{h_int}_rf_return"] = rf_h
        result[f"h{h_int}_beta_adj_return"] = beta_adj
        result[f"h{h_int}_ir_return"] = ir_ret
        result[f"h{h_int}_gauss_rank"] = gr_rank
        result[f"h{h_int}_fwd_rvol"] = fwd_rvol
        result[f"h{h_int}_fwd_max_dd"] = fwd_max_dd
        result[f"h{h_int}_fwd_rel_dvol"] = fwd_rel_dvol

    return result
