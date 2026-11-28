"""Domain feature groups wrapping PIT fundamentals, events, news, macro, alt data & LLM facts."""

from __future__ import annotations

import gc
import importlib
import math
from collections.abc import Mapping, Sequence
from typing import Any

import numpy as np
import pandas as pd
import pyarrow as pa

from .. import candidates as _candidates
from .. import clocks
from .. import events as _events
from .. import fundamentals_derived as _fund
from .. import sec_events as _sec_events
from ..concepts import DEFAULT_VIEWS
from ..feature_groups import GroupBuildContext, register_feature_group

# Load submodules via importlib to avoid top-level function shadowing in package __init__
_extra_features = importlib.import_module("research_datasets.extra_features")
_industry = importlib.import_module("research_datasets.industry")
_release = importlib.import_module("research_datasets.release_features")
_valuation = importlib.import_module("research_datasets.valuation")

_USABLE_FUND_STATUSES = frozenset({"ok", "approximate"})
_USABLE_VAL_STATUSES = frozenset({"ok", "approximate", "split_unverified"})
_REV_MASK_VIEWS = frozenset(
    {
        "revenue_q",
        "revenue_ttm",
        "revenue_fy",
        "revenue_q_yoy",
        "revenue_ttm_yoy",
        "gross_margin_ttm",
        "operating_margin_ttm",
        "net_margin_ttm",
        "fcf_margin_ttm",
        "sales_yield",
        "ev_to_sales",
        "earn_sue_revenue",
    }
)


def _sic_financial_mask(ctx: GroupBuildContext) -> np.ndarray:
    if "fundamentals" not in ctx.families and "issuer_profiles" not in ctx.families:
        return np.zeros(len(ctx.samples), dtype=bool)
    ind = _industry.industry(ctx.version, ctx.samples, time_policy=ctx.time_policy)
    if "sic" not in ind.columns:
        return np.zeros(len(ctx.samples), dtype=bool)
    sic = pd.to_numeric(ind["sic"], errors="coerce").to_numpy(dtype=np.float64)
    return ((sic >= 6000.0) & (sic <= 6199.0)) | ((sic >= 6300.0) & (sic <= 6399.0))


def _float32_col(series: Any, n: int, index: pd.Index) -> np.ndarray:
    if series is None:
        return np.full(n, np.nan, dtype=np.float32)
    return pd.to_numeric(series, errors="coerce").to_numpy(dtype=np.float32)


_FUND_STORE_SUMMARY_COLS = (
    "fund_visible_quarters",
    "fund_latest_pre_ret_21d",
    "fund_latest_post_1d_ret",
    "fund_latest_post_3d_ret",
)

_FUND_PIT_COLUMNS = (
    *(f"{v}_value" for v in DEFAULT_VIEWS),
    *(f"{v}_age_days" for v in DEFAULT_VIEWS),
    *_FUND_STORE_SUMMARY_COLS,
)


@register_feature_group(
    "fundamentals_pit",
    columns=_FUND_PIT_COLUMNS,
    default_params={"stale_days": 180},
    description="As-filed PIT derived financial statement views + FundStore historical depth.",
)
def build_fundamentals_pit(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    stale_days = int(params.get("stale_days", 180))
    af = ctx.stores.anchors.frame
    n = len(af)
    fin_mask = _sic_financial_mask(ctx)
    data: dict[str, np.ndarray] = {}

    if "fundamentals" in ctx.families:
        derived = ctx.derived_fundamentals(stale_days=stale_days)
        for view in DEFAULT_VIEWS:
            val_col = f"{view}_value"
            st_col = f"{view}_status"
            age_col = f"{view}_age_days"
            vals = (
                pd.to_numeric(derived[val_col], errors="coerce").to_numpy(
                    dtype=np.float32, copy=True
                )
                if val_col in derived.columns
                else np.full(n, np.nan, dtype=np.float32)
            )
            ages = (
                pd.to_numeric(derived[age_col], errors="coerce").to_numpy(
                    dtype=np.float32, copy=True
                )
                if age_col in derived.columns
                else np.full(n, np.nan, dtype=np.float32)
            )
            if st_col in derived.columns:
                usable = (
                    derived[st_col]
                    .astype(object)
                    .isin(_USABLE_FUND_STATUSES)
                    .to_numpy(dtype=bool)
                )
                vals[~usable] = np.nan
            if view in _REV_MASK_VIEWS and fin_mask.any():
                vals[fin_mask] = np.nan
                ages[fin_mask] = np.nan
            data[val_col] = vals
            data[age_col] = ages
    else:
        for view in DEFAULT_VIEWS:
            data[f"{view}_value"] = np.full(n, np.nan, dtype=np.float32)
            data[f"{view}_age_days"] = np.full(n, np.nan, dtype=np.float32)

    # FundStore untruncated historical quarter count & causal filing-event cross-bindings
    fstore = ctx.stores.fundamentals
    snap_ids = af["fund_snap_id"].to_numpy(dtype=np.int64, copy=False)
    dec_ns = clocks.instants(af["decision_at"].to_numpy(dtype=object))
    q_count = np.full(n, np.nan, dtype=np.float32)
    pre_21 = np.full(n, np.nan, dtype=np.float32)
    post_1 = np.full(n, np.nan, dtype=np.float32)
    post_3 = np.full(n, np.nan, dtype=np.float32)
    valid = (
        (snap_ids >= 0)
        & ((snap_ids + 1) < len(fstore.snap_offsets))
        & (dec_ns != clocks.NAT)
    )
    if valid.any():
        vs = snap_ids[valid]
        vd = dec_ns[valid]
        q_count[valid] = (fstore.snap_offsets[vs + 1] - fstore.snap_offsets[vs]).astype(
            np.float32
        )
        pre_21[valid] = fstore.snap_pre_ret_21d[vs].astype(np.float32)
        r1_ok = fstore.snap_post_1d_ready_ns[vs] <= vd
        r3_ok = fstore.snap_post_3d_ready_ns[vs] <= vd
        post_1[valid] = np.where(r1_ok, fstore.snap_post_1d_ret[vs], np.nan).astype(
            np.float32
        )
        post_3[valid] = np.where(r3_ok, fstore.snap_post_3d_ret[vs], np.nan).astype(
            np.float32
        )
    data["fund_visible_quarters"] = q_count
    data["fund_latest_pre_ret_21d"] = pre_21
    data["fund_latest_post_1d_ret"] = post_1
    data["fund_latest_post_3d_ret"] = post_3
    return pd.DataFrame(data, index=af.index)


_FACTOR_COLS = (
    *(f"{name}_value" for name in _fund.FACTOR_NAMES),
    "ind_ff12_code",
)


@register_feature_group(
    "fundamental_quality",
    columns=_FACTOR_COLS,
    description="Profitability, margin, asset growth, accruals, leverage, and FF12 industry code.",
)
def build_fundamental_quality(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    del params
    af = ctx.stores.anchors.frame
    n = len(af)
    fin_mask = _sic_financial_mask(ctx)
    data: dict[str, np.ndarray] = {}
    if "fundamentals" in ctx.families:
        derived = ctx.derived_fundamentals()
        factors = _fund.fundamental_factors(derived)
        for name in _fund.FACTOR_NAMES:
            val_col = f"{name}_value"
            st_col = f"{name}_status"
            vals = pd.to_numeric(factors.get(val_col), errors="coerce").to_numpy(
                dtype=np.float32, copy=True
            )
            if st_col in factors.columns:
                usable = (
                    factors[st_col]
                    .astype(object)
                    .isin(_USABLE_FUND_STATUSES)
                    .to_numpy(dtype=bool)
                )
                vals[~usable] = np.nan
            if name in _REV_MASK_VIEWS and fin_mask.any():
                vals[fin_mask] = np.nan
            data[val_col] = vals
    else:
        for name in _fund.FACTOR_NAMES:
            data[f"{name}_value"] = np.full(n, np.nan, dtype=np.float32)

    ind = _industry.industry(ctx.version, ctx.samples, time_policy=ctx.time_policy)
    ff12_map = {code: idx for idx, code in enumerate(_industry.FF12_CODES)}
    if "ff12" in ind.columns:
        codes = ind["ff12"].astype(object).map(ff12_map)
        data["ind_ff12_code"] = pd.to_numeric(codes, errors="coerce").to_numpy(
            dtype=np.float32
        )
    else:
        data["ind_ff12_code"] = np.full(n, np.nan, dtype=np.float32)
    return pd.DataFrame(data, index=af.index)


_RESTATEMENT_COLS = (
    "restate_ni_assets",
    "restate_rev_assets",
    "restate_ni_count_4q",
    "restate_rev_count_4q",
    "restate_any_downward_4q",
    "restate_sec_non_reliance_365d",
    "restate_sec_amendment_365d",
)
_AMENDMENT_EVENT_KINDS = frozenset(
    {"annual_report_amendment", "quarterly_report_amendment"}
)


@register_feature_group(
    "fundamental_restatement",
    columns=_RESTATEMENT_COLS,
    default_params={"lookback_days": 365, "quarters": 4},
    description="Zero-LLM PIT financial restatement deltas from FundStore snapshots + SEC 8-K 4.02 / 10-K/Q-A flags.",
)
def build_fundamental_restatement(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    af = ctx.stores.anchors.frame
    n = len(af)
    data = {col: np.full(n, np.nan, dtype=np.float32) for col in _RESTATEMENT_COLS}
    if n == 0:
        return pd.DataFrame(data, index=af.index)

    n_q = max(1, int(params.get("quarters", 4)))
    lookback_days = max(30, int(params.get("lookback_days", 365)))
    lookback_ns = lookback_days * 86_400_000_000_000
    fin_mask = _sic_financial_mask(ctx)

    # Part 1: Strictly causal per-snapshot restatement deltas from FundStore
    fstore = ctx.stores.fundamentals
    n_snaps = max(0, len(fstore.snap_offsets) - 1)
    if n_snaps > 0:
        from ..stores import FUND_CHANNELS

        ch_pos = {name: i for i, name in enumerate(FUND_CHANNELS)}
        idx_ni = ch_pos["net_income"]
        idx_rev = ch_pos["revenue"]
        idx_ta = ch_pos["total_assets"]

        snap_ni_assets = np.full(n_snaps, np.nan, dtype=np.float32)
        snap_rev_assets = np.full(n_snaps, np.nan, dtype=np.float32)
        snap_ni_cnt = np.full(n_snaps, np.nan, dtype=np.float32)
        snap_rev_cnt = np.full(n_snaps, np.nan, dtype=np.float32)
        snap_down = np.full(n_snaps, np.nan, dtype=np.float32)

        q_vals = fstore.quarter_values
        q_ords = fstore.quarter_period_end_ordinals
        offs = fstore.snap_offsets

        for c_idx in range(len(fstore.ciks)):
            lo_s = int(fstore.cik_snap_starts[c_idx])
            hi_s = int(fstore.cik_snap_ends[c_idx])
            if hi_s <= lo_s:
                continue
            first_ni: dict[int, float] = {}
            first_rev: dict[int, float] = {}
            for s_id in range(lo_s, hi_s):
                r0 = int(offs[s_id])
                r1 = int(offs[s_id + 1])
                if r1 <= r0:
                    continue
                vals_s = q_vals[r0:r1]
                ords_s = q_ords[r0:r1]

                # Record first-reported value per fiscal period strictly chronologically
                ni_col = vals_s[:, idx_ni]
                rev_col = vals_s[:, idx_rev]
                ta_col = vals_s[:, idx_ta]
                ni_pairs: list[tuple[int, float]] = []
                rev_pairs: list[tuple[int, float]] = []
                latest_ta = float("nan")
                for row_k in range(len(ords_s)):
                    pe = int(ords_s[row_k])
                    ni_v = float(ni_col[row_k])
                    if math.isfinite(ni_v):
                        if pe not in first_ni:
                            first_ni[pe] = ni_v
                        ni_pairs.append((pe, ni_v))
                    rev_v = float(rev_col[row_k])
                    if math.isfinite(rev_v):
                        if pe not in first_rev:
                            first_rev[pe] = rev_v
                        rev_pairs.append((pe, rev_v))
                    ta_v = float(ta_col[row_k])
                    if math.isfinite(ta_v) and ta_v > 0.0:
                        latest_ta = ta_v

                if not math.isfinite(latest_ta) or latest_ta <= 0.0:
                    continue
                tol = max(1e-4 * latest_ta, 1e4)
                if ni_pairs:
                    recent_ni = ni_pairs[-n_q:]
                    ni_sum = 0.0
                    ni_c = 0
                    down_flag = 0.0
                    for pe, cur_v in recent_ni:
                        d_v = cur_v - first_ni[pe]
                        ni_sum += d_v
                        if abs(d_v) > tol:
                            ni_c += 1
                        if d_v < -tol:
                            down_flag = 1.0
                    snap_ni_assets[s_id] = np.float32(
                        np.clip(ni_sum / latest_ta, -2.0, 2.0)
                    )
                    snap_ni_cnt[s_id] = np.float32(ni_c)
                    snap_down[s_id] = np.float32(down_flag)
                if rev_pairs:
                    recent_rev = rev_pairs[-n_q:]
                    rev_sum = 0.0
                    rev_c = 0
                    for pe, cur_v in recent_rev:
                        d_v = cur_v - first_rev[pe]
                        rev_sum += d_v
                        if abs(d_v) > tol:
                            rev_c += 1
                    snap_rev_assets[s_id] = np.float32(
                        np.clip(rev_sum / latest_ta, -2.0, 2.0)
                    )
                    snap_rev_cnt[s_id] = np.float32(rev_c)

        snap_ids = af["fund_snap_id"].to_numpy(dtype=np.int64, copy=False)
        valid_snap = (snap_ids >= 0) & (snap_ids < n_snaps)
        if valid_snap.any():
            vs = snap_ids[valid_snap]
            data["restate_ni_assets"][valid_snap] = snap_ni_assets[vs]
            data["restate_rev_assets"][valid_snap] = snap_rev_assets[vs]
            data["restate_ni_count_4q"][valid_snap] = snap_ni_cnt[vs]
            data["restate_rev_count_4q"][valid_snap] = snap_rev_cnt[vs]
            data["restate_any_downward_4q"][valid_snap] = snap_down[vs]
        if fin_mask.any():
            data["restate_rev_assets"][fin_mask] = np.nan
            data["restate_rev_count_4q"][fin_mask] = np.nan

    # Part 2: Strictly causal SEC 8-K Item 4.02 (non_reliance) & 10-K/Q-A flags from EventStore
    ev_store = ctx.stores.events
    if "event_observations" in ctx.families or len(ev_store.available_at_ns) > 0:
        non_rel_code = -1
        amend_codes: set[int] = set()
        for k_idx, k_name in enumerate(ev_store.kinds):
            if k_name == "non_reliance":
                non_rel_code = k_idx
            elif k_name in _AMENDMENT_EVENT_KINDS:
                amend_codes.add(k_idx)

        ai = af["asset_idx"].to_numpy(dtype=np.int64, copy=False)
        dec_ns = clocks.instants(af["decision_at"].to_numpy(dtype=object))
        non_rel_out = np.zeros(n, dtype=np.float32)
        amend_out = np.zeros(n, dtype=np.float32)
        invalid_dec = dec_ns == clocks.NAT
        non_rel_out[invalid_dec] = np.nan
        amend_out[invalid_dec] = np.nan

        if len(ev_store.available_at_ns) > 0 and (non_rel_code >= 0 or amend_codes):
            order = np.argsort(ai, kind="mergesort")
            ai_s = ai[order]
            diffs = np.flatnonzero(np.diff(ai_s)) + 1
            starts = np.concatenate(([0], diffs))
            ends = np.concatenate((diffs, [n]))
            amend_arr = np.array(sorted(amend_codes), dtype=np.int32)
            for b_idx in range(len(starts)):
                s_p = int(starts[b_idx])
                e_p = int(ends[b_idx])
                a_i = int(ai_s[s_p])
                if a_i < 0 or (a_i + 1) >= len(ev_store.asset_offsets):
                    continue
                e0 = int(ev_store.asset_offsets[a_i])
                e1 = int(ev_store.asset_offsets[a_i + 1])
                if e1 <= e0:
                    continue
                srcs = ev_store.source_id[e0:e1]
                av = ev_store.available_at_ns[e0:e1]
                kc = ev_store.kind_code[e0:e1]
                sec_ok = (srcs == 0) & (av != clocks.NAT)
                if not sec_ok.any():
                    continue
                rows = order[s_p:e_p]
                d_rows = dec_ns[rows]
                ok_d = d_rows != clocks.NAT
                if not ok_d.any():
                    continue
                rows_ok = rows[ok_d]
                d_ok = d_rows[ok_d]

                if non_rel_code >= 0:
                    nr_mask = sec_ok & (kc == non_rel_code)
                    if nr_mask.any():
                        nr_av = np.sort(av[nr_mask])
                        hi_p = np.searchsorted(nr_av, d_ok, side="right")
                        lo_p = np.searchsorted(nr_av, d_ok - lookback_ns, side="right")
                        non_rel_out[rows_ok] = ((hi_p - lo_p) > 0).astype(np.float32)

                if len(amend_arr):
                    am_mask = sec_ok & np.isin(kc, amend_arr)
                    if am_mask.any():
                        am_av = np.sort(av[am_mask])
                        hi_p = np.searchsorted(am_av, d_ok, side="right")
                        lo_p = np.searchsorted(am_av, d_ok - lookback_ns, side="right")
                        amend_out[rows_ok] = (hi_p - lo_p).astype(np.float32)

        data["restate_sec_non_reliance_365d"] = non_rel_out
        data["restate_sec_amendment_365d"] = amend_out

    return pd.DataFrame(data, index=af.index)


_VALUATION_COLS = tuple(f"val_{name}" for name in _valuation.VALUATION_NAMES)


def _reindex_event_grid(
    ev_df: Mapping[str, Any] | pd.DataFrame,
    assets: Sequence[str],
    signals: Sequence[Any],
    af: pd.DataFrame,
    cols: Sequence[str],
) -> dict[str, np.ndarray]:
    """Map dense ``(assets x signals)`` event_features rows onto anchors via integer indexing."""
    n = len(af)
    out = {c: np.full(n, np.nan, dtype=np.float32) for c in cols}
    if not ev_df or not assets or not signals:
        return out
    if isinstance(ev_df, pd.DataFrame):
        if ev_df.empty:
            return out
        max_row = len(ev_df)
    else:
        first_arr = next(iter(ev_df.values()), None)
        max_row = len(first_arr) if first_arr is not None else 0
        if max_row == 0:
            return out
    n_sig = len(signals)
    pos_map = {aid: i for i, aid in enumerate(assets)}
    sig_map = {s: j for j, s in enumerate(signals)}
    a_idx = np.fromiter(
        (pos_map.get(a, -1) for a in af["asset_id"].astype(str).tolist()),
        dtype=np.int64,
        count=n,
    )
    s_idx = np.fromiter(
        (sig_map.get(s, -1) for s in af["signal_session"].tolist()),
        dtype=np.int64,
        count=n,
    )
    valid = (a_idx >= 0) & (s_idx >= 0)
    if not valid.any():
        return out
    flat_idx = a_idx[valid] * n_sig + s_idx[valid]
    valid_pos = np.flatnonzero(valid)
    in_bounds = flat_idx < max_row
    flat_idx = flat_idx[in_bounds]
    valid_pos = valid_pos[in_bounds]
    for c in cols:
        if c not in ev_df:
            continue
        arr = np.asarray(ev_df[c])
        if np.issubdtype(arr.dtype, np.number) or np.issubdtype(arr.dtype, np.bool_):
            src = arr.astype(np.float32, copy=False)
        else:
            src = pd.to_numeric(pd.Series(arr), errors="coerce").to_numpy(
                dtype=np.float32, copy=False
            )
        out[c][valid_pos] = src[flat_idx]
    return out


def _latest_visible_event_pos(
    ev_store: Any,
    ai: np.ndarray,
    dec_ns: np.ndarray,
    *,
    source_ids: tuple[int, ...] | None = None,
) -> np.ndarray:
    """Vectorized per-asset lookup returning last EventStore row with ``avail <= dec_ns`` (else -1)."""
    n = len(ai)
    last_pos = np.full(n, -1, dtype=np.int64)
    if n == 0 or not len(ev_store.available_at_ns):
        return last_pos
    order = np.argsort(ai, kind="mergesort")
    ai_s = ai[order]
    diffs = np.flatnonzero(np.diff(ai_s)) + 1
    starts = np.concatenate(([0], diffs))
    ends = np.concatenate((diffs, [n]))
    for b_idx in range(len(starts)):
        s = int(starts[b_idx])
        e = int(ends[b_idx])
        a_i = int(ai_s[s])
        if a_i < 0 or (a_i + 1) >= len(ev_store.asset_offsets):
            continue
        e0 = int(ev_store.asset_offsets[a_i])
        e1 = int(ev_store.asset_offsets[a_i + 1])
        if e1 <= e0:
            continue
        avail = ev_store.available_at_ns[e0:e1]
        valid = avail != clocks.NAT
        if source_ids is not None:
            valid = valid & np.isin(ev_store.source_id[e0:e1], source_ids)
        if not valid.any():
            continue
        av_v = avail[valid]
        idx_v = np.flatnonzero(valid) + e0
        if len(av_v) > 1 and np.any(av_v[:-1] > av_v[1:]):
            perm = np.argsort(av_v, kind="mergesort")
            av_v = av_v[perm]
            idx_v = idx_v[perm]
        cum_max_idx = np.maximum.accumulate(idx_v)
        rows = order[s:e]
        d_rows = dec_ns[rows]
        ok_d = d_rows != clocks.NAT
        if not ok_d.any():
            continue
        d_sub = d_rows[ok_d]
        pos = np.searchsorted(av_v, d_sub, side="right") - 1
        hit = pos >= 0
        if hit.any():
            out_vals = np.full(len(d_sub), -1, dtype=np.int64)
            out_vals[hit] = cum_max_idx[pos[hit]]
            last_pos[rows[ok_d]] = out_vals
    return last_pos


@register_feature_group(
    "valuation_dynamic",
    columns=_VALUATION_COLS,
    description="Dynamic PIT market cap, valuation yields, EV multiples & net issuance.",
)
def build_valuation_dynamic(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    del params
    af = ctx.stores.anchors.frame
    n = len(af)
    fin_mask = _sic_financial_mask(ctx)
    data = {
        f"val_{name}": np.full(n, np.nan, dtype=np.float32)
        for name in _valuation.VALUATION_NAMES
    }
    if "fundamentals" in ctx.families:
        derived = ctx.derived_fundamentals()
        samples = ctx.samples
        for _chunk_assets, pos in ctx.asset_batches():
            val_df = _valuation.valuation(
                ctx.version,
                samples.iloc[pos],
                derived.iloc[pos],
                time_policy=ctx.time_policy,
                provenance=False,
            )
            fin_sub = fin_mask[pos] if fin_mask.any() else None
            for name in _valuation.VALUATION_NAMES:
                val_col = f"{name}_value"
                st_col = f"{name}_status"
                vals = (
                    pd.to_numeric(val_df[val_col], errors="coerce").to_numpy(
                        dtype=np.float32, copy=True
                    )
                    if val_col in val_df.columns
                    else np.full(len(pos), np.nan, dtype=np.float32)
                )
                if st_col in val_df.columns:
                    usable = (
                        val_df[st_col]
                        .astype(object)
                        .isin(_USABLE_VAL_STATUSES)
                        .to_numpy(dtype=bool)
                    )
                    vals[~usable] = np.nan
                if name in _REV_MASK_VIEWS and fin_sub is not None and fin_sub.any():
                    vals[fin_sub] = np.nan
                data[f"val_{name}"][pos] = vals
            del val_df
            if hasattr(ctx.version, "clear_cache"):
                ctx.version.clear_cache()
            gc.collect()
            pa.default_memory_pool().release_unused()
    if "val_market_cap_issuer" in data:
        ctx.set_mcap_cache(data["val_market_cap_issuer"])
    return pd.DataFrame(data, index=af.index)


_EARNINGS_COLS = (
    "earn_days_since",
    "earn_sessions_since",
    "earn_candidates_in_period",
    "earn_volume_ratio",
    "earn_ear",
    "earn_ear_pending",
    "earn_ear_prev",
    "earn_days_until_next_est",
    "earn_next_overdue",
    "earn_sue_eps",
    "earn_sue_eps_price",
    "earn_sue_revenue",
    "earn_sue_age_days",
    "ev_last_post_1d_ret",
    "ev_last_post_3d_ret",
)


@register_feature_group(
    "earnings_pead_sue",
    columns=_EARNINGS_COLS,
    description="PIT earnings timing, EAR, volume confirmation, SUE & causal post-event reaction.",
)
def build_earnings_pead_sue(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    del params
    af = ctx.stores.anchors.frame
    n = len(af)
    data = {col: np.full(n, np.nan, dtype=np.float32) for col in _EARNINGS_COLS}
    fin_mask = _sic_financial_mask(ctx)
    samples = ctx.samples
    batches = ctx.asset_batches()

    has_earn = "earnings_announcements" in ctx.families
    has_fund = "fundamentals" in ctx.families
    ciks_series = ctx.ciks if has_fund else None
    has_dr = "daily_returns" in ctx.families
    has_earn_obs = "earnings_observations" in ctx.families
    has_ev_obs = "event_observations" in ctx.families
    ev_obs_reader = getattr(ctx.version, "_earnings_event_observations", None)

    for chunk_assets, pos in batches:
        sub_samples = samples.iloc[pos]
        primary_periods = None
        if has_earn:
            ann_df = ctx.version.family("earnings_announcements", chunk_assets)
            price_ids = list(
                dict.fromkeys(
                    [*chunk_assets, *([ctx.benchmark_id] if ctx.benchmark_id else [])]
                )
            )
            dr_df = (
                ctx.version.family(
                    "daily_returns",
                    price_ids,
                    columns=["asset_id", "date", "row_kind", "tr_index"],
                )
                if has_dr
                else None
            )
            adj_df = ctx.price_frame_close(price_ids, adjusted=True)
            adj_df["date"] = pd.to_datetime(adj_df["date"]).dt.date
            earn_obs_cal = (
                ctx.version.family("earnings_observations", chunk_assets)
                if has_earn_obs
                else None
            )
            ev_obs_cal = None
            if has_ev_obs and earn_obs_cal is not None and "event_uid" in earn_obs_cal:
                uids = sorted(set(earn_obs_cal["event_uid"].astype(str)) - {""})
                if uids:
                    ev_obs_cal = (
                        ev_obs_reader(uids)
                        if callable(ev_obs_reader)
                        else ctx.version.event_observations()
                    )
            earn_df = _sec_events.earnings_features(
                ann_df,
                sub_samples,
                calendar=ctx.calendar,
                adjusted=adj_df,
                benchmark_id=ctx.benchmark_id,
                daily_returns=dr_df,
                time_policy=ctx.time_policy,
                event_observations=ev_obs_cal,
                earnings_observations=earn_obs_cal,
                horizons=ctx.horizons,
            )
            primary_periods = earn_df.attrs.get("primary_period_end")
            for col in (
                "earn_days_since",
                "earn_sessions_since",
                "earn_candidates_in_period",
                "earn_volume_ratio",
                "earn_ear",
                "earn_ear_prev",
                "earn_days_until_next_est",
            ):
                if col in earn_df.columns:
                    data[col][pos] = pd.to_numeric(
                        earn_df[col], errors="coerce"
                    ).to_numpy(dtype=np.float32)
            for bcol in ("earn_ear_pending", "earn_next_overdue"):
                if bcol in earn_df.columns:
                    s = earn_df[bcol]
                    arr = np.full(len(pos), np.nan, dtype=np.float32)
                    known = s.notna().to_numpy(dtype=bool)
                    arr[known] = s[known].astype(bool).to_numpy(dtype=np.float32)
                    data[bcol][pos] = arr
            del ann_df, dr_df, adj_df, earn_obs_cal, ev_obs_cal, earn_df

        if has_fund and ciks_series is not None:
            sub_ciks = ciks_series.iloc[pos]
            unique_ciks = [
                c for c in dict.fromkeys(sub_ciks.dropna().astype(str).tolist()) if c
            ]
            q_ledger = (
                _fund.fiscal_quarters(
                    ctx.version,
                    time_policy=ctx.time_policy,
                    concepts=("eps_diluted", "eps_basic", "revenue"),
                    ciks=unique_ciks,
                )
                if unique_ciks
                else pd.DataFrame()
            )
            raw_df = ctx.price_frame_close(chunk_assets, adjusted=False)
            raw_df["date"] = pd.to_datetime(raw_df["date"]).dt.date
            sue_df = _sec_events.sue_features(
                q_ledger,
                sub_samples,
                raw=raw_df,
                asset_ciks=sub_ciks,
                primary_period_end=primary_periods,
            )
            fin_sub = fin_mask[pos] if fin_mask.any() else None
            stale_s = (
                sue_df["earn_sue_stale"].fillna(False).to_numpy(dtype=bool)
                if "earn_sue_stale" in sue_df.columns
                else np.zeros(len(sue_df), dtype=bool)
            )
            age_s = (
                pd.to_numeric(sue_df["earn_sue_age_days"], errors="coerce").to_numpy(
                    dtype=np.float64
                )
                if "earn_sue_age_days" in sue_df.columns
                else np.full(len(sue_df), np.nan, dtype=np.float64)
            )
            stale_mask = stale_s | (np.isfinite(age_s) & (age_s > 200.0))
            for col in (
                "earn_sue_eps",
                "earn_sue_eps_price",
                "earn_sue_revenue",
                "earn_sue_age_days",
            ):
                if col in sue_df.columns:
                    arr = pd.to_numeric(sue_df[col], errors="coerce").to_numpy(
                        dtype=np.float32, copy=True
                    )
                    if col in _REV_MASK_VIEWS and fin_sub is not None and fin_sub.any():
                        arr[fin_sub] = np.nan
                    if col != "earn_sue_age_days" and stale_mask.any():
                        arr[stale_mask] = np.nan
                    data[col][pos] = arr
            del q_ledger, raw_df, sue_df
        if hasattr(ctx.version, "clear_cache"):
            ctx.version.clear_cache()
        gc.collect()
        pa.default_memory_pool().release_unused()

    # Causal latest SEC filing post-1d/3d reaction strictly masked by reaction_ready_mask
    ev_store = ctx.stores.events
    ai = af["asset_idx"].to_numpy(dtype=np.int64, copy=False)
    dec_ns = clocks.instants(af["decision_at"].to_numpy(dtype=object))
    last_pos = _latest_visible_event_pos(ev_store, ai, dec_ns, source_ids=(0,))
    post1 = np.full(n, np.nan, dtype=np.float32)
    post3 = np.full(n, np.nan, dtype=np.float32)
    found = last_pos >= 0
    if found.any():
        lp = last_pos[found]
        dn = dec_ns[found]
        r1_ok = ev_store.post_1d_ready_ns[lp] <= dn
        r3_ok = ev_store.post_3d_ready_ns[lp] <= dn
        post1[found] = np.where(r1_ok, ev_store.post_1d_ret[lp], np.nan).astype(
            np.float32
        )
        post3[found] = np.where(r3_ok, ev_store.post_3d_ret[lp], np.nan).astype(
            np.float32
        )
    data["ev_last_post_1d_ret"] = post1
    data["ev_last_post_3d_ret"] = post3
    return pd.DataFrame(data, index=af.index)


_SEC_TYPED_CORE_COLS = (
    "sec_events_1d",
    "sec_events_5d",
    "sec_events_21d",
    "sec_events_63d",
    "sec_events_rank_21d",
)


@register_feature_group(
    "sec_typed_events",
    columns=_SEC_TYPED_CORE_COLS,
    description="SEC filing counts, 21d cross-sectional ranks (countable windows only).",
)
def build_sec_typed_events(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    del params
    af = ctx.stores.anchors.frame
    n = len(af)
    if "event_observations" not in ctx.families or "source_checks" not in ctx.families:
        return pd.DataFrame(
            {col: np.full(n, np.nan, dtype=np.float32) for col in _SEC_TYPED_CORE_COLS},
            index=af.index,
        )

    sec_spec = _events.EventSpec(
        "sec",
        "sec",
        {"form": frozenset({"8-K", "10-K", "10-Q", "6-K", "20-F"})},
    )
    universe_records = _candidates.records(ctx.version.universe)
    assets = [str(r["asset_id"]) for r in universe_records if r.get("asset_id")]
    if not assets:
        return pd.DataFrame(
            {col: np.full(n, np.nan, dtype=np.float32) for col in _SEC_TYPED_CORE_COLS},
            index=af.index,
        )
    non_bench = [
        i
        for i, r in enumerate(universe_records)
        if r.get("asset_id")
        and not _candidates.flagged(r)
        and str(r["asset_id"]) != str(ctx.benchmark_id)
    ]
    from ..stores import _read_filtered_event_observations

    obs = _read_filtered_event_observations(
        ctx.version,
        list(
            dict.fromkeys(
                [
                    "source",
                    "event_uid",
                    "event_id",
                    "observation_sequence",
                    "form",
                    "items",
                    "filing_date",
                    "event_date",
                    "asset_ids",
                    "asset_first_seen_at",
                    "content_first_seen_at",
                    "observation_recorded_at",
                    "public_time_precision",
                    "public_at",
                    "public_date",
                    "public_time_basis",
                    "story_key",
                ]
            )
        ),
        include_sources=("sec",),
    )
    checks = ctx.version.source_checks(assets)
    cal = ctx.calendar
    signals = sorted(af["signal_session"].unique())
    first, last = cal.index(signals[0]), cal.index(signals[-1])
    start = max(0, first - _events.WARMUP_SESSIONS)
    out_positions = cal.positions(signals)
    ev_df, _ = _events.event_features(
        obs,
        checks,
        assets=assets,
        selected=len(assets),
        decisions=cal.decisions[start : last + 2],
        first_signal=first - start,
        policy=ctx.time_policy,
        zones=ctx.version.manifest.get("source_timezones", {}),
        news_versions=None,
        population=non_bench,
        specs=(sec_spec,),
        output_windows=out_positions - start,
        signal_days=cal.days[first : last + 1],
    )
    data = _reindex_event_grid(ev_df, assets, signals, af, _SEC_TYPED_CORE_COLS)
    del obs, checks, ev_df
    return pd.DataFrame(data, index=af.index)


def _news_columns(params: Mapping[str, Any]) -> tuple[str, ...]:
    hls = [float(h) for h in params.get("half_lives_days", (1.0, 5.0, 20.0))]
    hl_cols = tuple(
        f"news_decay_hl_{int(h) if float(h).is_integer() else str(h).replace('.', '_')}d"
        for h in hls
    )
    return (
        "alpaca_news_events_1d",
        "alpaca_news_events_5d",
        "alpaca_news_events_21d",
        "alpaca_news_events_63d",
        "alpaca_news_events_rank_21d",
        "finnhub_news_events_1d",
        "finnhub_news_events_5d",
        "finnhub_news_events_21d",
        "finnhub_news_events_63d",
        "finnhub_news_events_rank_21d",
        *hl_cols,
        "news_21d_rank",
    )


@register_feature_group(
    "news_intensity",
    dynamic_columns_fn=_news_columns,
    default_params={"half_lives_days": [1.0, 5.0, 20.0]},
    description="Coverage-respecting news counts, 21d ranks, and causal exponential decay intensity.",
)
def build_news_intensity(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    af = ctx.stores.anchors.frame
    n = len(af)
    cols_all = _news_columns(params)
    raw_event_cols = [
        c
        for c in cols_all
        if c.startswith(("alpaca_news_events_", "finnhub_news_events_"))
    ]
    data = {c: np.full(n, np.nan, dtype=np.float32) for c in cols_all}

    hls = [float(h) for h in params.get("half_lives_days", (1.0, 5.0, 20.0))]
    if "event_observations" in ctx.families and "source_checks" in ctx.families:
        news_specs = (
            _events.EventSpec("alpaca_news", "alpaca_news"),
            _events.EventSpec("finnhub_news", "finnhub_news"),
        )
        universe_records = _candidates.records(ctx.version.universe)
        assets = [str(r["asset_id"]) for r in universe_records if r.get("asset_id")]
        if assets:
            non_bench = [
                i
                for i, r in enumerate(universe_records)
                if r.get("asset_id")
                and not _candidates.flagged(r)
                and str(r["asset_id"]) != str(ctx.benchmark_id)
            ]
            obs = ctx.version.event_observations(
                columns=list(
                    dict.fromkeys(
                        [
                            "source",
                            "event_uid",
                            "event_id",
                            "observation_sequence",
                            "event_date",
                            "asset_ids",
                            "asset_first_seen_at",
                            "content_first_seen_at",
                            "observation_recorded_at",
                            "public_time_precision",
                            "public_at",
                            "public_date",
                            "story_key",
                        ]
                    )
                )
            )
            checks = ctx.version.source_checks(assets)
            news_ver = (
                ctx.version.family(
                    "news_versions",
                    columns=["event_id", "story_key", "provider_updated_at"],
                )
                if "news_versions" in ctx.families
                else None
            )
            cal = ctx.calendar
            signals = sorted(af["signal_session"].unique())
            first, last = cal.index(signals[0]), cal.index(signals[-1])
            start = max(0, first - _events.WARMUP_SESSIONS)
            ev_df, _ = _events.event_features(
                obs,
                checks,
                assets=assets,
                selected=len(assets),
                decisions=cal.decisions[start : last + 2],
                first_signal=first - start,
                policy=ctx.time_policy,
                zones=ctx.version.manifest.get("source_timezones", {}),
                news_versions=news_ver,
                population=non_bench,
                specs=news_specs,
                output_windows=cal.positions(signals) - start,
                signal_days=cal.days[first : last + 1],
            )
            data.update(_reindex_event_grid(ev_df, assets, signals, af, raw_event_cols))

            # Mask each news source before its earliest observed event in obs
            if obs is not None and not obs.empty and "source" in obs.columns:
                sig_days_arr = pd.to_datetime(af["signal_session"]).dt.date.to_numpy()
                src_col = obs["source"].astype(str)
                for src_name, prefix in (
                    ("alpaca_news", "alpaca_news_events_"),
                    ("finnhub_news", "finnhub_news_events_"),
                ):
                    sub_obs = obs[src_col == src_name]
                    if sub_obs.empty:
                        continue
                    dates_list: list[Any] = []
                    for d_col in ("event_date", "public_date", "public_at"):
                        if d_col in sub_obs.columns:
                            parsed = pd.to_datetime(
                                sub_obs[d_col], errors="coerce"
                            ).dropna()
                            if not parsed.empty:
                                dates_list.append(parsed.min().date())
                    if dates_list:
                        first_ev_day = min(dates_list)
                        before_src = sig_days_arr < first_ev_day
                        if before_src.any():
                            for col in raw_event_cols:
                                if col.startswith(prefix):
                                    data[col][before_src] = np.nan

    # Combined causal news_21d_rank
    a21 = data["alpaca_news_events_rank_21d"]
    f21 = data["finnhub_news_events_rank_21d"]
    both = np.where(
        np.isfinite(a21) & np.isfinite(f21),
        0.5 * (a21 + f21),
        np.where(np.isfinite(a21), a21, f21),
    )
    data["news_21d_rank"] = both.astype(np.float32)

    # Exponentially decayed news intensity from EventStore computed per source & normalized per session
    ev_store = ctx.stores.events
    ai = af["asset_idx"].to_numpy(dtype=np.int64, copy=False)
    s_idx_arr = af["session_idx"].to_numpy(dtype=np.int64, copy=False)
    dec_ns = clocks.instants(af["decision_at"].to_numpy(dtype=object))
    ns_per_day = 86_400_000_000_000.0
    cutoff_ns = 180 * 86_400_000_000_000

    def _per_asset_news_for_source(
        src_id: int, countable_mask: np.ndarray
    ) -> list[tuple[np.ndarray, np.ndarray, np.ndarray]]:
        c_rows = np.flatnonzero(countable_mask)
        if not len(c_rows):
            return []
        per_asset: list[tuple[np.ndarray, np.ndarray, np.ndarray]] = []
        c_ai = ai[c_rows]
        order = np.argsort(c_ai, kind="mergesort")
        c_rows_s = c_rows[order]
        c_ai_s = c_ai[order]
        diffs = np.flatnonzero(np.diff(c_ai_s)) + 1
        starts = np.concatenate(([0], diffs))
        ends = np.concatenate((diffs, [len(c_ai_s)]))
        for b_idx in range(len(starts)):
            s = int(starts[b_idx])
            e = int(ends[b_idx])
            a_i = int(c_ai_s[s])
            if a_i < 0 or (a_i + 1) >= len(ev_store.asset_offsets):
                continue
            rows_a = c_rows_s[s:e]
            d_a = dec_ns[rows_a]
            valid_d = d_a != clocks.NAT
            if not valid_d.any():
                continue
            rows_a = rows_a[valid_d]
            d_a = d_a[valid_d]
            d_ord = np.argsort(d_a, kind="mergesort")
            rows_a = rows_a[d_ord]
            d_a = d_a[d_ord]

            e0 = int(ev_store.asset_offsets[a_i])
            e1 = int(ev_store.asset_offsets[a_i + 1])
            if e1 <= e0:
                per_asset.append((rows_a, d_a, np.empty(0, dtype=np.int64)))
                continue
            srcs_a = ev_store.source_id[e0:e1]
            avs_a = ev_store.available_at_ns[e0:e1]
            mask = (srcs_a == src_id) & (avs_a != clocks.NAT)
            news_av = (
                np.sort(avs_a[mask]) if mask.any() else np.empty(0, dtype=np.int64)
            )
            per_asset.append((rows_a, d_a, news_av))
        return per_asset

    def _decay_values(
        lam: float, per_asset: list[tuple[np.ndarray, np.ndarray, np.ndarray]]
    ) -> np.ndarray:
        arr = np.full(n, np.nan, dtype=np.float64)
        for rows_a, d_a, news_av in per_asset:
            if not len(news_av):
                arr[rows_a] = 0.0
                continue
            ls = np.searchsorted(news_av, d_a - cutoff_ns, side="left")
            rs = np.searchsorted(news_av, d_a, side="right")
            vals = np.zeros(len(rows_a), dtype=np.float64)
            acc = 0.0
            prev_l = 0
            prev_r = 0
            prev_d = int(d_a[0])
            for j in range(len(rows_a)):
                d_ns = int(d_a[j])
                lj = int(ls[j])
                rj = int(rs[j])
                if lj >= rj:
                    acc = 0.0
                elif (j & 31) == 0 or lj < prev_l or rj < prev_r:
                    acc = float(
                        np.exp(-lam * ((d_ns - news_av[lj:rj]) / ns_per_day)).sum()
                    )
                else:
                    dt_d = (d_ns - prev_d) / ns_per_day
                    if dt_d > 0.0 and acc > 0.0:
                        acc *= math.exp(-lam * dt_d)
                    if rj > prev_r:
                        for av in news_av[prev_r:rj]:
                            acc += math.exp(-lam * ((d_ns - int(av)) / ns_per_day))
                    if lj > prev_l and acc > 0.0:
                        for av in news_av[prev_l:lj]:
                            acc -= math.exp(-lam * ((d_ns - int(av)) / ns_per_day))
                    acc = max(acc, 0.0)
                vals[j] = acc
                prev_l = lj
                prev_r = rj
                prev_d = d_ns
            arr[rows_a] = vals
        return arr

    def _normalize_by_session(raw_arr: np.ndarray) -> np.ndarray:
        out = raw_arr.copy()
        finite_idx = np.flatnonzero(np.isfinite(raw_arr))
        if not len(finite_idx):
            return out
        sess_sub = s_idx_arr[finite_idx]
        s_ord = np.argsort(sess_sub, kind="mergesort")
        fi_s = finite_idx[s_ord]
        ss_s = sess_sub[s_ord]
        s_diffs = np.flatnonzero(np.diff(ss_s)) + 1
        s_starts = np.concatenate(([0], s_diffs))
        s_ends = np.concatenate((s_diffs, [len(ss_s)]))
        for k in range(len(s_starts)):
            idx_k = fi_s[s_starts[k] : s_ends[k]]
            vals_k = raw_arr[idx_k]
            pos_k = vals_k[vals_k > 0.0]
            if not len(pos_k):
                continue
            scale = float(np.median(pos_k))
            if scale <= 0.0:
                scale = float(np.mean(pos_k))
            if scale > 0.0:
                out[idx_k] = vals_k / scale
        return out

    alp_per_asset = _per_asset_news_for_source(
        1, np.isfinite(data["alpaca_news_events_1d"])
    )
    fin_per_asset = _per_asset_news_for_source(
        2, np.isfinite(data["finnhub_news_events_1d"])
    )

    for hl in hls:
        colname = f"news_decay_hl_{int(hl) if float(hl).is_integer() else str(hl).replace('.', '_')}d"
        lam = math.log(2.0) / max(hl, 1e-6)
        alp_norm = _normalize_by_session(_decay_values(lam, alp_per_asset))
        fin_norm = _normalize_by_session(_decay_values(lam, fin_per_asset))
        combined = np.where(
            np.isfinite(alp_norm) & np.isfinite(fin_norm),
            0.5 * (alp_norm + fin_norm),
            np.where(np.isfinite(alp_norm), alp_norm, fin_norm),
        )
        data[colname] = combined.astype(np.float32)
    return pd.DataFrame(data, index=af.index)


_CRYPTO_MACRO_COLS = (
    "crypto_ret_1d_btc",
    "crypto_ret_1d_eth",
    "crypto_ret_21d_btc",
    "crypto_rvol_21d_btc",
    "crypto_weekend_gap_btc",
    "crypto_weekend_gap_eth",
)

_MACRO_ALL_COLS = (
    *_extra_features.REFERENCE_COLUMNS[:-1],
    *_extra_features.MARKET_ETF_COLUMNS,
    *_CRYPTO_MACRO_COLS,
)


def _macro_columns(ctx: GroupBuildContext | None = None) -> tuple[str, ...]:
    return _MACRO_ALL_COLS


@register_feature_group(
    "macro_regime",
    columns=_MACRO_ALL_COLS,
    description="Market ETF + FRED yield/credit/VIX/FX macro regime aligned via MacroStore.",
)
def build_macro_regime(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    del params
    af = ctx.stores.anchors.frame
    mstore = ctx.stores.macro
    si = af["session_idx"].to_numpy(dtype=np.int64, copy=False)
    n = len(af)
    col_pos = {c: idx for idx, c in enumerate(mstore.columns)}
    data: dict[str, np.ndarray] = {}
    valid = (si >= 0) & (si < mstore.data.shape[0])
    for col in _MACRO_ALL_COLS:
        arr = np.full(n, np.nan, dtype=np.float32)
        if col in col_pos and mstore.data.shape[1] > 0:
            c_idx = col_pos[col]
            arr[valid] = mstore.data[si[valid], c_idx].astype(np.float32, copy=False)
        data[col] = arr
    return pd.DataFrame(data, index=af.index)


_INSIDER_NUM_COLS = tuple(
    c for c in _extra_features.INSIDER_COLUMNS if c != "ins_coverage"
)
_SI_NUM_COLS = tuple(
    c for c in _extra_features.SHORT_INTEREST_COLUMNS if c != "si_coverage"
)
_TEXT_NUM_COLS = tuple(
    c
    for c in _extra_features.TEXT_CHANGE_COLUMNS
    if c not in {"txt_form", "txt_status"}
)
_RELEASE_NUM_COLS = tuple(
    c for c in _release.RELEASE_COLUMNS if c != "release_extraction_status"
)


def _run_extra_numeric(
    ctx: GroupBuildContext,
    group_name: str,
    numeric_cols: Sequence[str],
    *,
    need_fund: bool = False,
) -> pd.DataFrame:
    af = ctx.stores.anchors.frame
    n = len(af)
    data = {col: np.full(n, np.nan, dtype=np.float32) for col in numeric_cols}
    fund_df = ctx.shares_and_mcap() if need_fund else None
    samples = ctx.samples
    for _chunk_assets, pos in ctx.asset_batches():
        sub_fund = fund_df.iloc[pos] if fund_df is not None else None
        part = _extra_features.extra_features(
            ctx.version,
            samples.iloc[pos],
            time_policy=ctx.time_policy,
            groups=[group_name],
            fundamentals=sub_fund,
            ranks=False,
        )
        for col in numeric_cols:
            if col in part.columns:
                data[col][pos] = pd.to_numeric(part[col], errors="coerce").to_numpy(
                    dtype=np.float32
                )
        del part
        if hasattr(ctx.version, "clear_cache"):
            ctx.version.clear_cache()
        gc.collect()
        pa.default_memory_pool().release_unused()
    return pd.DataFrame(data, index=af.index)


@register_feature_group(
    "insider_flow",
    columns=_INSIDER_NUM_COLS,
    description="PIT Form 4 insider buying/selling counts, dollar values, and mcap scaling.",
)
def build_insider_flow(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    del params
    return _run_extra_numeric(ctx, "insider", _INSIDER_NUM_COLS, need_fund=True)


@register_feature_group(
    "short_interest",
    columns=_SI_NUM_COLS,
    description="PIT FINRA short interest shares, days-to-cover, % shares & split flag.",
)
def build_short_interest(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    del params
    return _run_extra_numeric(ctx, "short_interest", _SI_NUM_COLS, need_fund=True)


@register_feature_group(
    "filing_text_change",
    columns=_TEXT_NUM_COLS,
    description="PIT 10-K/10-Q Risk Factors and MD&A similarity & length changes.",
)
def build_filing_text_change(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    del params
    return _run_extra_numeric(ctx, "text_change", _TEXT_NUM_COLS, need_fund=False)


@register_feature_group(
    "llm_release_guidance",
    columns=_RELEASE_NUM_COLS,
    default_params={"lookback_days": 90},
    description="PIT structured LLM earnings-release guidance, buybacks, and dividends.",
)
def build_llm_release_guidance(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    lookback = int(params.get("lookback_days", 90))
    af = ctx.stores.anchors.frame
    n = len(af)
    data = {col: np.full(n, np.nan, dtype=np.float32) for col in _RELEASE_NUM_COLS}
    if (
        "release_documents" not in ctx.families
        or "extraction_facts" not in ctx.families
    ):
        return pd.DataFrame(data, index=af.index)
    fund_df = ctx.shares_and_mcap()
    samples = ctx.samples
    ext_ver = ctx.release_extractor_version()
    for _chunk_assets, pos in ctx.asset_batches():
        sub_fund = fund_df.iloc[pos] if fund_df is not None else None
        rel = _release.release_features(
            ctx.version,
            samples.iloc[pos],
            time_policy=ctx.time_policy,
            extractor_version=ext_ver,
            fundamentals=sub_fund,
        )
        if "release_sessions_since" in rel.columns and lookback > 0:
            stale = pd.to_numeric(
                rel["release_sessions_since"], errors="coerce"
            ).to_numpy(dtype=np.float64) > float(lookback)
        else:
            stale = np.zeros(len(pos), dtype=bool)
        for col in _RELEASE_NUM_COLS:
            if col in rel.columns:
                arr = pd.to_numeric(rel[col], errors="coerce").to_numpy(
                    dtype=np.float32, copy=True
                )
                if (
                    col.startswith(("guidance_", "buyback_", "dividend_"))
                    and stale.any()
                ):
                    arr[stale] = np.nan
                data[col][pos] = arr
        del rel
        if hasattr(ctx.version, "clear_cache"):
            ctx.version.clear_cache()
        gc.collect()
        pa.default_memory_pool().release_unused()
    return pd.DataFrame(data, index=af.index)


@register_feature_group(
    "extraction_signals",
    columns=_RELEASE_NUM_COLS,
    default_params={"lookback_days": 90},
    description="Alias for llm_release_guidance.",
)
def build_extraction_signals_alias(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    return build_llm_release_guidance(ctx, params)


_LLM_FILING_SEMANTIC_COLS: tuple[str, ...] = (
    "ev8k_mna_sentiment",
    "ev8k_exec_departure_sev",
    "ev8k_buyback_pct_mcap",
    "ev8k_guidance_shock",
    "ev8k_distress_litigation",
    "diff_item1a_new_risk_sev",
    "diff_item1a_tone_shift",
    "diff_mdna_margin_driver",
    "diff_mdna_acct_policy_chg",
    "diff_substantive_chg_ratio",
)


@register_feature_group(
    "llm_filing_semantics",
    columns=_LLM_FILING_SEMANTIC_COLS,
    default_params={"ev8k_half_life_days": 21.0, "diff_max_age_days": 200},
    description="PIT structured 8-K LLM event shocks and 10-K/10-Q paragraph diff severity scores.",
)
def build_llm_filing_semantics(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    af = ctx.stores.anchors.frame
    n = len(af)
    data = {
        col: np.full(n, np.nan, dtype=np.float32) for col in _LLM_FILING_SEMANTIC_COLS
    }
    if n == 0:
        return pd.DataFrame(data, index=af.index)

    has_8k = "sec_8k_events" in ctx.families
    has_diff = "sec_filing_diffs" in ctx.families
    if not has_8k and not has_diff:
        return pd.DataFrame(data, index=af.index)

    ciks_arr = ctx.ciks.astype(object).fillna("").astype(str).to_numpy()
    dec_ns = clocks.instants(af["decision_at"].to_numpy(dtype=object))
    ns_per_day = 86_400_000_000_000.0
    hl_days = max(1.0, float(params.get("ev8k_half_life_days", 21.0)))
    lam = math.log(2.0) / hl_days
    max_diff_age_ns = int(params.get("diff_max_age_days", 200)) * 86_400_000_000_000

    # 1. Non-earnings 8-K structured LLM event facts (decayed over 90d window)
    if has_8k and hasattr(ctx.version, "family"):
        ev_df = ctx.version.family("sec_8k_events")
        if ev_df is not None and not ev_df.empty and "cik" in ev_df.columns:
            acc_c = "accepted_at" if "accepted_at" in ev_df.columns else "available_at"
            pub_ns = clocks.instants(ev_df[acc_c].to_numpy(dtype=object))
            if ctx.time_policy == "observed_content" and "recorded_at" in ev_df.columns:
                rec_ns = clocks.instants(ev_df["recorded_at"].to_numpy(dtype=object))
                av_ns = clocks.available_at(
                    pub_ns, pub_ns == clocks.NAT, "observed_content", [rec_ns]
                )
            else:
                av_ns = pub_ns
            ev8k_cols = (
                "ev8k_mna_sentiment",
                "ev8k_exec_departure_sev",
                "ev8k_buyback_pct_mcap",
                "ev8k_guidance_shock",
                "ev8k_distress_litigation",
            )
            by_cik_8k: dict[str, tuple[np.ndarray, np.ndarray]] = {}
            work_8k = ev_df.copy()
            work_8k["_av"] = av_ns
            work_8k["_cik"] = work_8k["cik"].astype(str).str.strip().str.zfill(10)
            work_8k = work_8k[
                (work_8k["_av"] != clocks.NAT) & work_8k["_cik"].str.isdigit()
            ].sort_values("_av", kind="mergesort")
            for cik_k, grp in work_8k.groupby("_cik", sort=False):
                mat_v = np.column_stack(
                    [
                        pd.to_numeric(
                            grp[c] if c in grp.columns else 0.0, errors="coerce"
                        )
                        .fillna(0.0)
                        .to_numpy(dtype=np.float64)
                        for c in ev8k_cols
                    ]
                )
                by_cik_8k[str(cik_k)] = (grp["_av"].to_numpy(dtype=np.int64), mat_v)

            cutoff_90d = 90 * 86_400_000_000_000
            for r_i in range(n):
                d_i = int(dec_ns[r_i])
                c_s = str(ciks_arr[r_i]).strip()
                c_pad = c_s.zfill(10) if c_s.isdigit() else ""
                if d_i == clocks.NAT or not c_pad:
                    continue
                entry_8k = by_cik_8k.get(c_pad)
                if entry_8k is None:
                    for col_n in ev8k_cols:
                        data[col_n][r_i] = 0.0
                    continue
                av_vec, val_mat = entry_8k
                lo_i = int(np.searchsorted(av_vec, d_i - cutoff_90d, side="left"))
                hi_i = int(np.searchsorted(av_vec, d_i, side="right"))
                if lo_i >= hi_i:
                    for col_n in ev8k_cols:
                        data[col_n][r_i] = 0.0
                else:
                    w_dec = np.exp(-lam * ((d_i - av_vec[lo_i:hi_i]) / ns_per_day))
                    agg = w_dec @ val_mat[lo_i:hi_i]
                    for j_c, col_n in enumerate(ev8k_cols):
                        data[col_n][r_i] = np.float32(agg[j_c])

    # 2. 10-K Item 1A & 10-Q MD&A paragraph-diff semantic scores (latest <= decision_at)
    if has_diff and hasattr(ctx.version, "family"):
        diff_df = ctx.version.family("sec_filing_diffs")
        if diff_df is not None and not diff_df.empty and "cik" in diff_df.columns:
            acc_c = (
                "accepted_at" if "accepted_at" in diff_df.columns else "available_at"
            )
            pub_ns = clocks.instants(diff_df[acc_c].to_numpy(dtype=object))
            if (
                ctx.time_policy == "observed_content"
                and "recorded_at" in diff_df.columns
            ):
                rec_ns = clocks.instants(diff_df["recorded_at"].to_numpy(dtype=object))
                av_ns = clocks.available_at(
                    pub_ns, pub_ns == clocks.NAT, "observed_content", [rec_ns]
                )
            else:
                av_ns = pub_ns
            diff_cols = (
                "diff_item1a_new_risk_sev",
                "diff_item1a_tone_shift",
                "diff_mdna_margin_driver",
                "diff_mdna_acct_policy_chg",
                "diff_substantive_chg_ratio",
            )
            by_cik_diff: dict[str, tuple[np.ndarray, np.ndarray]] = {}
            work_d = diff_df.copy()
            work_d["_av"] = av_ns
            work_d["_cik"] = work_d["cik"].astype(str).str.strip().str.zfill(10)
            work_d = work_d[
                (work_d["_av"] != clocks.NAT) & work_d["_cik"].str.isdigit()
            ].sort_values("_av", kind="mergesort")
            for cik_k, grp in work_d.groupby("_cik", sort=False):
                mat_d = np.column_stack(
                    [
                        pd.to_numeric(
                            grp[c]
                            if c in grp.columns
                            else pd.Series(np.nan, index=grp.index),
                            errors="coerce",
                        ).to_numpy(dtype=np.float64)
                        for c in diff_cols
                    ]
                )
                # Forward-fill across 10-K (Item 1A) and 10-Q (MD&A) within each CIK's causal filing stream
                mat_d = pd.DataFrame(mat_d).ffill().to_numpy(dtype=np.float64)
                by_cik_diff[str(cik_k)] = (grp["_av"].to_numpy(dtype=np.int64), mat_d)

            for r_i in range(n):
                d_i = int(dec_ns[r_i])
                c_s = str(ciks_arr[r_i]).strip()
                c_pad = c_s.zfill(10) if c_s.isdigit() else ""
                if d_i == clocks.NAT or c_pad not in by_cik_diff:
                    continue
                av_vec, val_mat = by_cik_diff[c_pad]
                pos_d = int(np.searchsorted(av_vec, d_i, side="right")) - 1
                if pos_d >= 0 and (d_i - int(av_vec[pos_d])) <= max_diff_age_ns:
                    row_v = val_mat[pos_d]
                    for j_c, col_n in enumerate(diff_cols):
                        if math.isfinite(row_v[j_c]):
                            data[col_n][r_i] = np.float32(row_v[j_c])

    return pd.DataFrame(data, index=af.index)
