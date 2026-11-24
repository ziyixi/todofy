"""Domain feature groups wrapping PIT fundamentals, events, news, macro, alt data & LLM facts."""

from __future__ import annotations

import importlib
import math
from collections.abc import Mapping, Sequence
from typing import Any

import numpy as np
import pandas as pd

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
    return (sic >= 6000.0) & (sic <= 6799.0)


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
    ev_store: Any, ai: np.ndarray, dec_ns: np.ndarray
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

    # Causal latest event post-1d/3d reaction strictly masked by reaction_ready_mask
    ev_store = ctx.stores.events
    ai = af["asset_idx"].to_numpy(dtype=np.int64, copy=False)
    dec_ns = clocks.instants(af["decision_at"].to_numpy(dtype=object))
    last_pos = _latest_visible_event_pos(ev_store, ai, dec_ns)
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
    obs = ctx.version.event_observations(
        columns=list(
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
        )
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

    # Combined causal news_21d_rank
    a21 = data["alpaca_news_events_rank_21d"]
    f21 = data["finnhub_news_events_rank_21d"]
    both = np.where(
        np.isfinite(a21) & np.isfinite(f21),
        0.5 * (a21 + f21),
        np.where(np.isfinite(a21), a21, f21),
    )
    data["news_21d_rank"] = both.astype(np.float32)

    # Exponentially decayed news intensity from EventStore (only populated where news events are countable!)
    ev_store = ctx.stores.events
    ai = af["asset_idx"].to_numpy(dtype=np.int64, copy=False)
    dec_ns = clocks.instants(af["decision_at"].to_numpy(dtype=object))
    countable_row = np.isfinite(data["alpaca_news_events_1d"]) | np.isfinite(
        data["finnhub_news_events_1d"]
    )
    c_rows = np.flatnonzero(countable_row)
    ns_per_day = 86_400_000_000_000.0
    cutoff_ns = 180 * 86_400_000_000_000

    per_asset_news: list[tuple[np.ndarray, np.ndarray, np.ndarray]] = []
    if len(c_rows):
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
                per_asset_news.append((rows_a, d_a, np.empty(0, dtype=np.int64)))
                continue
            srcs_a = ev_store.source_id[e0:e1]
            avs_a = ev_store.available_at_ns[e0:e1]
            mask = ((srcs_a == 1) | (srcs_a == 2)) & (avs_a != clocks.NAT)
            news_av = (
                np.sort(avs_a[mask]) if mask.any() else np.empty(0, dtype=np.int64)
            )
            per_asset_news.append((rows_a, d_a, news_av))

    for hl in hls:
        colname = f"news_decay_hl_{int(hl) if float(hl).is_integer() else str(hl).replace('.', '_')}d"
        arr = np.full(n, np.nan, dtype=np.float32)
        lam = math.log(2.0) / max(hl, 1e-6)
        for rows_a, d_a, news_av in per_asset_news:
            if not len(news_av):
                arr[rows_a] = np.float32(0.0)
                continue
            ls = np.searchsorted(news_av, d_a - cutoff_ns, side="left")
            rs = np.searchsorted(news_av, d_a, side="right")
            vals = np.zeros(len(rows_a), dtype=np.float32)
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
                vals[j] = np.float32(acc)
                prev_l = lj
                prev_r = rj
                prev_d = d_ns
            arr[rows_a] = vals
        data[colname] = arr
    return pd.DataFrame(data, index=af.index)


_MACRO_ALL_COLS = (
    *_extra_features.REFERENCE_COLUMNS[:-1],
    *_extra_features.MARKET_ETF_COLUMNS,
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
