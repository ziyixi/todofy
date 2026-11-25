"""Breadth signal feature groups: peer spillover, delayed-filing SEC shock & macro crisis."""

from __future__ import annotations

import importlib
import math
from collections.abc import Mapping
from typing import Any

import numpy as np
import pandas as pd

from .. import clocks
from ..feature_groups import GroupBuildContext, register_feature_group
from .price import _effective_level, _rolling_mean, _rolling_std, _select_at_anchors

_industry = importlib.import_module("research_datasets.industry")


def _clean_returns_and_dvol(
    ctx: GroupBuildContext,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Return ``(ret_clean, ovn_clean, lvl_clean, dvol_clean)`` with ``bar_invalid`` masked."""
    prices = ctx.stores.prices
    ret = prices.channel("ret_1d").astype(np.float64)
    ovn = prices.channel("overnight_ret").astype(np.float64)
    lvl = _effective_level(prices)
    inv_ch = prices.channel("bar_invalid").astype(np.float64)
    bad = np.isfinite(inv_ch) & (inv_ch > 0.5)
    ret = np.where(bad, np.nan, ret)
    ovn = np.where(bad, np.nan, ovn)
    lvl = np.where(bad, np.nan, lvl)

    close_r = prices.channel("close_raw").astype(np.float64)
    vol_r = prices.channel("volume_raw").astype(np.float64)
    ok_dv = (
        ~bad
        & np.isfinite(close_r)
        & (close_r > 0.0)
        & np.isfinite(vol_r)
        & (vol_r >= 0.0)
    )
    dvol = np.where(ok_dv, close_r * vol_r, np.nan)
    return ret, ovn, lvl, dvol


def _market_series(prices: Any, mat: np.ndarray) -> np.ndarray:
    b_idx = prices.benchmark_idx
    if 0 <= b_idx < mat.shape[0]:
        return mat[b_idx]
    with np.errstate(invalid="ignore"):
        return np.nanmean(mat, axis=0)


def _rolling_ols_beta_1d(
    y: np.ndarray,
    x_1d: np.ndarray,
    window: int,
    min_periods: int,
) -> np.ndarray:
    """Fast O(N*T) causal rolling univariate OLS slope of ``y[N, T]`` on ``x_1d[T]``."""
    n_assets, n_sess = y.shape
    out = np.full((n_assets, n_sess), np.nan, dtype=np.float64)
    if n_assets == 0 or n_sess == 0 or window < 2:
        return out
    x = np.asarray(x_1d, dtype=np.float64)[:n_sess]
    valid = np.isfinite(y) & np.isfinite(x)[None, :]
    xv = np.where(valid, x[None, :], 0.0)
    yv = np.where(valid, y, 0.0)
    vn = valid.astype(np.float64)

    def _wsum(a: np.ndarray) -> np.ndarray:
        cs = np.zeros((n_assets, n_sess + 1), dtype=np.float64)
        np.cumsum(a, axis=1, out=cs[:, 1:])
        left = np.zeros((n_assets, n_sess), dtype=np.float64)
        if n_sess > window:
            left[:, window:] = cs[:, 1 : n_sess - window + 1]
        return cs[:, 1:] - left

    cnt = _wsum(vn)
    sx = _wsum(xv)
    sy = _wsum(yv)
    sxx = _wsum(xv * xv)
    sxy = _wsum(xv * yv)
    with np.errstate(invalid="ignore", divide="ignore"):
        denom = sxx - (sx * sx) / cnt
        numer = sxy - (sx * sy) / cnt
        ok = (cnt >= min_periods) & (denom > 1e-12)
        out[ok] = numer[ok] / denom[ok]
    return out


# ---------------------------------------------------------------------------
# 1. Peer spillover (short-window Bayesian-shrunk co-movement, >=20d IPO-ready)
# ---------------------------------------------------------------------------

_PEER_SPILLOVER_COLS: tuple[str, ...] = (
    "peer_spill_ret_5d_63w",
    "peer_spill_ret_21d_63w",
    "peer_spill_dvol_shock_5d_63w",
    "peer_spill_ovn_5d_63w",
    "peer_spill_max_corr_63w",
    "peer_spill_ret_5d_252w",
    "peer_spill_ret_21d_252w",
    "peer_spill_dvol_shock_5d_252w",
    "peer_spill_ovn_5d_252w",
    "peer_spill_ret_gap_5d_63w",
)


def _overlap_shrunk_topk_spillover(
    block: np.ndarray,
    *,
    ciks: list[str],
    min_overlap: int,
    shrink_k: float,
    top_k: int,
    ret_5d: np.ndarray,
    ret_21d: np.ndarray,
    dvol_shock: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Compute overlap-exact Bayesian-shrunk Top-K peer weighted signals for one session."""
    m = block.shape[0]
    nan_vec = np.full(m, np.nan, dtype=np.float64)
    if m < 2 or block.shape[1] < min_overlap:
        return nan_vec.copy(), nan_vec.copy(), nan_vec.copy(), nan_vec.copy()

    finite = np.isfinite(block)
    valid_f = finite.astype(np.float32)
    n_ov = valid_f @ valid_f.T  # [M, M]

    # Row-wise mean over valid entries, then zero-fill missing
    row_cnt = finite.sum(axis=1, keepdims=True)
    with np.errstate(invalid="ignore", divide="ignore"):
        row_sum = np.where(finite, block, 0.0).sum(axis=1, keepdims=True)
        row_mean = np.where(row_cnt > 0, row_sum / np.maximum(row_cnt, 1), 0.0)
    centered = np.where(finite, block - row_mean, 0.0).astype(np.float32)

    num = centered @ centered.T
    ss_a = (centered * centered) @ valid_f.T
    denom = np.sqrt(np.maximum(ss_a * ss_a.T, 1e-12))
    corr = np.clip(num / denom, -1.0, 1.0)
    shrunk = corr * (n_ov / (n_ov + np.float32(shrink_k)))

    np.fill_diagonal(shrunk, -1.0)
    shrunk[n_ov < float(min_overlap)] = -1.0

    # Exclude same-CIK share-class siblings from peers
    cik_buckets: dict[str, list[int]] = {}
    for i, c in enumerate(ciks):
        if c:
            cik_buckets.setdefault(c, []).append(i)
    for idxs in cik_buckets.values():
        if len(idxs) > 1:
            for a in idxs:
                for b in idxs:
                    shrunk[a, b] = -1.0

    out_r5 = np.full(m, np.nan, dtype=np.float64)
    out_r21 = np.full(m, np.nan, dtype=np.float64)
    out_dv = np.full(m, np.nan, dtype=np.float64)
    out_mc = np.full(m, np.nan, dtype=np.float64)

    k_eff = min(max(1, int(top_k)), m - 1)
    for i in range(m):
        row = shrunk[i]
        if k_eff < m:
            top_idx = np.argpartition(row, -k_eff)[-k_eff:]
        else:
            top_idx = np.arange(m)
        w = row[top_idx].astype(np.float64)
        pos = w > 0.0
        if not pos.any():
            continue
        p_idx = top_idx[pos]
        w_pos = w[pos]
        out_mc[i] = float(np.mean(w_pos))

        for target_vec, out_vec in (
            (ret_5d, out_r5),
            (ret_21d, out_r21),
            (dvol_shock, out_dv),
        ):
            vals = target_vec[p_idx]
            ok = np.isfinite(vals)
            if ok.any():
                wk = w_pos[ok]
                out_vec[i] = float(np.dot(wk, vals[ok]) / np.sum(wk))
    return out_r5, out_r21, out_dv, out_mc


@register_feature_group(
    "peer_spillover",
    columns=_PEER_SPILLOVER_COLS,
    default_params={"top_k": 10, "shrinkage_days": 20.0},
    description="Bayesian-shrunk 63d (>=20d IPO-ready) and 252d residual & overnight peer spillover.",
)
def build_peer_spillover(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    af = ctx.stores.anchors.frame
    prices = ctx.stores.prices
    n = len(af)
    data = {col: np.full(n, np.nan, dtype=np.float32) for col in _PEER_SPILLOVER_COLS}
    if n == 0 or prices.data.shape[0] < 2 or prices.data.shape[1] < 20:
        return pd.DataFrame(data, index=af.index)

    top_k = int(params.get("top_k", 10))
    shrink_k = float(params.get("shrinkage_days", 20.0))

    ret, ovn, lvl, dvol = _clean_returns_and_dvol(ctx)
    n_assets, n_sess = ret.shape
    mkt_ret = _market_series(prices, ret)
    mkt_ovn = _market_series(prices, ovn)

    # Market-residualized daily returns & overnight gaps
    resid_ret = ret - mkt_ret[None, :]
    resid_ovn = ovn - mkt_ovn[None, :]

    # Trailing 5d / 21d excess returns and 5d-vs-63d log dollar-volume shock
    ret_5d = np.full((n_assets, n_sess), np.nan, dtype=np.float64)
    ret_21d = np.full((n_assets, n_sess), np.nan, dtype=np.float64)
    mkt_lvl = _market_series(prices, lvl)
    for w, target in ((5, ret_5d), (21, ret_21d)):
        if n_sess > w:
            p1, p0 = lvl[:, w:], lvl[:, :-w]
            m1, m0 = mkt_lvl[w:], mkt_lvl[:-w]
            ok = (
                np.isfinite(p1)
                & np.isfinite(p0)
                & (p0 > 0)
                & np.isfinite(m1)[None, :]
                & np.isfinite(m0)[None, :]
                & (m0 > 0)[None, :]
            )
            with np.errstate(invalid="ignore", divide="ignore"):
                m_ret = np.broadcast_to((m1 / m0 - 1.0)[None, :], p1.shape)
                target[:, w:][ok] = (p1[ok] / p0[ok] - 1.0) - m_ret[ok]

    dv5 = _rolling_mean(dvol, 5, min_periods=3)
    dv63 = _rolling_mean(dvol, 63, min_periods=20)
    with np.errstate(divide="ignore", invalid="ignore"):
        dv_shock = np.where(
            np.isfinite(dv5) & np.isfinite(dv63) & (dv5 > 0.0) & (dv63 > 0.0),
            np.log(dv5 / dv63),
            np.nan,
        )

    # PIT FF12 industry & CIK per anchor row
    ind_df = _industry.industry(ctx.version, ctx.samples, time_policy=ctx.time_policy)
    ff12_arr = (
        ind_df["ff12"].astype(object).fillna("").astype(str).to_numpy()
        if "ff12" in ind_df.columns
        else np.full(n, "", dtype=object)
    )
    ciks_arr = ctx.ciks.astype(object).fillna("").astype(str).to_numpy()

    ai = af["asset_idx"].to_numpy(dtype=np.int64, copy=False)
    si = af["session_idx"].to_numpy(dtype=np.int64, copy=False)

    # Group anchor rows by unique session_idx
    order = np.argsort(si, kind="mergesort")
    si_s = si[order]
    diffs = np.flatnonzero(np.diff(si_s)) + 1
    starts = np.concatenate(([0], diffs))
    ends = np.concatenate((diffs, [n]))

    for b_idx in range(len(starts)):
        s_pos = int(starts[b_idx])
        e_pos = int(ends[b_idx])
        s = int(si_s[s_pos])
        if s < 19 or s >= n_sess:
            continue
        rows = order[s_pos:e_pos]
        a_sub = ai[rows]
        ok_a = (a_sub >= 0) & (a_sub < n_assets)
        if ok_a.sum() < 2:
            continue
        rows = rows[ok_a]
        a_sub = a_sub[ok_a]
        c_sub = ciks_arr[rows].tolist()
        f_sub = ff12_arr[rows]

        r5_sub = ret_5d[a_sub, s]
        r21_sub = ret_21d[a_sub, s]
        dv_sub = dv_shock[a_sub, s]

        def _industry_demean(
            block_in: np.ndarray, ind_codes: np.ndarray = f_sub
        ) -> np.ndarray:
            blk = block_in.copy()
            ind_groups: dict[str, list[int]] = {}
            for idx_i, ind_code in enumerate(ind_codes):
                if ind_code:
                    ind_groups.setdefault(str(ind_code), []).append(idx_i)
            for members in ind_groups.values():
                if len(members) >= 3:
                    sub_b = blk[members]
                    col_any = np.any(np.isfinite(sub_b), axis=0)
                    if col_any.any():
                        ind_mean = np.full(
                            (1, sub_b.shape[1]), np.nan, dtype=np.float64
                        )
                        ind_mean[0, col_any] = np.nanmean(sub_b[:, col_any], axis=0)
                        blk[members] = np.where(
                            np.isfinite(ind_mean), sub_b - ind_mean, sub_b
                        )
            return blk

        # 63d window (min 20d overlap -> supports newly listed IPOs)
        lo63 = max(0, s - 62)
        blk_r63 = _industry_demean(resid_ret[a_sub, lo63 : s + 1])
        blk_o63 = _industry_demean(resid_ovn[a_sub, lo63 : s + 1])
        sr5_63, sr21_63, sdv_63, smc_63 = _overlap_shrunk_topk_spillover(
            blk_r63,
            ciks=c_sub,
            min_overlap=20,
            shrink_k=shrink_k,
            top_k=top_k,
            ret_5d=r5_sub,
            ret_21d=r21_sub,
            dvol_shock=dv_sub,
        )
        sovn_63, _, _, _ = _overlap_shrunk_topk_spillover(
            blk_o63,
            ciks=c_sub,
            min_overlap=20,
            shrink_k=shrink_k,
            top_k=top_k,
            ret_5d=r5_sub,
            ret_21d=r21_sub,
            dvol_shock=dv_sub,
        )
        data["peer_spill_ret_5d_63w"][rows] = sr5_63.astype(np.float32)
        data["peer_spill_ret_21d_63w"][rows] = sr21_63.astype(np.float32)
        data["peer_spill_dvol_shock_5d_63w"][rows] = sdv_63.astype(np.float32)
        data["peer_spill_ovn_5d_63w"][rows] = sovn_63.astype(np.float32)
        data["peer_spill_max_corr_63w"][rows] = smc_63.astype(np.float32)
        data["peer_spill_ret_gap_5d_63w"][rows] = (r5_sub - sr5_63).astype(np.float32)

        # 252d window (min 126d overlap)
        if s >= 125:
            lo252 = max(0, s - 251)
            blk_r252 = _industry_demean(resid_ret[a_sub, lo252 : s + 1])
            blk_o252 = _industry_demean(resid_ovn[a_sub, lo252 : s + 1])
            sr5_252, sr21_252, sdv_252, _ = _overlap_shrunk_topk_spillover(
                blk_r252,
                ciks=c_sub,
                min_overlap=126,
                shrink_k=shrink_k,
                top_k=top_k,
                ret_5d=r5_sub,
                ret_21d=r21_sub,
                dvol_shock=dv_sub,
            )
            sovn_252, _, _, _ = _overlap_shrunk_topk_spillover(
                blk_o252,
                ciks=c_sub,
                min_overlap=126,
                shrink_k=shrink_k,
                top_k=top_k,
                ret_5d=r5_sub,
                ret_21d=r21_sub,
                dvol_shock=dv_sub,
            )
            data["peer_spill_ret_5d_252w"][rows] = sr5_252.astype(np.float32)
            data["peer_spill_ret_21d_252w"][rows] = sr21_252.astype(np.float32)
            data["peer_spill_dvol_shock_5d_252w"][rows] = sdv_252.astype(np.float32)
            data["peer_spill_ovn_5d_252w"][rows] = sovn_252.astype(np.float32)

    return pd.DataFrame(data, index=af.index)


# ---------------------------------------------------------------------------
# 2. Delayed-filing-aware SEC shock interaction
# ---------------------------------------------------------------------------

_EXEC_KINDS = frozenset({"officer_director_change", "control_change"})
_DISTRESS_KINDS = frozenset(
    {
        "non_reliance",
        "bankruptcy",
        "debt_acceleration",
        "listing_deficiency",
        "auditor_change",
        "late_filing_notice",
        "impairment",
        "exit_costs",
    }
)
_CAPITAL_KINDS = frozenset(
    {"prospectus_supplement", "unregistered_equity_sale", "shelf_registration"}
)
_DEAL_KINDS = frozenset(
    {
        "material_agreement",
        "agreement_termination",
        "acquisition_or_disposition_completed",
        "merger_registration",
        "merger_proxy",
        "third_party_tender_offer",
        "activist_stake",
    }
)
_HIGH_SENS_KINDS = _EXEC_KINDS | _DISTRESS_KINDS | _CAPITAL_KINDS | _DEAL_KINDS

_SEC_SHOCK_COLS: tuple[str, ...] = (
    "ev_unexplained_jump_1d",
    "ev_unexplained_jump_5d_max",
    "ev_unexplained_vol_spike_1d",
    "sec_shock_any_ret",
    "sec_shock_any_z",
    "sec_shock_any_vol_peak",
    "sec_shock_any_recovery",
    "sec_shock_any_delay_days",
    "sec_shock_exec_z",
    "sec_shock_exec_recovery",
    "sec_shock_distress_z",
    "sec_shock_capital_z",
    "sec_shock_deal_z",
    "sec_shock_high_sens_count_63d",
)


@register_feature_group(
    "sec_shock_interaction",
    columns=_SEC_SHOCK_COLS,
    default_params={"lookback_sessions": 21},
    description="Unexplained jump detector + delayed-filing-aware SEC 8-K retrospective shock & recovery.",
)
def build_sec_shock_interaction(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    af = ctx.stores.anchors.frame
    prices = ctx.stores.prices
    ev_store = ctx.stores.events
    n = len(af)
    data = {col: np.full(n, np.nan, dtype=np.float32) for col in _SEC_SHOCK_COLS}
    if n == 0 or prices.data.shape[1] == 0:
        return pd.DataFrame(data, index=af.index)

    lookback = max(5, int(params.get("lookback_sessions", 21)))
    ret, _, lvl, dvol = _clean_returns_and_dvol(ctx)
    n_assets, n_sess = ret.shape
    mkt_ret = _market_series(prices, ret)
    mkt_lvl = _market_series(prices, lvl)
    resid = ret - mkt_ret[None, :]
    rvol = _rolling_std(resid, 63, min_periods=20)
    dv21 = _rolling_mean(dvol, 21, min_periods=10)

    with np.errstate(invalid="ignore", divide="ignore"):
        z_mat = np.where(np.isfinite(rvol) & (rvol > 1e-6), resid / rvol, np.nan)
        vol_ratio = np.where(
            np.isfinite(dvol) & np.isfinite(dv21) & (dv21 > 0.0),
            dvol / dv21,
            np.nan,
        )

    sess_ords = np.array([d.toordinal() for d in prices.sessions], dtype=np.int32)
    cal = ctx.calendar
    cal_closes = cal.closes[:n_sess]

    # Map kind_code -> category bitmask
    kind_cats = np.zeros(len(ev_store.kinds), dtype=np.uint8)
    for k_idx, k_name in enumerate(ev_store.kinds):
        mask_b = 0
        if k_name in _EXEC_KINDS:
            mask_b |= 1
        if k_name in _DISTRESS_KINDS:
            mask_b |= 2
        if k_name in _CAPITAL_KINDS:
            mask_b |= 4
        if k_name in _DEAL_KINDS:
            mask_b |= 8
        kind_cats[k_idx] = mask_b

    ai = af["asset_idx"].to_numpy(dtype=np.int64, copy=False)
    si = af["session_idx"].to_numpy(dtype=np.int64, copy=False)
    dec_ns = clocks.instants(af["decision_at"].to_numpy(dtype=object))

    # Process grouped by asset_idx
    order = np.argsort(ai, kind="mergesort")
    ai_s = ai[order]
    diffs = np.flatnonzero(np.diff(ai_s)) + 1
    starts = np.concatenate(([0], diffs))
    ends = np.concatenate((diffs, [n]))

    for b_idx in range(len(starts)):
        s_pos = int(starts[b_idx])
        e_pos = int(ends[b_idx])
        a_i = int(ai_s[s_pos])
        if a_i < 0 or a_i >= n_assets:
            continue
        rows = order[s_pos:e_pos]

        # Extract SEC events for asset a_i
        if a_i + 1 < len(ev_store.asset_offsets):
            e0 = int(ev_store.asset_offsets[a_i])
            e1 = int(ev_store.asset_offsets[a_i + 1])
        else:
            e0 = e1 = 0

        sec_av = np.empty(0, dtype=np.int64)
        sec_ord = np.empty(0, dtype=np.int32)
        sec_cat = np.empty(0, dtype=np.uint8)
        sec_t_idx = np.empty(0, dtype=np.int32)
        if e1 > e0:
            srcs = ev_store.source_id[e0:e1]
            av_a = ev_store.available_at_ns[e0:e1]
            is_sec = (srcs == 0) & (av_a != clocks.NAT)
            if is_sec.any():
                sub_idx = np.flatnonzero(is_sec) + e0
                av_v = ev_store.available_at_ns[sub_idx]
                perm = np.argsort(av_v, kind="mergesort")
                sub_idx = sub_idx[perm]
                sec_av = ev_store.available_at_ns[sub_idx]
                sec_ord = ev_store.event_date_ordinals[sub_idx]
                kc = ev_store.kind_code[sub_idx]
                sec_cat = np.where(
                    (kc >= 0) & (kc < len(kind_cats)),
                    kind_cats[np.clip(kc, 0, max(0, len(kind_cats) - 1))],
                    0,
                ).astype(np.uint8)
                sec_t_idx = np.clip(
                    np.searchsorted(cal_closes, sec_av, side="left"),
                    0,
                    max(0, n_sess - 1),
                ).astype(np.int32)

        z_a = z_mat[a_i]
        r_a = resid[a_i]
        vr_a = vol_ratio[a_i]
        lvl_a = lvl[a_i]

        def _retro_shock(
            ev_t: int,
            ev_ord_val: int,
            s_now: int,
            *,
            _z_a: np.ndarray = z_a,
            _r_a: np.ndarray = r_a,
            _vr_a: np.ndarray = vr_a,
            _lvl_a: np.ndarray = lvl_a,
        ) -> tuple[float, float, float, float, float]:
            """Causal retrospective peak residual shock & recovery strictly inside [win_lo .. min(s_now, ev_t+1)]."""
            ev_d_idx = ev_t
            delay_d = float("nan")
            if ev_ord_val > 0 and len(sess_ords):
                cand_idx = int(np.searchsorted(sess_ords, ev_ord_val, side="left"))
                if cand_idx >= n_sess:
                    cand_idx = n_sess - 1
                if cand_idx <= ev_t:
                    ev_d_idx = max(ev_t - 10, cand_idx)
                    delay_d = float(np.clip(int(sess_ords[ev_t]) - ev_ord_val, 0, 30))
                else:
                    delay_d = 0.0
            win_lo = max(0, min(ev_d_idx, ev_t) - 5)
            win_hi = min(s_now, ev_t + 1)
            if win_lo > win_hi:
                return 0.0, 0.0, 0.0, 0.0, delay_d

            seg_z = _z_a[win_lo : win_hi + 1]
            seg_r = _r_a[win_lo : win_hi + 1]
            seg_vr = _vr_a[win_lo : win_hi + 1]
            fin_r = np.isfinite(seg_r)
            if not fin_r.any():
                return 0.0, 0.0, 0.0, 0.0, delay_d

            abs_r = np.where(fin_r, np.abs(seg_r), -1.0)
            rel_peak = int(np.argmax(abs_r))
            peak_idx = win_lo + rel_peak
            shock_ret = float(seg_r[rel_peak])
            shock_z = float(seg_z[rel_peak]) if np.isfinite(seg_z[rel_peak]) else 0.0
            fin_vr = seg_vr[np.isfinite(seg_vr) & (seg_vr > 0.0)]
            vol_peak = float(np.log(np.max(fin_vr))) if len(fin_vr) else 0.0

            rec_ratio = 0.0
            if (
                peak_idx < s_now
                and abs(shock_ret) > 0.01
                and np.isfinite(_lvl_a[peak_idx])
                and _lvl_a[peak_idx] > 0.0
                and np.isfinite(_lvl_a[s_now])
                and _lvl_a[s_now] > 0.0
            ):
                cum_after = float(_lvl_a[s_now] / _lvl_a[peak_idx] - 1.0)
                if (
                    np.isfinite(mkt_lvl[peak_idx])
                    and mkt_lvl[peak_idx] > 0.0
                    and np.isfinite(mkt_lvl[s_now])
                    and mkt_lvl[s_now] > 0.0
                ):
                    cum_after -= float(mkt_lvl[s_now] / mkt_lvl[peak_idx] - 1.0)
                rec_ratio = float(np.clip(-cum_after / shock_ret, -2.0, 2.0))
            return shock_ret, shock_z, vol_peak, rec_ratio, delay_d

        for row_i in rows.tolist():
            s = int(si[row_i])
            d_ns = int(dec_ns[row_i])
            if s < 0 or s >= n_sess or d_ns == clocks.NAT:
                continue

            # Visible SEC events up to decision_at
            n_vis = (
                int(np.searchsorted(sec_av, d_ns, side="right")) if len(sec_av) else 0
            )
            vis_t = sec_t_idx[:n_vis]

            # Leg 1: Unexplained jump (>3 sigma residual with no SEC filing in [d-2 .. d])
            if np.isfinite(z_a[s]):
                has_sec_2d = bool(
                    len(vis_t) and np.any((vis_t >= s - 2) & (vis_t <= s))
                )
                vr_s = float(vr_a[s]) if np.isfinite(vr_a[s]) and vr_a[s] > 0.0 else 1.0
                if abs(z_a[s]) > 3.0 and not has_sec_2d:
                    data["ev_unexplained_jump_1d"][row_i] = np.float32(
                        z_a[s] * math.log1p(vr_s)
                    )
                    data["ev_unexplained_vol_spike_1d"][row_i] = np.float32(
                        math.log(max(vr_s, 1e-6))
                    )
                else:
                    data["ev_unexplained_jump_1d"][row_i] = np.float32(0.0)
                    data["ev_unexplained_vol_spike_1d"][row_i] = np.float32(0.0)

                best_j = 0.0
                for d_off in range(max(0, s - 4), s + 1):
                    if not np.isfinite(z_a[d_off]) or abs(z_a[d_off]) <= 3.0:
                        continue
                    has_sec_d = bool(
                        len(vis_t) and np.any((vis_t >= d_off - 2) & (vis_t <= d_off))
                    )
                    if has_sec_d:
                        continue
                    vr_d = (
                        float(vr_a[d_off])
                        if np.isfinite(vr_a[d_off]) and vr_a[d_off] > 0.0
                        else 1.0
                    )
                    cand_j = float(z_a[d_off] * math.log1p(vr_d))
                    if abs(cand_j) > abs(best_j):
                        best_j = cand_j
                data["ev_unexplained_jump_5d_max"][row_i] = np.float32(best_j)

            # Leg 2: High-sensitivity SEC filing retrospective shock & recovery
            data["sec_shock_any_ret"][row_i] = np.float32(0.0)
            data["sec_shock_any_z"][row_i] = np.float32(0.0)
            data["sec_shock_any_vol_peak"][row_i] = np.float32(0.0)
            data["sec_shock_any_recovery"][row_i] = np.float32(0.0)
            data["sec_shock_exec_z"][row_i] = np.float32(0.0)
            data["sec_shock_exec_recovery"][row_i] = np.float32(0.0)
            data["sec_shock_distress_z"][row_i] = np.float32(0.0)
            data["sec_shock_capital_z"][row_i] = np.float32(0.0)
            data["sec_shock_deal_z"][row_i] = np.float32(0.0)

            if n_vis == 0:
                data["sec_shock_high_sens_count_63d"][row_i] = np.float32(0.0)
                continue

            vis_cat = sec_cat[:n_vis]
            vis_ord = sec_ord[:n_vis]
            hs_63 = (vis_cat > 0) & (vis_t >= s - 62) & (vis_t <= s)
            data["sec_shock_high_sens_count_63d"][row_i] = np.float32(int(hs_63.sum()))

            hs_recent = np.flatnonzero(
                (vis_cat > 0) & (vis_t >= s - lookback + 1) & (vis_t <= s)
            )
            if len(hs_recent):
                last_ev = int(hs_recent[-1])
                s_ret, s_z, s_vp, s_rec, s_del = _retro_shock(
                    int(vis_t[last_ev]), int(vis_ord[last_ev]), s
                )
                data["sec_shock_any_ret"][row_i] = np.float32(s_ret)
                data["sec_shock_any_z"][row_i] = np.float32(s_z)
                data["sec_shock_any_vol_peak"][row_i] = np.float32(s_vp)
                data["sec_shock_any_recovery"][row_i] = np.float32(s_rec)
                if math.isfinite(s_del):
                    data["sec_shock_any_delay_days"][row_i] = np.float32(s_del)

            for bit, win_cat, z_col, rec_col in (
                (1, lookback, "sec_shock_exec_z", "sec_shock_exec_recovery"),
                (2, 63, "sec_shock_distress_z", None),
                (4, lookback, "sec_shock_capital_z", None),
                (8, lookback, "sec_shock_deal_z", None),
            ):
                cat_idx = np.flatnonzero(
                    ((vis_cat & bit) != 0) & (vis_t >= s - win_cat + 1) & (vis_t <= s)
                )
                if len(cat_idx):
                    last_c = int(cat_idx[-1])
                    _, c_z, _, c_rec, _ = _retro_shock(
                        int(vis_t[last_c]), int(vis_ord[last_c]), s
                    )
                    data[z_col][row_i] = np.float32(c_z)
                    if rec_col is not None:
                        data[rec_col][row_i] = np.float32(c_rec)

    return pd.DataFrame(data, index=af.index)


# ---------------------------------------------------------------------------
# 3. Zero-parameter macro shock sensitivity & crisis interaction
# ---------------------------------------------------------------------------

_MACRO_SENS_COLS: tuple[str, ...] = (
    "mac_beta_d10y_252d",
    "mac_beta_slope_252d",
    "mac_beta_credit_252d",
    "mac_beta_oil_252d",
    "mac_beta_gold_252d",
    "mac_beta_usd_252d",
    "mac_beta_vix_252d",
    "mac_beta_qqq_spy_252d",
    "mac_beta_iwm_spy_252d",
    "mac_beta_iwf_iwd_252d",
    "mac_panic_inversion",
    "mac_panic_oversold_x",
    "mac_panic_qqq_x",
    "mac_panic_vix_x",
    "mac_panic_credit_x",
)


def _daily_diff(arr: np.ndarray) -> np.ndarray:
    out = np.full(len(arr), np.nan, dtype=np.float64)
    if len(arr) > 1:
        out[1:] = arr[1:] - arr[:-1]
    return out


def _daily_log_ret(arr: np.ndarray) -> np.ndarray:
    out = np.full(len(arr), np.nan, dtype=np.float64)
    if len(arr) > 1:
        a1, a0 = arr[1:], arr[:-1]
        ok = np.isfinite(a1) & np.isfinite(a0) & (a1 > 0.0) & (a0 > 0.0)
        out[1:][ok] = np.log(a1[ok] / a0[ok])
    return out


@register_feature_group(
    "macro_sensitivity_crisis",
    columns=_MACRO_SENS_COLS,
    default_params={"window": 252},
    description="Causal 252d stock sensitivities to rates/credit/commodities/VIX/style + zero-param crisis crosses.",
)
def build_macro_sensitivity_crisis(
    ctx: GroupBuildContext, params: Mapping[str, Any]
) -> pd.DataFrame:
    af = ctx.stores.anchors.frame
    prices = ctx.stores.prices
    mstore = ctx.stores.macro
    n = len(af)
    data = {col: np.full(n, np.nan, dtype=np.float32) for col in _MACRO_SENS_COLS}
    if n == 0 or prices.data.shape[1] == 0 or mstore.data.shape[0] == 0:
        return pd.DataFrame(data, index=af.index)

    win = max(63, int(params.get("window", 252)))
    mp = max(42, win // 2)
    ret, _, lvl, _ = _clean_returns_and_dvol(ctx)
    n_assets, n_sess = ret.shape
    mkt_ret = _market_series(prices, ret)
    resid = ret - mkt_ret[None, :]

    m_cols = {c: idx for idx, c in enumerate(mstore.columns)}
    m_len = min(n_sess, mstore.data.shape[0])

    def _mcol(name: str) -> np.ndarray:
        out = np.full(n_sess, np.nan, dtype=np.float64)
        idx = m_cols.get(name)
        if idx is not None and m_len > 0:
            out[:m_len] = mstore.data[:m_len, idx].astype(np.float64)
        return out

    dgs10 = _mcol("raw_dgs10") / 100.0
    dgs2 = _mcol("raw_dgs2") / 100.0
    baa = _mcol("raw_baa10y") / 100.0
    oil = _mcol("raw_dcoilwtico")
    usd = _mcol("raw_dtwexbgs")
    vix = _mcol("raw_vixcls")
    if not np.any(np.isfinite(vix)):
        vix = _mcol("ref_vix")
    vxv = _mcol("raw_vxvcls")
    baa_pct = _mcol("raw_baa10y")
    if not np.any(np.isfinite(baa_pct)):
        baa_pct = _mcol("ref_credit_baa") * 100.0

    spy_1d = _mcol("etf_ret_1d_spy")
    qqq_1d = _mcol("etf_ret_1d_qqq")
    gld_1d = _mcol("etf_ret_1d_gld")
    iwm_1d = _mcol("etf_ret_1d_iwm")
    iwf_1d = _mcol("etf_ret_1d_iwf")
    iwd_1d = _mcol("etf_ret_1d_iwd")

    shocks: dict[str, np.ndarray] = {
        "mac_beta_d10y_252d": _daily_diff(dgs10),
        "mac_beta_slope_252d": _daily_diff(dgs10 - dgs2),
        "mac_beta_credit_252d": _daily_diff(baa),
        "mac_beta_oil_252d": _daily_log_ret(oil),
        "mac_beta_gold_252d": gld_1d,
        "mac_beta_usd_252d": _daily_log_ret(usd),
        "mac_beta_vix_252d": _daily_log_ret(vix),
        "mac_beta_qqq_spy_252d": qqq_1d - spy_1d,
        "mac_beta_iwm_spy_252d": iwm_1d - spy_1d,
        "mac_beta_iwf_iwd_252d": iwf_1d - iwd_1d,
    }
    betas_mat: dict[str, np.ndarray] = {}
    for col_name, shock_arr in shocks.items():
        if np.isfinite(shock_arr).sum() >= mp:
            b_mat = _rolling_ols_beta_1d(resid, shock_arr, win, mp)
        else:
            b_mat = np.full((n_assets, n_sess), np.nan, dtype=np.float64)
        betas_mat[col_name] = b_mat
        data[col_name] = _select_at_anchors(b_mat, ctx.stores.anchors)

    # Zero-parameter explicit crisis interactions (dormant=0 in calm markets)
    with np.errstate(invalid="ignore", divide="ignore"):
        vix_ratio = np.where(
            np.isfinite(vix) & np.isfinite(vxv) & (vix > 0.0) & (vxv > 0.0),
            np.log(vix / vxv),
            np.nan,
        )
        panic_inv = np.where(
            np.isfinite(vix) & np.isfinite(vix_ratio),
            np.maximum(0.0, vix - 25.0) * np.maximum(0.0, vix_ratio),
            np.nan,
        )
        panic_high = np.where(np.isfinite(vix), np.maximum(0.0, vix - 30.0), np.nan)
        credit_stress = np.where(
            np.isfinite(baa_pct), np.maximum(0.0, baa_pct - 2.5), np.nan
        )

    ret_21d = np.full((n_assets, n_sess), np.nan, dtype=np.float64)
    if n_sess > 21:
        p1, p0 = lvl[:, 21:], lvl[:, :-21]
        ok = np.isfinite(p1) & np.isfinite(p0) & (p0 > 0.0)
        ret_21d[:, 21:][ok] = p1[ok] / p0[ok] - 1.0

    si = af["session_idx"].to_numpy(dtype=np.int64, copy=False)
    valid_s = (si >= 0) & (si < n_sess)
    p_inv_row = np.full(n, np.nan, dtype=np.float64)
    p_hi_row = np.full(n, np.nan, dtype=np.float64)
    c_str_row = np.full(n, np.nan, dtype=np.float64)
    p_inv_row[valid_s] = panic_inv[si[valid_s]]
    p_hi_row[valid_s] = panic_high[si[valid_s]]
    c_str_row[valid_s] = credit_stress[si[valid_s]]

    r21_row = _select_at_anchors(ret_21d, ctx.stores.anchors).astype(np.float64)
    b_qqq = data["mac_beta_qqq_spy_252d"].astype(np.float64)
    b_vix = data["mac_beta_vix_252d"].astype(np.float64)
    b_crd = data["mac_beta_credit_252d"].astype(np.float64)

    data["mac_panic_inversion"] = p_inv_row.astype(np.float32)
    data["mac_panic_oversold_x"] = np.where(
        np.isfinite(p_inv_row) & (p_inv_row == 0.0),
        0.0,
        p_inv_row * (-r21_row),
    ).astype(np.float32)
    data["mac_panic_qqq_x"] = np.where(
        np.isfinite(p_hi_row) & (p_hi_row == 0.0),
        0.0,
        p_hi_row * b_qqq,
    ).astype(np.float32)
    data["mac_panic_vix_x"] = np.where(
        np.isfinite(p_hi_row) & (p_hi_row == 0.0),
        0.0,
        p_hi_row * (-b_vix),
    ).astype(np.float32)
    data["mac_panic_credit_x"] = np.where(
        np.isfinite(c_str_row) & (c_str_row == 0.0),
        0.0,
        c_str_row * (-b_crd),
    ).astype(np.float32)

    return pd.DataFrame(data, index=af.index)
