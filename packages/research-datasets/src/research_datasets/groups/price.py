"""Standard price, volatility, range-anchor, and liquidity-shock feature groups."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import numpy as np
import pandas as pd

from ..feature_groups import GroupBuildContext, register_feature_group
from ..stores import Anchors, PriceStore


def _select_at_anchors(matrix: np.ndarray, anchors: Anchors) -> np.ndarray:
    """Gather ``[N_anchors]`` float32 values from ``[N_assets, T_sessions]`` array."""
    ai = anchors.frame["asset_idx"].to_numpy(dtype=np.int64, copy=False)
    si = anchors.frame["session_idx"].to_numpy(dtype=np.int64, copy=False)
    out = np.full(len(ai), np.nan, dtype=np.float32)
    valid = (ai >= 0) & (ai < matrix.shape[0]) & (si >= 0) & (si < matrix.shape[1])
    out[valid] = matrix[ai[valid], si[valid]].astype(np.float32, copy=False)
    return out


def _effective_level(prices: PriceStore) -> np.ndarray:
    tr = prices.channel("tr_index").astype(np.float64)
    adj = prices.channel("close_adj").astype(np.float64)
    has_tr = np.any(np.isfinite(tr) & (tr > 0), axis=1, keepdims=True)
    lvl = np.where(has_tr, tr, adj)
    return np.where(np.isfinite(lvl) & (lvl > 0), lvl, np.nan)


def _suspect_prefix(prices: PriceStore) -> np.ndarray:
    susp = prices.channel("tr_suspect").astype(np.float64)
    is_susp = (np.isfinite(susp) & (susp > 0.5)).astype(np.int32)
    csus = np.zeros((is_susp.shape[0], is_susp.shape[1] + 1), dtype=np.int32)
    np.cumsum(is_susp, axis=1, out=csus[:, 1:])
    return csus


def _rolling_mean(
    arr: np.ndarray, window: int, min_periods: int | None = None
) -> np.ndarray:
    """Fast causal rolling mean over axis=1 for ``[N_assets, T_sessions]`` float64."""
    w = int(window)
    mp = w if min_periods is None else max(1, min(w, int(min_periods)))
    n_assets, n_sess = arr.shape
    out = np.full((n_assets, n_sess), np.nan, dtype=np.float64)
    if w <= 0 or n_sess == 0:
        return out
    finite = np.isfinite(arr)
    filled = np.where(finite, arr, 0.0)
    csum = np.zeros((n_assets, n_sess + 1), dtype=np.float64)
    ccnt = np.zeros((n_assets, n_sess + 1), dtype=np.int32)
    np.cumsum(filled, axis=1, out=csum[:, 1:])
    np.cumsum(finite.astype(np.int32), axis=1, out=ccnt[:, 1:])
    if w == 1:
        return np.where(finite, arr, np.nan)
    # Exact causal window [t - w + 1 .. t] using padded prefix
    if n_sess >= 1:
        left_s = np.zeros((n_assets, n_sess), dtype=np.float64)
        left_c = np.zeros((n_assets, n_sess), dtype=np.int32)
        if n_sess > w:
            left_s[:, w:] = csum[:, 1 : n_sess - w + 1]
            left_c[:, w:] = ccnt[:, 1 : n_sess - w + 1]
        win_s = csum[:, 1:] - left_s
        win_c = ccnt[:, 1:] - left_c
        ok = win_c >= mp
        out[ok] = win_s[ok] / win_c[ok]
    return out


def _rolling_std(
    arr: np.ndarray, window: int, min_periods: int | None = None
) -> np.ndarray:
    """Fast causal rolling sample std (ddof=1) over axis=1."""
    w = int(window)
    mp = max(2, w if min_periods is None else min(w, int(min_periods)))
    n_assets, n_sess = arr.shape
    out = np.full((n_assets, n_sess), np.nan, dtype=np.float64)
    if w < 2 or n_sess == 0:
        return out
    finite = np.isfinite(arr)
    filled = np.where(finite, arr, 0.0)
    csum = np.zeros((n_assets, n_sess + 1), dtype=np.float64)
    csum2 = np.zeros((n_assets, n_sess + 1), dtype=np.float64)
    ccnt = np.zeros((n_assets, n_sess + 1), dtype=np.int32)
    np.cumsum(filled, axis=1, out=csum[:, 1:])
    np.cumsum(filled * filled, axis=1, out=csum2[:, 1:])
    np.cumsum(finite.astype(np.int32), axis=1, out=ccnt[:, 1:])

    left_s = np.zeros((n_assets, n_sess), dtype=np.float64)
    left_s2 = np.zeros((n_assets, n_sess), dtype=np.float64)
    left_c = np.zeros((n_assets, n_sess), dtype=np.int32)
    if n_sess > w:
        left_s[:, w:] = csum[:, 1 : n_sess - w + 1]
        left_s2[:, w:] = csum2[:, 1 : n_sess - w + 1]
        left_c[:, w:] = ccnt[:, 1 : n_sess - w + 1]
    win_c = ccnt[:, 1:] - left_c
    win_s = csum[:, 1:] - left_s
    win_s2 = csum2[:, 1:] - left_s2
    ok = win_c >= mp
    var = np.full((n_assets, n_sess), np.nan, dtype=np.float64)
    with np.errstate(invalid="ignore", divide="ignore"):
        var[ok] = np.maximum(
            0.0, (win_s2[ok] - (win_s[ok] ** 2) / win_c[ok]) / (win_c[ok] - 1.0)
        )
    out[ok] = np.sqrt(var[ok])
    return out


def _rolling_extrema(arr: np.ndarray, window: int, *, mode: str) -> np.ndarray:
    """Causal rolling max/min over axis=1 using pandas on transpose only if needed."""
    w = int(window)
    n_assets, n_sess = arr.shape
    if n_sess == 0 or w <= 0:
        return np.full((n_assets, n_sess), np.nan, dtype=np.float64)
    mp = min(w, max(2, int(0.75 * w)))
    df = pd.DataFrame(arr.T)
    rolled = df.rolling(w, min_periods=mp)
    res = rolled.max() if mode == "max" else rolled.min()
    return res.to_numpy(dtype=np.float64).T


def _momentum_columns(params: Mapping[str, Any]) -> tuple[str, ...]:
    wins = [int(w) for w in params.get("windows", (1, 5, 10, 21, 63, 126, 252))]
    cols = [f"pmom_ret_{w}d" for w in wins]
    if 252 in wins and 21 in wins:
        cols.append("pmom_ret_252d_skip21d")
    cols.extend(("pmom_overnight_gap_21d", "pmom_intraday_ret_21d"))
    return tuple(cols)


@register_feature_group(
    "price_momentum_reversal",
    dynamic_columns_fn=_momentum_columns,
    default_params={"windows": [1, 5, 10, 21, 63, 126, 252]},
    description="Multi-horizon total-return momentum, 12m-1m skip-month, overnight/intraday decomposition.",
)
def build_price_momentum_reversal(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    prices = ctx.stores.prices
    anchors = ctx.stores.anchors
    wins = [int(w) for w in params.get("windows", (1, 5, 10, 21, 63, 126, 252))]
    lvl = _effective_level(prices)
    n_assets, n_sess = lvl.shape
    valid_lvl = np.isfinite(lvl) & (lvl > 0)
    ccnt = np.zeros((n_assets, n_sess + 1), dtype=np.int32)
    np.cumsum(valid_lvl.astype(np.int32), axis=1, out=ccnt[:, 1:])
    csus = _suspect_prefix(prices)

    data: dict[str, np.ndarray] = {}
    for w in wins:
        mat = np.full((n_assets, n_sess), np.nan, dtype=np.float64)
        if 0 < w < n_sess:
            p1 = lvl[:, w:]
            p0 = lvl[:, :-w]
            req = w + 1 if w <= 21 else max(2, int(0.8 * (w + 1)))
            cnt = ccnt[:, w + 1 :] - ccnt[:, : -(w + 1)]
            clean = (csus[:, w + 1 :] - csus[:, 1:-w]) == 0
            ok = (
                (p1 > 0)
                & (p0 > 0)
                & np.isfinite(p1)
                & np.isfinite(p0)
                & (cnt >= req)
                & clean
            )
            mat[:, w:][ok] = p1[ok] / p0[ok] - 1.0
        data[f"pmom_ret_{w}d"] = _select_at_anchors(mat, anchors)

    if 252 in wins and 21 in wins:
        mat = np.full((n_assets, n_sess), np.nan, dtype=np.float64)
        if n_sess > 252:
            p1 = lvl[:, 231:-21]
            p0 = lvl[:, :-252]
            cnt = ccnt[:, 232:-21] - ccnt[:, :-253]
            clean = (csus[:, 232:-21] - csus[:, 1:-252]) == 0
            ok = (
                (p1 > 0)
                & (p0 > 0)
                & np.isfinite(p1)
                & np.isfinite(p0)
                & (cnt >= int(0.8 * 232))
                & clean
            )
            mat[:, 252:][ok] = p1[ok] / p0[ok] - 1.0
        data["pmom_ret_252d_skip21d"] = _select_at_anchors(mat, anchors)

    over = _rolling_mean(
        prices.channel("overnight_ret").astype(np.float64), 21, min_periods=15
    )
    intra = _rolling_mean(
        prices.channel("intraday_ret").astype(np.float64), 21, min_periods=15
    )
    data["pmom_overnight_gap_21d"] = _select_at_anchors(over, anchors)
    data["pmom_intraday_ret_21d"] = _select_at_anchors(intra, anchors)
    return pd.DataFrame(data, index=anchors.frame.index)


def _vol_beta_columns(params: Mapping[str, Any]) -> tuple[str, ...]:
    wins = [int(w) for w in params.get("windows", (5, 21, 63))]
    return (
        *(f"pvol_rvol_{w}d" for w in wins),
        "pvol_downside_21d",
        "pvol_upside_downside_ratio_21d",
        "pvol_parkinson_hl_21d",
        "pvol_mkt_beta_63d",
        "pvol_idio_vol_63d",
    )


@register_feature_group(
    "price_vol_beta",
    dynamic_columns_fn=_vol_beta_columns,
    default_params={"windows": [5, 21, 63]},
    description="Realized vol, downside semi-vol, Parkinson range vol, 63d market beta & idio vol.",
)
def build_price_vol_beta(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    prices = ctx.stores.prices
    anchors = ctx.stores.anchors
    wins = [int(w) for w in params.get("windows", (5, 21, 63))]
    ret = prices.channel("ret_1d").astype(np.float64)
    n_assets, n_sess = ret.shape
    data: dict[str, np.ndarray] = {}
    for w in wins:
        mp = w if w <= 21 else max(21, int(0.8 * w))
        rv = _rolling_std(ret, w, min_periods=mp)
        data[f"pvol_rvol_{w}d"] = _select_at_anchors(rv, anchors)

    neg_ret = np.where(np.isfinite(ret), np.minimum(ret, 0.0), np.nan)
    pos_ret = np.where(np.isfinite(ret), np.maximum(ret, 0.0), np.nan)
    down_21 = np.sqrt(_rolling_mean(neg_ret * neg_ret, 21, min_periods=15))
    up_21 = np.sqrt(_rolling_mean(pos_ret * pos_ret, 21, min_periods=15))
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = np.where(down_21 > 1e-8, up_21 / down_21, np.nan)
    data["pvol_downside_21d"] = _select_at_anchors(down_21, anchors)
    data["pvol_upside_downside_ratio_21d"] = _select_at_anchors(ratio, anchors)

    hi = prices.channel("high_raw").astype(np.float64)
    lo = prices.channel("low_raw").astype(np.float64)
    ok_hl = np.isfinite(hi) & np.isfinite(lo) & (lo > 0) & (hi >= lo)
    hl_sq = np.full((n_assets, n_sess), np.nan, dtype=np.float64)
    hl_sq[ok_hl] = np.log(hi[ok_hl] / lo[ok_hl]) ** 2 / (4.0 * np.log(2.0))
    park_21 = np.sqrt(np.maximum(0.0, _rolling_mean(hl_sq, 21, min_periods=15)))
    data["pvol_parkinson_hl_21d"] = _select_at_anchors(park_21, anchors)

    if prices.benchmark_idx >= 0 and prices.benchmark_idx < n_assets:
        mkt = ret[prices.benchmark_idx : prices.benchmark_idx + 1, :]
    else:
        with np.errstate(invalid="ignore"):
            mkt = np.nanmean(ret, axis=0, keepdims=True)
    rm = np.broadcast_to(mkt, (n_assets, n_sess))
    valid_pair = np.isfinite(ret) & np.isfinite(rm)
    x = np.where(valid_pair, rm, np.nan)
    y = np.where(valid_pair, ret, np.nan)
    mx = _rolling_mean(x, 63, min_periods=42)
    my = _rolling_mean(y, 63, min_periods=42)
    mxy = _rolling_mean(x * y, 63, min_periods=42)
    vx = _rolling_std(x, 63, min_periods=42) ** 2
    vy = _rolling_std(y, 63, min_periods=42) ** 2
    cov = (mxy - mx * my) * (63.0 / 62.0)
    beta = np.where(vx > 1e-12, cov / vx, np.nan)
    idio_var = np.maximum(0.0, vy - (beta**2) * vx)
    idio = np.where(np.isfinite(beta) & np.isfinite(vy), np.sqrt(idio_var), np.nan)
    data["pvol_mkt_beta_63d"] = _select_at_anchors(beta, anchors)
    data["pvol_idio_vol_63d"] = _select_at_anchors(idio, anchors)
    return pd.DataFrame(data, index=anchors.frame.index)


def _range_anchor_columns(params: Mapping[str, Any]) -> tuple[str, ...]:
    wins = [int(w) for w in params.get("windows", (21, 63, 200, 252))]
    cols = [
        "prange_dist_high_21d",
        "prange_dist_low_21d",
        "prange_dist_high_252d",
        "prange_dist_low_252d",
    ]
    for w in wins:
        if w != 252:
            cols.append(f"prange_ma_gap_{w}d")
    return tuple(dict.fromkeys(cols))


@register_feature_group(
    "price_range_anchor",
    dynamic_columns_fn=_range_anchor_columns,
    default_params={"windows": [21, 63, 200, 252]},
    description="Distance from split-adjusted rolling highs/lows and moving averages.",
)
def build_price_range_anchor(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    prices = ctx.stores.prices
    anchors = ctx.stores.anchors
    close_raw = prices.channel("close_raw").astype(np.float64)
    hi_raw = prices.channel("high_raw").astype(np.float64)
    lo_raw = prices.channel("low_raw").astype(np.float64)
    lvl = _effective_level(prices)
    ok_scale = np.isfinite(close_raw) & (close_raw > 0) & np.isfinite(lvl) & (lvl > 0)
    hi_tr = np.where(
        ok_scale & np.isfinite(hi_raw) & (hi_raw > 0),
        np.maximum(lvl, lvl * (hi_raw / close_raw)),
        lvl,
    )
    lo_tr = np.where(
        ok_scale & np.isfinite(lo_raw) & (lo_raw > 0),
        np.minimum(lvl, lvl * (lo_raw / close_raw)),
        lvl,
    )

    csus = _suspect_prefix(prices)
    n_sess = lvl.shape[1]
    data: dict[str, np.ndarray] = {}
    for w in (21, 252):
        rmax = _rolling_extrema(hi_tr, w, mode="max")
        rmin = _rolling_extrema(lo_tr, w, mode="min")
        d_hi = np.where((rmax > 0) & np.isfinite(lvl), lvl / rmax - 1.0, np.nan)
        d_lo = np.where((rmin > 0) & np.isfinite(lvl), lvl / rmin - 1.0, np.nan)
        left_su = np.zeros_like(csus[:, 1:])
        if n_sess >= w:
            left_su[:, w - 1 :] = csus[:, 1 : n_sess - w + 2]
        bad_win = (csus[:, 1:] - left_su) > 0
        d_hi[bad_win] = np.nan
        d_lo[bad_win] = np.nan
        data[f"prange_dist_high_{w}d"] = _select_at_anchors(d_hi, anchors)
        data[f"prange_dist_low_{w}d"] = _select_at_anchors(d_lo, anchors)

    for w in [int(x) for x in params.get("windows", (21, 63, 200, 252))]:
        if w == 252:
            continue
        ma = _rolling_mean(lvl, w, min_periods=max(5, int(0.75 * w)))
        gap = np.where((ma > 0) & np.isfinite(lvl), lvl / ma - 1.0, np.nan)
        left_su = np.zeros_like(csus[:, 1:])
        if n_sess >= w:
            left_su[:, w - 1 :] = csus[:, 1 : n_sess - w + 2]
        gap[(csus[:, 1:] - left_su) > 0] = np.nan
        data[f"prange_ma_gap_{w}d"] = _select_at_anchors(gap, anchors)

    return pd.DataFrame(data, index=anchors.frame.index)


_LIQUIDITY_COLS = (
    "pliq_dvol_log_21d",
    "pliq_rel_vol_5d_63d",
    "pliq_amihud_21d",
    "pliq_intraday_spread_21d",
    "pliq_vwap_close_gap_5d",
    "pliq_trade_intensity_21d",
    "pliq_trade_shock_5d_63d",
)


@register_feature_group(
    "price_liquidity_shock",
    columns=_LIQUIDITY_COLS,
    default_params={"windows": [5, 21, 63]},
    description="Dollar-volume scale, short-vs-long volume shock, Amihud illiquidity, spread, VWAP & trade intensity.",
)
def build_price_liquidity_shock(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    del params
    prices = ctx.stores.prices
    anchors = ctx.stores.anchors
    close_r = prices.channel("close_raw").astype(np.float64)
    vol_r = prices.channel("volume_raw").astype(np.float64)
    hi_r = prices.channel("high_raw").astype(np.float64)
    lo_r = prices.channel("low_raw").astype(np.float64)
    vwap_r = prices.channel("vwap_raw").astype(np.float64)
    tc_r = prices.channel("trade_count_raw").astype(np.float64)
    ret = prices.channel("ret_1d").astype(np.float64)

    ok_dv = np.isfinite(close_r) & (close_r > 0) & np.isfinite(vol_r) & (vol_r >= 0)
    dvol = np.where(ok_dv, close_r * vol_r, np.nan)
    dv5 = _rolling_mean(dvol, 5, min_periods=3)
    dv21 = _rolling_mean(dvol, 21, min_periods=15)
    dv63 = _rolling_mean(dvol, 63, min_periods=42)

    dvol_log_21 = np.where(np.isfinite(dv21) & (dv21 >= 0), np.log1p(dv21), np.nan)
    with np.errstate(divide="ignore", invalid="ignore"):
        rel_vol = np.where(
            np.isfinite(dv5) & np.isfinite(dv63) & (dv63 > 0), dv5 / dv63, np.nan
        )

    dvol_m = np.where(ok_dv & (dvol > 0), np.maximum(dvol / 1e6, 1e-6), np.nan)
    illiq_raw = np.where(
        np.isfinite(ret) & np.isfinite(dvol_m), np.abs(ret) / dvol_m, np.nan
    )
    amihud_21 = _rolling_mean(illiq_raw, 21, min_periods=15)

    hl_spread = np.where(
        np.isfinite(close_r)
        & (close_r > 0)
        & np.isfinite(hi_r)
        & np.isfinite(lo_r)
        & (hi_r >= lo_r),
        (hi_r - lo_r) / close_r,
        np.nan,
    )
    spread_21 = _rolling_mean(hl_spread, 21, min_periods=15)

    vwap_gap = np.where(
        np.isfinite(vwap_r) & (vwap_r > 0) & np.isfinite(close_r) & (close_r > 0),
        (close_r - vwap_r) / vwap_r,
        np.nan,
    )
    vwap_gap_5 = _rolling_mean(vwap_gap, 5, min_periods=3)

    tc_clean = np.where(np.isfinite(tc_r) & (tc_r >= 0), tc_r, np.nan)
    tc5 = _rolling_mean(tc_clean, 5, min_periods=3)
    tc21 = _rolling_mean(tc_clean, 21, min_periods=15)
    tc63 = _rolling_mean(tc_clean, 63, min_periods=42)
    tc_log_21 = np.where(np.isfinite(tc21) & (tc21 >= 0), np.log1p(tc21), np.nan)
    with np.errstate(divide="ignore", invalid="ignore"):
        tc_shock = np.where(
            np.isfinite(tc5) & np.isfinite(tc63) & (tc63 > 0), tc5 / tc63, np.nan
        )

    return pd.DataFrame(
        {
            "pliq_dvol_log_21d": _select_at_anchors(dvol_log_21, anchors),
            "pliq_rel_vol_5d_63d": _select_at_anchors(rel_vol, anchors),
            "pliq_amihud_21d": _select_at_anchors(amihud_21, anchors),
            "pliq_intraday_spread_21d": _select_at_anchors(spread_21, anchors),
            "pliq_vwap_close_gap_5d": _select_at_anchors(vwap_gap_5, anchors),
            "pliq_trade_intensity_21d": _select_at_anchors(tc_log_21, anchors),
            "pliq_trade_shock_5d_63d": _select_at_anchors(tc_shock, anchors),
        },
        index=anchors.frame.index,
    )


# Backward-compatible Phase I YAML aliases -------------------------------------------------


@register_feature_group(
    "price_returns_vol",
    dynamic_columns_fn=lambda p: (
        *(f"pmom_ret_{int(w)}d" for w in p.get("windows", (1, 5, 21, 63, 126, 252))),
        "pvol_rvol_21d",
        "pvol_rvol_63d",
    ),
    default_params={"windows": [1, 5, 21, 63, 126, 252]},
)
def build_price_returns_vol_compat(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    wins = [int(w) for w in params.get("windows", (1, 5, 21, 63, 126, 252))]
    m = build_price_momentum_reversal(ctx, {"windows": wins})
    v = build_price_vol_beta(ctx, {"windows": [21, 63]})
    cols = {f"pmom_ret_{w}d": m[f"pmom_ret_{w}d"] for w in wins}
    cols["pvol_rvol_21d"] = v["pvol_rvol_21d"]
    cols["pvol_rvol_63d"] = v["pvol_rvol_63d"]
    return pd.DataFrame(cols, index=ctx.stores.anchors.frame.index)


@register_feature_group(
    "price_liquidity",
    columns=_LIQUIDITY_COLS,
    default_params={"windows": [21, 63]},
)
def build_price_liquidity_compat(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    return build_price_liquidity_shock(ctx, params)


@register_feature_group(
    "price_technical",
    dynamic_columns_fn=_range_anchor_columns,
    default_params={"windows": [14, 21, 63, 252]},
)
def build_price_technical_compat(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    return build_price_range_anchor(ctx, params)


@register_feature_group(
    "price_cross_section",
    columns=("cs_z_ret_21d", "cs_z_rvol_21d", "cs_z_dvol_log_21d"),
    default_params={"winsorize_z": 3.0},
)
def build_price_cross_section(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    anchors = ctx.stores.anchors
    cap = float(params.get("winsorize_z", 3.0))
    mom = build_price_momentum_reversal(ctx, {"windows": [21]})["pmom_ret_21d"]
    vol = build_price_vol_beta(ctx, {"windows": [21]})["pvol_rvol_21d"]
    liq = build_price_liquidity_shock(ctx, {})["pliq_dvol_log_21d"]
    sessions = anchors.frame["session_idx"].to_numpy(copy=False)

    def _z(series: pd.Series) -> np.ndarray:
        vals = pd.to_numeric(series, errors="coerce")
        grp = vals.groupby(sessions, sort=False)
        mean = grp.transform("mean")
        std = grp.transform("std")
        z = np.where(std > 1e-8, (vals - mean) / std, np.nan)
        return np.clip(z, -cap, cap).astype(np.float32)

    return pd.DataFrame(
        {
            "cs_z_ret_21d": _z(mom),
            "cs_z_rvol_21d": _z(vol),
            "cs_z_dvol_log_21d": _z(liq),
        },
        index=anchors.frame.index,
    )
