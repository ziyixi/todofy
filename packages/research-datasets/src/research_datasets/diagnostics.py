"""Feature drift scorecards and source-coverage survivorship placebo audits for Data v2."""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import date, timedelta
from typing import Any

import numpy as np
import pandas as pd

from . import clocks

BENIGN_ACCOUNTING_ZERO_PREFIXES: tuple[str, ...] = (
    "dividend_",
    "val_dividend_",
    "val_net_payout_",
    "repurchases_",
    "buyback_",
    "rnd_",
    "goodwill_",
    "intangibles_",
    "minority_interest_",
    "preferred_stock_",
    "restate_",
)

LANDMARK_DELISTED_SYMBOLS: tuple[str, ...] = ("SIVB", "FRC", "BBBY", "TWTR")


def _mann_whitney_auc(y_true: np.ndarray, score: np.ndarray) -> float:
    """Exact rank-based ROC AUC without external sklearn dependency."""
    ok = np.isfinite(score) & np.isfinite(y_true)
    if not ok.any():
        return float("nan")
    yt = (y_true[ok] > 0.5).astype(bool)
    sc = score[ok].astype(np.float64)
    n_pos = int(yt.sum())
    n_neg = int((~yt).sum())
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    ranks = pd.Series(sc).rank(method="average").to_numpy(dtype=np.float64)
    sum_pos_ranks = float(ranks[yt].sum())
    return (sum_pos_ranks - n_pos * (n_pos + 1) / 2.0) / float(n_pos * n_neg)


def _population_stability_index(
    ref_vals: np.ndarray, cur_vals: np.ndarray, *, n_bins: int = 10
) -> float:
    """Compute clipped 10-bin Population Stability Index (PSI) between two distributions."""
    r = ref_vals[np.isfinite(ref_vals)].astype(np.float64)
    c = cur_vals[np.isfinite(cur_vals)].astype(np.float64)
    if len(r) < 20 or len(c) < 20:
        return 0.0
    quantiles = np.linspace(0.0, 1.0, n_bins + 1)
    edges = np.unique(np.quantile(r, quantiles))
    if len(edges) < 3:
        p_r = np.clip(float(np.mean(r != 0.0)), 1e-4, 1.0 - 1e-4)
        p_c = np.clip(float(np.mean(c != 0.0)), 1e-4, 1.0 - 1e-4)
        return float(
            (p_c - p_r) * math.log(p_c / p_r)
            + ((1.0 - p_c) - (1.0 - p_r)) * math.log((1.0 - p_c) / (1.0 - p_r))
        )
    edges[0] = -np.inf
    edges[-1] = np.inf
    r_cnt, _ = np.histogram(r, bins=edges)
    c_cnt, _ = np.histogram(c, bins=edges)
    r_p = np.clip(r_cnt / max(1, len(r)), 1e-4, 1.0)
    c_p = np.clip(c_cnt / max(1, len(c)), 1e-4, 1.0)
    r_p /= r_p.sum()
    c_p /= c_p.sum()
    return float(np.sum((c_p - r_p) * np.log(c_p / r_p)))


def _mean_cross_sectional_rank_ic(
    x_col: np.ndarray,
    y_col: np.ndarray,
    sessions: np.ndarray,
    valid_mask: np.ndarray,
) -> float:
    """Mean Spearman rank correlation across sessions with >= 10 valid observations."""
    ok = valid_mask & np.isfinite(x_col) & np.isfinite(y_col)
    if ok.sum() < 20:
        return float("nan")
    idx = np.flatnonzero(ok)
    s_sub = sessions[idx]
    ord_s = np.argsort(s_sub, kind="mergesort")
    idx_s = idx[ord_s]
    s_ord = s_sub[ord_s]
    diffs = np.flatnonzero(np.diff(s_ord)) + 1
    starts = np.concatenate(([0], diffs))
    ends = np.concatenate((diffs, [len(idx_s)]))
    ics: list[float] = []
    for s0, e0 in zip(starts.tolist(), ends.tolist(), strict=True):
        if e0 - s0 < 10:
            continue
        sl = idx_s[s0:e0]
        xv = x_col[sl]
        yv = y_col[sl]
        if np.nanstd(xv) <= 1e-8 or np.nanstd(yv) <= 1e-8:
            continue
        rx = pd.Series(xv).rank(method="average").to_numpy(dtype=np.float64)
        ry = pd.Series(yv).rank(method="average").to_numpy(dtype=np.float64)
        rx -= rx.mean()
        ry -= ry.mean()
        denom = math.sqrt(float(np.dot(rx, rx) * np.dot(ry, ry)))
        if denom > 1e-12:
            ics.append(float(np.dot(rx, ry)) / denom)
    return float(np.mean(ics)) if ics else float("nan")


def continuous_feature_scorecard(
    view_prev: Any,
    view_curr: Any,
    *,
    horizon: int = 21,
    psi_alert_threshold: float = 0.25,
    coverage_delta_threshold: float = 0.15,
) -> pd.DataFrame:
    """Compare feature distributions, active coverage, and matured Rank IC across two views."""
    prev_cols = set(view_prev.X.columns)
    curr_cols = list(view_curr.X.columns)
    shared = [c for c in curr_cols if c in prev_cols]

    prev_ord = np.array(
        [clocks.day(d).toordinal() for d in view_prev.anchors["signal_session"]],
        dtype=np.int32,
    )
    curr_ord = np.array(
        [clocks.day(d).toordinal() for d in view_curr.anchors["signal_session"]],
        dtype=np.int32,
    )
    max_prev_ord = int(prev_ord.max()) if len(prev_ord) else 0
    new_window_mask = curr_ord > max_prev_ord
    if new_window_mask.sum() < 50:
        # Fallback to trailing 25% of view_curr when views share the same cutoff
        cut = max(0, int(0.75 * len(curr_ord)))
        new_window_mask = np.zeros(len(curr_ord), dtype=bool)
        new_window_mask[cut:] = True

    y_col_name = f"h{int(horizon)}_gauss_rank"
    tr_col_name = f"trainable_{int(horizon)}d"
    prev_y = (
        pd.to_numeric(view_prev.y[y_col_name], errors="coerce").to_numpy(
            dtype=np.float64
        )
        if y_col_name in view_prev.y.columns
        else np.full(len(prev_ord), np.nan, dtype=np.float64)
    )
    prev_tr = (
        view_prev.y[tr_col_name].fillna(False).to_numpy(dtype=bool)
        if tr_col_name in view_prev.y.columns
        else np.zeros(len(prev_ord), dtype=bool)
    )
    curr_y = (
        pd.to_numeric(view_curr.y[y_col_name], errors="coerce").to_numpy(
            dtype=np.float64
        )
        if y_col_name in view_curr.y.columns
        else np.full(len(curr_ord), np.nan, dtype=np.float64)
    )
    curr_tr = (
        view_curr.y[tr_col_name].fillna(False).to_numpy(dtype=bool)
        if tr_col_name in view_curr.y.columns
        else np.zeros(len(curr_ord), dtype=bool)
    )

    rows: list[dict[str, Any]] = []
    for col in shared:
        vp = view_prev.X[col].to_numpy(dtype=np.float64, copy=False)
        vc_all = view_curr.X[col].to_numpy(dtype=np.float64, copy=False)
        vc_new = vc_all[new_window_mask]

        nz_prev = float(np.mean(np.isfinite(vp) & (vp != 0.0))) if len(vp) else 0.0
        nz_curr = (
            float(np.mean(np.isfinite(vc_new) & (vc_new != 0.0)))
            if len(vc_new)
            else 0.0
        )
        cov_delta = nz_curr - nz_prev
        psi = _population_stability_index(vp, vc_new)
        ic_prev = _mean_cross_sectional_rank_ic(vp, prev_y, prev_ord, prev_tr)
        ic_curr = _mean_cross_sectional_rank_ic(
            vc_new,
            curr_y[new_window_mask],
            curr_ord[new_window_mask],
            curr_tr[new_window_mask],
        )
        ic_delta = (
            ic_curr - ic_prev
            if math.isfinite(ic_prev) and math.isfinite(ic_curr)
            else float("nan")
        )
        rows.append(
            {
                "feature": col,
                "nonzero_rate_prev": round(nz_prev, 6),
                "nonzero_rate_curr": round(nz_curr, 6),
                "coverage_delta": round(cov_delta, 6),
                "psi": round(psi, 6),
                "ic_prev": round(ic_prev, 6) if math.isfinite(ic_prev) else np.nan,
                "ic_curr": round(ic_curr, 6) if math.isfinite(ic_curr) else np.nan,
                "ic_delta": round(ic_delta, 6) if math.isfinite(ic_delta) else np.nan,
                "drift_alert": bool(
                    (psi > psi_alert_threshold)
                    or (abs(cov_delta) > coverage_delta_threshold)
                ),
            }
        )
    df = pd.DataFrame(rows)
    df.attrs["as_of_prev"] = str(view_prev.as_of)
    df.attrs["as_of_curr"] = str(view_curr.as_of)
    return df


def source_coverage_placebo_audit(
    dataset: Any,
    *,
    X: pd.DataFrame | None = None,
    anchors: pd.DataFrame | None = None,
    horizon_days: int = 730,
    auc_bounds: tuple[float, float] = (0.45, 0.55),
    benign_zero_prefixes: Sequence[str] = BENIGN_ACCOUNTING_ZERO_PREFIXES,
    landmark_symbols: Sequence[str] = LANDMARK_DELISTED_SYMBOLS,
) -> pd.DataFrame:
    """Audit whether feature missingness predicts future delisting, separating benign economic zeros."""
    if X is None or anchors is None:
        mat = dataset.materialize(include_stores=False, include_labels=False)
        X = mat.X
        anchors = mat.anchors.frame

    aids = anchors["asset_id"].astype(str).tolist()
    sig_days = [clocks.day(d) for d in anchors["signal_session"]]
    n = len(anchors)

    # Determine 2-year forward exit / delisting indicator per anchor row
    exit_day_by_asset: dict[str, date] = {}
    families = (dataset.manifest or {}).get("data_families") or {}
    if "delistings" in families and hasattr(dataset, "delistings"):
        del_df = dataset.delistings()
        if del_df is not None and not del_df.empty and "asset_id" in del_df.columns:
            d_col = (
                "delisting_date"
                if "delisting_date" in del_df.columns
                else ("last_date" if "last_date" in del_df.columns else None)
            )
            if d_col is not None:
                for rec in del_df.to_dict("records"):
                    aid_r = str(rec.get("asset_id") or "")
                    raw_d = rec.get(d_col)
                    if aid_r and raw_d is not None and pd.notna(raw_d):
                        try:
                            exit_day_by_asset[aid_r] = clocks.day(str(raw_d)[:10])
                        except ValueError:
                            pass
    for rec in (dataset.manifest or {}).get("universe") or ():
        aid_u = str(rec.get("asset_id") or "")
        st_u = str(rec.get("status") or "").lower()
        lt_u = rec.get("listed_to")
        if (
            aid_u
            and aid_u not in exit_day_by_asset
            and st_u not in {"", "active"}
            and lt_u
        ):
            try:
                exit_day_by_asset[aid_u] = clocks.day(str(lt_u)[:10])
            except ValueError:
                pass

    exits_2y = np.zeros(n, dtype=np.float64)
    for i, (aid_i, sd_i) in enumerate(zip(aids, sig_days, strict=True)):
        ex_d = exit_day_by_asset.get(aid_i)
        if ex_d is not None and sd_i <= ex_d <= (
            sd_i + timedelta(days=int(horizon_days))
        ):
            exits_2y[i] = 1.0

    benign_tup = tuple(benign_zero_prefixes)
    lo_auc, hi_auc = float(auc_bounds[0]), float(auc_bounds[1])
    rows: list[dict[str, Any]] = []
    for col in X.columns:
        vals = pd.to_numeric(X[col], errors="coerce").to_numpy(dtype=np.float64)
        is_missing = (~np.isfinite(vals)).astype(np.float64)
        auc_val = _mann_whitney_auc(exits_2y, is_missing)
        is_benign = str(col).startswith(benign_tup)
        category = "benign_economic_zero" if is_benign else "vendor_coverage"
        if category == "benign_economic_zero" or not math.isfinite(auc_val):
            passed = True
        else:
            passed = lo_auc <= auc_val <= hi_auc
        rows.append(
            {
                "feature": str(col),
                "category": category,
                "missing_rate": round(float(is_missing.mean()), 6) if n else 0.0,
                "delist_placebo_auc": round(auc_val, 6)
                if math.isfinite(auc_val)
                else np.nan,
                "gate_passed": bool(passed),
            }
        )

    # Check landmark delisted symbols coverage when present in universe
    sym_to_aids: dict[str, set[str]] = {}
    for rec in (dataset.manifest or {}).get("universe") or ():
        sym = str(rec.get("symbol") or "").upper()
        aid_u = str(rec.get("asset_id") or "")
        if sym and aid_u:
            sym_to_aids.setdefault(sym, set()).add(aid_u)

    landmark_report: dict[str, dict[str, Any]] = {}
    aids_series = anchors["asset_id"].astype(str)
    for sym in landmark_symbols:
        matched_aids = sym_to_aids.get(sym.upper(), set())
        if not matched_aids:
            continue
        sub_mask = aids_series.isin(matched_aids).to_numpy(dtype=bool)
        if not sub_mask.any():
            landmark_report[sym] = {"anchor_rows": 0, "finite_feature_share": 0.0}
            continue
        sub_x = X.loc[sub_mask].to_numpy(dtype=np.float64)
        landmark_report[sym] = {
            "anchor_rows": int(sub_mask.sum()),
            "finite_feature_share": round(float(np.isfinite(sub_x).mean()), 6),
        }

    out = pd.DataFrame(rows)
    out.attrs["landmark_delisted_coverage"] = landmark_report
    out.attrs["delisted_positive_rows"] = int(exits_2y.sum())
    return out
