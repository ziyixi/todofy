"""Point-in-time reference, market ETF, insider, short-interest, filing-text, and borrow features."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

import numpy as np
import pandas as pd

from . import candidates as _candidates
from . import clocks
from . import fundamentals_derived as _fundamentals_derived
from .asof import asof_join
from .clocks import NAT, NEW_YORK
from .constants import (
    DEFAULT_EXTRA_GROUPS,
    EXTRA_GROUPS,
    FAMILY_SPECS,
    REFERENCE_ETFS,
)

__all__ = [
    "BORROW_COLUMNS",
    "INSIDER_COLUMNS",
    "INSIDER_COVERAGE_CATEGORIES",
    "MARKET_ETF_COLUMNS",
    "RANK_COLUMNS",
    "REFERENCE_COLUMNS",
    "SHORT_INTEREST_COLUMNS",
    "SHORT_INTEREST_COVERAGE_CATEGORIES",
    "TEXT_CHANGE_COLUMNS",
    "borrow_features",
    "extra_features",
    "factor_matrix",
    "insider_features",
    "market_etf_features",
    "reference_features",
    "risk_free_daily",
    "short_interest_features",
    "text_change_features",
]

_DAY_NS = 86_400_000_000_000
_THREE_DAYS_NS = 3 * _DAY_NS
_USABLE_FUNDAMENTAL_STATUSES = frozenset(
    {"ok", "approximate", "split_unverified", "ok_observed_only"}
)

REFERENCE_COLUMNS: tuple[str, ...] = (
    "ref_rf_3m",
    "ref_term_10y_3m",
    "ref_term_10y_2y",
    "ref_real_10y",
    "ref_breakeven_10y",
    "ref_credit_baa",
    "ref_vix",
    "ref_vix_term",
    "ref_d10y_21d",
    "ref_dvix_21d",
    "ref_usd_ret_21d",
    "ref_oil_ret_21d",
    "ref_age_days",
)

MARKET_ETF_COLUMNS: tuple[str, ...] = (
    "etf_mkt_ret_21d",
    "etf_mkt_ret_63d",
    "etf_size_ret_63d",
    "etf_breadth_ret_63d",
    "etf_value_ret_63d",
)

INSIDER_WINDOWS: tuple[int, ...] = (90, 180)
INSIDER_COVERAGE_CATEGORIES: tuple[str, ...] = (
    "covered",
    "partial",
    "not_covered",
    "issuer_unmapped",
)
INSIDER_COLUMNS: tuple[str, ...] = (
    *(
        col
        for w in INSIDER_WINDOWS
        for col in (
            f"ins_buy_filings_{w}d",
            f"ins_buyers_{w}d",
            f"ins_sellers_{w}d",
            f"ins_buy_value_{w}d",
            f"ins_sell_value_{w}d",
            f"ins_net_ratio_{w}d",
            f"ins_net_value_mcap_{w}d",
            f"ins_officer_buy_{w}d",
        )
    ),
    "ins_coverage",
)

SHORT_INTEREST_COVERAGE_CATEGORIES: tuple[str, ...] = (
    "covered",
    "stale",
    "unlinked",
    "before_archive",
)
SHORT_INTEREST_COLUMNS: tuple[str, ...] = (
    "si_shares",
    "si_days_to_cover",
    "si_pct_shares",
    "si_change",
    "si_age_sessions",
    "si_split_flag",
    "si_coverage",
)

TEXT_CHANGE_COLUMNS: tuple[str, ...] = (
    "txt_sim_full",
    "txt_jac_full",
    "txt_sim_rf",
    "txt_sim_mdna",
    "txt_len_change_full",
    "txt_age_days",
    "txt_form",
    "txt_status",
    "txt_sim_full_10k",
)

BORROW_COLUMNS: tuple[str, ...] = (
    "brw_shortable",
    "brw_easy_to_borrow",
    "brw_observed",
)

RANK_COLUMNS: tuple[str, ...] = (
    "si_pct_shares",
    "si_days_to_cover",
    "ins_net_ratio_180d",
    "txt_sim_full",
)

_CORE_REF_SERIES: tuple[str, ...] = (
    "DTB3",
    "DGS3MO",
    "DGS2",
    "DGS10",
    "DFII10",
    "T10YIE",
    "BAA10Y",
    "VIXCLS",
    "VXVCLS",
    "DTWEXBGS",
    "DCOILWTICO",
)
_ETF_SPREAD_SYMBOLS: tuple[str, ...] = ("SPY", "IWB", "IWM", "RSP", "IWD", "IWF")
_DEFAULT_FIRST_SI_SETTLEMENT = "2017-12-29"
_QUARTER_RE = re.compile(r"^([0-9]{4})q([1-4])$", re.IGNORECASE)
_CIK_RE = re.compile(r"^[0-9]{10}$")


def _validate_candidates(candidates: pd.DataFrame, time_policy: str) -> str:
    policy = clocks.policy(time_policy)
    if not isinstance(candidates, pd.DataFrame):
        raise TypeError("candidates must be a pandas DataFrame")
    required = {"asset_id", "signal_session", "decision_at"}
    missing = required - set(candidates.columns)
    if missing:
        raise ValueError(f"candidates is missing required columns: {sorted(missing)}")
    return policy


def _empty_result(
    candidates: pd.DataFrame, missing_families: Sequence[str]
) -> pd.DataFrame:
    out = pd.DataFrame(index=candidates.index)
    out.attrs["extra_missing"] = list(dict.fromkeys(missing_families))
    return out


def _manifest_of(version: Any) -> Mapping[str, Any]:
    manifest = getattr(version, "manifest", None)
    if isinstance(manifest, Mapping):
        return manifest
    if isinstance(version, Mapping) and isinstance(version.get("manifest"), Mapping):
        return version["manifest"]
    return {}


def _universe_records(version: Any) -> list[Mapping[str, Any]]:
    universe = getattr(version, "universe", None)
    if universe is None and isinstance(version, Mapping):
        universe = version.get("universe")
    if universe is None:
        universe = _manifest_of(version).get("universe", [])
    return list(_candidates.records(universe))


def _read_optional_family(
    version: Any,
    name: str,
    *,
    symbols: Any = None,
    columns: Sequence[str] | None = None,
) -> tuple[pd.DataFrame | None, bool]:
    """Return ``(frame, present)`` without raising when a family or optional column is absent."""
    spec = FAMILY_SPECS.get(name)
    if spec is not None and spec.evaluation_only:
        raise ValueError(f"EVALUATION_ONLY: {name} cannot be joined as a feature")
    if name not in _candidates.families(version):
        return None, False
    if isinstance(version, Mapping) and name in version:
        raw = version[name]
        if raw is None:
            return None, False
        df = raw.copy() if isinstance(raw, pd.DataFrame) else pd.DataFrame(raw)
    else:
        reader = getattr(version, "family", None)
        if not callable(reader):
            return None, False
        df = reader(name, symbols)
    if columns is not None and not df.empty:
        keep = [c for c in columns if c in df.columns]
        df = df[keep].copy()
    return df, True


def _effective_available_ns(df: pd.DataFrame, time_policy: str) -> np.ndarray:
    """Compute effective availability instants in UTC nanoseconds under ``time_policy``."""
    if df.empty or "available_at" not in df.columns:
        return np.full(len(df), NAT, dtype="int64")
    pub_ns = clocks.instants(df["available_at"])
    invalid = pub_ns == NAT
    if time_policy == "public_reconstructed":
        return clocks.available_at(pub_ns, invalid, time_policy)
    cap_col: str | None = None
    for candidate in ("observed_at", "computed_at"):
        if candidate in df.columns:
            cap_col = candidate
            break
    if cap_col is None:
        return np.full(len(df), NAT, dtype="int64")
    cap_ns = clocks.instants(df[cap_col])
    return clocks.available_at(pub_ns, invalid, time_policy, captures=[cap_ns])


def _decision_ny_dates(decision_ns: np.ndarray) -> list[date | None]:
    """Convert UTC nanosecond decision instants to New York calendar dates."""
    out: list[date | None] = [None] * len(decision_ns)
    valid_idx = np.flatnonzero(decision_ns != NAT)
    if len(valid_idx) == 0:
        return out
    ts_index = pd.DatetimeIndex(decision_ns[valid_idx], tz="UTC").tz_convert(NEW_YORK)
    ny_dates = ts_index.date
    for pos, d_val in zip(valid_idx.tolist(), ny_dates):
        out[pos] = d_val
    return out


def _parse_iso_day(value: Any) -> date | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    if isinstance(value, pd.Timestamp):
        return None if pd.isna(value) else value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    if len(text) >= 10:
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            return None
    return None


def _normalize_cik(value: Any) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return ""
    text = str(value).strip()
    if not text:
        return ""
    if text.isdigit():
        padded = text.zfill(10)
        if _CIK_RE.fullmatch(padded) and int(padded) > 0:
            return padded
    return ""


def _resolve_candidate_ciks(version: Any, candidates: pd.DataFrame) -> list[str]:
    """Resolve candidate ``(asset_id, signal_session)`` rows to 10-digit CIKs."""
    n = len(candidates)
    if n == 0:
        return []
    asset_ids = candidates["asset_id"].astype(str).tolist()
    sessions = [
        _parse_iso_day(s) or clocks.day(s) for s in candidates["signal_session"]
    ]
    ciks: list[str] = [""] * n
    series = _fundamentals_derived.cik_at(version, asset_ids, sessions)
    for i, val in enumerate(series.tolist()):
        norm = _normalize_cik(val)
        if norm:
            ciks[i] = norm

    # Fallback to universe CIK when issuer_history is absent and universe omits status
    # (for example synthetic fixtures that provide cik without issuer_mapping_status).
    if "issuer_history" not in _candidates.families(version):
        uni_cik: dict[str, str] = {}
        for row in _universe_records(version):
            aid = str(row.get("asset_id", ""))
            if not aid:
                continue
            status = row.get("issuer_mapping_status")
            if status is not None and str(status) not in {"", "verified"}:
                continue
            norm = _normalize_cik(row.get("cik"))
            if norm:
                uni_cik[aid] = norm
        for i, aid in enumerate(asset_ids):
            if not ciks[i] and aid in uni_cik:
                ciks[i] = uni_cik[aid]
    return ciks


def _extract_fundamental_numeric(
    fundamentals: pd.DataFrame | None,
    candidates: pd.DataFrame,
    value_cols: Sequence[str],
    status_cols: Sequence[str],
) -> np.ndarray:
    """Extract a positive finite float array aligned to ``candidates`` from ``fundamentals``."""
    n = len(candidates)
    out = np.full(n, np.nan, dtype="float64")
    if (
        fundamentals is None
        or not isinstance(fundamentals, pd.DataFrame)
        or fundamentals.empty
    ):
        return out

    work = fundamentals
    if len(work) != n or (
        {"asset_id", "signal_session"}.issubset(work.columns)
        and not work.index.equals(candidates.index)
    ):
        if {"asset_id", "signal_session"}.issubset(work.columns):
            left = pd.DataFrame(
                {
                    "asset_id": candidates["asset_id"].astype(str).to_numpy(),
                    "signal_session": [
                        _parse_iso_day(s) for s in candidates["signal_session"]
                    ],
                }
            )
            right = work.copy()
            right["asset_id"] = right["asset_id"].astype(str)
            right["signal_session"] = [
                _parse_iso_day(s) for s in right["signal_session"]
            ]
            right = right.drop_duplicates(["asset_id", "signal_session"], keep="last")
            work = left.merge(right, on=["asset_id", "signal_session"], how="left")
        elif len(work) != n:
            return out

    chosen_val: str | None = None
    chosen_st: str | None = None
    for v_col, s_col in zip(value_cols, status_cols):
        if v_col in work.columns:
            chosen_val = v_col
            chosen_st = s_col if s_col in work.columns else None
            break
    if chosen_val is None:
        return out

    vals = pd.to_numeric(work[chosen_val], errors="coerce").to_numpy(dtype="float64")
    valid = np.isfinite(vals) & (vals > 0.0)
    if chosen_st is not None:
        statuses = work[chosen_st].astype(object).fillna("").astype(str).to_numpy()
        st_ok = np.isin(statuses, list(_USABLE_FUNDAMENTAL_STATUSES))
        valid &= st_ok
    out[valid] = vals[valid]
    return out


# ---------------------------------------------------------------------------
# 1. Reference series features (FRED rates, credit, vol, USD, oil)
# ---------------------------------------------------------------------------


@dataclass
class _PreparedSeries:
    dates: list[date]
    values: np.ndarray
    avail_ns: np.ndarray
    seqs: np.ndarray
    monotonic_unrevised: bool


def _prepare_reference_series(
    df: pd.DataFrame,
    series_ids: Sequence[str],
    time_policy: str,
) -> dict[str, _PreparedSeries]:
    if df.empty or not {"series_id", "date", "value", "available_at"}.issubset(
        df.columns
    ):
        return {}
    wanted = set(series_ids)
    sub = df[df["series_id"].astype(str).isin(wanted)].copy()
    if sub.empty:
        return {}
    eff_ns = _effective_available_ns(sub, time_policy)
    sub["_eff_ns"] = eff_ns
    sub["_val"] = pd.to_numeric(sub["value"], errors="coerce")
    sub = sub[(sub["_eff_ns"] != NAT) & sub["_val"].notna()].copy()
    if sub.empty:
        return {}
    sub["_day"] = [_parse_iso_day(d) for d in sub["date"]]
    sub = sub[sub["_day"].notna()].copy()
    if sub.empty:
        return {}
    if "observation_sequence" in sub.columns:
        sub["_seq"] = (
            pd.to_numeric(sub["observation_sequence"], errors="coerce")
            .fillna(1)
            .astype("int64")
        )
    else:
        sub["_seq"] = np.ones(len(sub), dtype="int64")

    prepared: dict[str, _PreparedSeries] = {}
    for sid, grp in sub.groupby(sub["series_id"].astype(str), sort=False):
        ordered = grp.sort_values(["_day", "_seq", "_eff_ns"], kind="mergesort")
        days_list: list[date] = ordered["_day"].tolist()
        vals_arr = ordered["_val"].to_numpy(dtype="float64")
        avail_arr = ordered["_eff_ns"].to_numpy(dtype="int64")
        seq_arr = ordered["_seq"].to_numpy(dtype="int64")
        unique_days = len(set(days_list)) == len(days_list)
        mono = bool(unique_days and np.all(avail_arr[1:] >= avail_arr[:-1]))
        prepared[str(sid)] = _PreparedSeries(
            dates=days_list,
            values=vals_arr,
            avail_ns=avail_arr,
            seqs=seq_arr,
            monotonic_unrevised=mono,
        )
    return prepared


def _series_snapshot_at(
    prep: _PreparedSeries | None,
    decision_ns: int,
    decision_date: date | None,
    *,
    max_age_days: int | None,
) -> tuple[float, float, int | None]:
    """Return ``(latest_value, lag21_value, age_days)`` at ``decision_ns``."""
    if prep is None or decision_ns == NAT or decision_date is None:
        return (np.nan, np.nan, None)

    if prep.monotonic_unrevised:
        k = int(np.searchsorted(prep.avail_ns, decision_ns, side="right"))
        if k == 0:
            return (np.nan, np.nan, None)
        latest_date = prep.dates[k - 1]
        age = (decision_date - latest_date).days
        if max_age_days is not None and age > max_age_days:
            return (np.nan, np.nan, age)
        latest_val = float(prep.values[k - 1])
        lag21_val = float(prep.values[k - 22]) if k >= 22 else np.nan
        return (latest_val, lag21_val, age)

    mask = prep.avail_ns <= decision_ns
    if not mask.any():
        return (np.nan, np.nan, None)
    idxs = np.flatnonzero(mask)
    # Deduplicate by observation date keeping the last (highest sequence) usable row.
    dedup_dates: list[date] = []
    dedup_vals: list[float] = []
    for idx in idxs.tolist():
        d_cur = prep.dates[idx]
        v_cur = float(prep.values[idx])
        if dedup_dates and dedup_dates[-1] == d_cur:
            dedup_vals[-1] = v_cur
        else:
            dedup_dates.append(d_cur)
            dedup_vals.append(v_cur)
    latest_date = dedup_dates[-1]
    age = (decision_date - latest_date).days
    if max_age_days is not None and age > max_age_days:
        return (np.nan, np.nan, age)
    latest_val = dedup_vals[-1]
    lag21_val = dedup_vals[-22] if len(dedup_vals) >= 22 else np.nan
    return (latest_val, lag21_val, age)


def reference_features(
    version: Any,
    candidates: pd.DataFrame,
    *,
    time_policy: str,
) -> pd.DataFrame:
    """Point-in-time macro/market reference series features aligned to ``candidates``."""
    policy = _validate_candidates(candidates, time_policy)
    df, present = _read_optional_family(
        version,
        "reference_series",
        columns=[
            "series_id",
            "date",
            "value",
            "observation_sequence",
            "observed_at",
            "available_at",
        ],
    )
    if not present or df is None:
        return _empty_result(candidates, ["reference_series"])

    n = len(candidates)
    prepared = _prepare_reference_series(df, _CORE_REF_SERIES, policy)
    decision_ns = clocks.instants(candidates["decision_at"])
    ny_dates = _decision_ny_dates(decision_ns)

    # Evaluate once per unique decision_ns because reference series are asset-invariant.
    unique_ns = sorted({int(x) for x in decision_ns.tolist() if x != NAT})
    ns_to_date: dict[int, date | None] = {}
    for ns_val, d_val in zip(decision_ns.tolist(), ny_dates):
        if ns_val != NAT and int(ns_val) not in ns_to_date:
            ns_to_date[int(ns_val)] = d_val

    float_cols = REFERENCE_COLUMNS[:-1]
    cache: dict[int, tuple[dict[str, float], int | None]] = {}
    for u_ns in unique_ns:
        d_ny = ns_to_date.get(u_ns)
        snaps: dict[str, tuple[float, float, int | None]] = {
            sid: _series_snapshot_at(prepared.get(sid), u_ns, d_ny, max_age_days=10)
            for sid in _CORE_REF_SERIES
        }
        dtb3 = snaps["DTB3"][0]
        dgs3mo = snaps["DGS3MO"][0]
        dgs2 = snaps["DGS2"][0]
        dgs10, dgs10_lag21, _ = snaps["DGS10"]
        dfii10 = snaps["DFII10"][0]
        t10yie = snaps["T10YIE"][0]
        baa10y = snaps["BAA10Y"][0]
        vix, vix_lag21, _ = snaps["VIXCLS"]
        vxv = snaps["VXVCLS"][0]
        usd, usd_lag21, _ = snaps["DTWEXBGS"]
        oil, oil_lag21, _ = snaps["DCOILWTICO"]

        vix_term = (
            vix / vxv
            if math.isfinite(vix) and math.isfinite(vxv) and vxv > 0.0
            else np.nan
        )
        usd_ret = (
            math.log(usd / usd_lag21)
            if math.isfinite(usd)
            and math.isfinite(usd_lag21)
            and usd > 0.0
            and usd_lag21 > 0.0
            else np.nan
        )
        oil_ret = (
            math.log(oil / oil_lag21)
            if math.isfinite(oil)
            and math.isfinite(oil_lag21)
            and oil > 0.0
            and oil_lag21 > 0.0
            else np.nan
        )

        row_vals = {
            "ref_rf_3m": dtb3 / 100.0 if math.isfinite(dtb3) else np.nan,
            "ref_term_10y_3m": (
                (dgs10 - dgs3mo) / 100.0
                if math.isfinite(dgs10) and math.isfinite(dgs3mo)
                else np.nan
            ),
            "ref_term_10y_2y": (
                (dgs10 - dgs2) / 100.0
                if math.isfinite(dgs10) and math.isfinite(dgs2)
                else np.nan
            ),
            "ref_real_10y": dfii10 / 100.0 if math.isfinite(dfii10) else np.nan,
            "ref_breakeven_10y": t10yie / 100.0 if math.isfinite(t10yie) else np.nan,
            "ref_credit_baa": baa10y / 100.0 if math.isfinite(baa10y) else np.nan,
            "ref_vix": vix if math.isfinite(vix) else np.nan,
            "ref_vix_term": vix_term,
            "ref_d10y_21d": (
                (dgs10 - dgs10_lag21) / 100.0
                if math.isfinite(dgs10) and math.isfinite(dgs10_lag21)
                else np.nan
            ),
            "ref_dvix_21d": (
                vix - vix_lag21
                if math.isfinite(vix) and math.isfinite(vix_lag21)
                else np.nan
            ),
            "ref_usd_ret_21d": usd_ret,
            "ref_oil_ret_21d": oil_ret,
        }
        ages = [
            snap[2] for snap in snaps.values() if snap[2] is not None and snap[2] >= 0
        ]
        fresh_ages = [a for a in ages if a <= 10]
        age_out = max(fresh_ages) if fresh_ages else (min(ages) if ages else None)
        cache[u_ns] = (row_vals, age_out)

    arrays = {col: np.full(n, np.nan, dtype="float64") for col in float_cols}
    age_list: list[int | None] = [None] * n
    for i, ns_val in enumerate(decision_ns.tolist()):
        if ns_val == NAT:
            continue
        cached = cache.get(int(ns_val))
        if cached is None:
            continue
        vals_map, age_val = cached
        for col, v in vals_map.items():
            arrays[col][i] = v
        age_list[i] = age_val

    out = pd.DataFrame(arrays, index=candidates.index)
    out["ref_age_days"] = pd.array(age_list, dtype="Int16")
    out.attrs["extra_missing"] = []
    return out


# ---------------------------------------------------------------------------
# 2. Market ETF return and style-spread features
# ---------------------------------------------------------------------------


def _resolve_reference_etf_ids(version: Any) -> tuple[dict[str, str], bool]:
    """Map needed ETF symbols to ``asset_id`` and report whether ETF reference scope exists."""
    manifest = _manifest_of(version)
    has_ref_block = isinstance(manifest.get("reference"), Mapping) and bool(
        manifest["reference"].get("reference_etfs")
    )
    records = _universe_records(version)
    non_spy_ref = set(REFERENCE_ETFS) - {"SPY"}
    has_non_spy_etf = False

    by_symbol: dict[str, list[Mapping[str, Any]]] = {}
    for row in records:
        sym = str(row.get("symbol", "")).strip().upper()
        if not sym or not row.get("asset_id"):
            continue
        if sym in non_spy_ref:
            has_non_spy_etf = True
        if sym in _ETF_SPREAD_SYMBOLS:
            by_symbol.setdefault(sym, []).append(row)

    if not has_ref_block and not has_non_spy_etf:
        return {}, False

    resolved: dict[str, str] = {}
    for sym, matches in by_symbol.items():
        active = [
            m for m in matches if str(m.get("status", "active")).lower() == "active"
        ]
        chosen = active[0] if len(active) == 1 else matches[0]
        resolved[sym] = str(chosen["asset_id"])
    return resolved, True


def market_etf_features(
    version: Any,
    candidates: pd.DataFrame,
    *,
    time_policy: str,
) -> pd.DataFrame:
    """Market, size, equal-weight breadth, and value/growth ETF spreads through signal session T."""
    _validate_candidates(candidates, time_policy)
    etf_ids_by_sym, scope_present = _resolve_reference_etf_ids(version)
    if not scope_present:
        return _empty_result(candidates, ["reference_etfs"])

    n = len(candidates)
    cal_raw = getattr(version, "calendar", None)
    if cal_raw is None and isinstance(version, Mapping):
        cal_raw = version.get("calendar", [])
    calendar_days = [clocks.day(d) for d in (cal_raw or [])]
    etf_ids = list(dict.fromkeys(etf_ids_by_sym.values()))

    if not calendar_days or not etf_ids:
        out = pd.DataFrame(
            {col: np.full(n, np.nan, dtype="float64") for col in MARKET_ETF_COLUMNS},
            index=candidates.index,
        )
        out.attrs["extra_missing"] = []
        return out

    # Build session x asset_id price/total-return index levels on calendar_days.
    levels = pd.DataFrame(np.nan, index=calendar_days, columns=etf_ids, dtype="float64")
    dr_df, has_dr = _read_optional_family(
        version,
        "daily_returns",
        symbols=etf_ids,
        columns=["asset_id", "date", "tr_index"],
    )
    if has_dr and dr_df is not None and not dr_df.empty and "tr_index" in dr_df.columns:
        work_dr = dr_df.copy()
        work_dr["asset_id"] = work_dr["asset_id"].astype(str)
        work_dr["date"] = [_parse_iso_day(d) for d in work_dr["date"]]
        work_dr["tr_index"] = pd.to_numeric(work_dr["tr_index"], errors="coerce")
        work_dr = work_dr[
            work_dr["date"].notna()
            & work_dr["asset_id"].isin(etf_ids)
            & np.isfinite(work_dr["tr_index"])
            & (work_dr["tr_index"] > 0.0)
        ].drop_duplicates(["date", "asset_id"], keep="last")
        if not work_dr.empty:
            piv = work_dr.pivot(index="date", columns="asset_id", values="tr_index")
            piv = piv.reindex(index=calendar_days, columns=etf_ids)
            levels = piv.astype("float64")

    missing_etf_ids = [
        aid for aid in etf_ids if aid not in levels.columns or levels[aid].isna().all()
    ]
    if missing_etf_ids and hasattr(version, "prices"):
        adj_df = version.prices(missing_etf_ids, adjusted=True)
        if adj_df is not None and not adj_df.empty and "close" in adj_df.columns:
            work_p = adj_df.copy()
            if "adjustment" in work_p.columns:
                work_p = work_p[work_p["adjustment"].astype(str) == "all"]
            work_p["asset_id"] = work_p["asset_id"].astype(str)
            work_p["date"] = [_parse_iso_day(d) for d in work_p["date"]]
            work_p["close"] = pd.to_numeric(work_p["close"], errors="coerce")
            work_p = work_p[
                work_p["date"].notna()
                & work_p["asset_id"].isin(missing_etf_ids)
                & np.isfinite(work_p["close"])
                & (work_p["close"] > 0.0)
            ].drop_duplicates(["date", "asset_id"], keep="last")
            if not work_p.empty:
                piv_p = work_p.pivot(index="date", columns="asset_id", values="close")
                for aid in missing_etf_ids:
                    if aid in piv_p.columns:
                        levels[aid] = (
                            piv_p[aid].reindex(calendar_days).astype("float64")
                        )

    ret21 = levels / levels.shift(21) - 1.0
    ret63 = levels / levels.shift(63) - 1.0

    def _sym_series(ret_df: pd.DataFrame, sym: str) -> pd.Series:
        aid = etf_ids_by_sym.get(sym)
        if aid is None or aid not in ret_df.columns:
            return pd.Series(np.nan, index=calendar_days, dtype="float64")
        return ret_df[aid]

    spy_21 = _sym_series(ret21, "SPY")
    spy_63 = _sym_series(ret63, "SPY")
    iwm_63 = _sym_series(ret63, "IWM")
    iwb_63 = _sym_series(ret63, "IWB")
    rsp_63 = _sym_series(ret63, "RSP")
    iwd_63 = _sym_series(ret63, "IWD")
    iwf_63 = _sym_series(ret63, "IWF")

    session_table = pd.DataFrame(
        {
            "etf_mkt_ret_21d": spy_21,
            "etf_mkt_ret_63d": spy_63,
            "etf_size_ret_63d": iwm_63 - iwb_63,
            "etf_breadth_ret_63d": rsp_63 - spy_63,
            "etf_value_ret_63d": iwd_63 - iwf_63,
        },
        index=calendar_days,
    )

    sig_days = [_parse_iso_day(s) for s in candidates["signal_session"]]
    aligned = session_table.reindex(sig_days)
    aligned.index = candidates.index
    for col in MARKET_ETF_COLUMNS:
        aligned[col] = aligned[col].astype("float64")
    aligned.attrs["extra_missing"] = []
    return aligned


# ---------------------------------------------------------------------------
# 3. Form 4 open-market insider features
# ---------------------------------------------------------------------------


def _quarter_bounds(unit_key: str) -> tuple[date, date] | None:
    match = _QUARTER_RE.fullmatch(unit_key.strip())
    if not match:
        return None
    year = int(match.group(1))
    q = int(match.group(2))
    start_month = (q - 1) * 3 + 1
    end_month = q * 3
    end_day = 31 if end_month in (3, 12) else 30
    return date(year, start_month, 1), date(year, end_month, end_day)


def _extract_ciks_cell(value: Any) -> tuple[str, ...]:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return ()
    if isinstance(value, str):
        norm = _normalize_cik(value)
        return (norm,) if norm else (value.strip(),) if value.strip() else ()
    if isinstance(value, (list, tuple, set, np.ndarray, pd.Series)):
        items: list[str] = []
        for item in value:
            if item is None:
                continue
            s = str(item).strip()
            if not s:
                continue
            norm = _normalize_cik(s)
            items.append(norm or s)
        return tuple(dict.fromkeys(items))
    return ()


@dataclass
class _InsiderChecksIndex:
    # (checked_ns, start_ord, end_ord) for dataset quarters covering all CIKs
    dataset_spans: list[tuple[int, int, int]]
    # (checked_ns, day_ord) for EDGAR-closed empty days covering all CIKs
    global_days: list[tuple[int, int]]
    # cik -> list of (checked_ns, start_ord, end_ord)
    cik_daily_spans: dict[str, list[tuple[int, int, int]]]


def _prepare_insider_checks(
    checks_df: pd.DataFrame | None, time_policy: str
) -> _InsiderChecksIndex:
    idx = _InsiderChecksIndex(dataset_spans=[], global_days=[], cik_daily_spans={})
    if checks_df is None or checks_df.empty or "source" not in checks_df.columns:
        return idx

    work = checks_df[
        checks_df["source"]
        .astype(str)
        .isin({"sec_insider_dataset", "sec_insider_daily"})
    ].copy()
    if work.empty:
        return idx

    if time_policy == "observed_content":
        if "checked_at" not in work.columns:
            return idx
        chk_ns = clocks.instants(work["checked_at"])
        # Same grace convention as source_checks under observed_content: checked_at - 3h <= decision_at.
        work["_chk_ns"] = np.where(chk_ns == NAT, NAT, chk_ns - clocks.GRACE_NS)
        work = work[work["_chk_ns"] != NAT].copy()
    else:
        work["_chk_ns"] = np.zeros(len(work), dtype="int64")

    for rec in work.to_dict("records"):
        src = str(rec.get("source", ""))
        status = str(rec.get("status", "")).lower()
        unit_key = str(rec.get("unit_key", "")).strip()
        c_ns = int(rec["_chk_ns"])
        p_start = _parse_iso_day(rec.get("period_start"))
        p_end = _parse_iso_day(rec.get("period_end"))

        if src == "sec_insider_dataset":
            if status != "checked":
                continue
            if p_start is None or p_end is None:
                qb = _quarter_bounds(unit_key)
                if qb is None:
                    continue
                p_start, p_end = qb
            idx.dataset_spans.append((c_ns, p_start.toordinal(), p_end.toordinal()))
        elif src == "sec_insider_daily":
            if status not in {"checked", "empty"}:
                continue
            if p_start is None:
                p_start = _parse_iso_day(unit_key)
            if p_end is None:
                p_end = p_start
            if p_start is None or p_end is None:
                continue
            s_ord, e_ord = p_start.toordinal(), p_end.toordinal()
            err_code = str(rec.get("error_code") or "").strip()
            scope_ciks = _extract_ciks_cell(rec.get("scope_ciks"))
            if (
                status == "empty"
                and err_code == "SEC_NO_DAILY_INDEX"
                and not scope_ciks
            ):
                for d_ord in range(s_ord, e_ord + 1):
                    idx.global_days.append((c_ns, d_ord))
            else:
                for cik in scope_ciks:
                    if cik:
                        idx.cik_daily_spans.setdefault(cik, []).append(
                            (c_ns, s_ord, e_ord)
                        )
    return idx


def _insider_coverage_for_sample(
    checks: _InsiderChecksIndex,
    cik: str,
    decision_ns: int,
    decision_date: date | None,
) -> str:
    if not cik:
        return "issuer_unmapped"
    if decision_ns == NAT or decision_date is None:
        return "not_covered"

    # Filings in [decision_date - 180d, decision_date - 1d] correspond to [decision_at - 180d, decision_at).
    start_ord = (decision_date - timedelta(days=180)).toordinal()
    end_ord = (decision_date - timedelta(days=1)).toordinal()
    weekdays = [
        d_ord
        for d_ord in range(start_ord, end_ord + 1)
        if date.fromordinal(d_ord).weekday() < 5
    ]
    if not weekdays:
        return "not_covered"

    covered: set[int] = set()
    for c_ns, s_ord, e_ord in checks.dataset_spans:
        if c_ns <= decision_ns and e_ord >= start_ord and s_ord <= end_ord:
            lo = max(s_ord, start_ord)
            hi = min(e_ord, end_ord)
            covered.update(range(lo, hi + 1))

    for c_ns, d_ord in checks.global_days:
        if c_ns <= decision_ns and start_ord <= d_ord <= end_ord:
            covered.add(d_ord)

    for c_ns, s_ord, e_ord in checks.cik_daily_spans.get(cik, ()):
        if c_ns <= decision_ns and e_ord >= start_ord and s_ord <= end_ord:
            lo = max(s_ord, start_ord)
            hi = min(e_ord, end_ord)
            covered.update(range(lo, hi + 1))

    covered_weekdays = sum(1 for d_ord in weekdays if d_ord in covered)
    if covered_weekdays == 0:
        return "not_covered"
    if covered_weekdays / len(weekdays) >= 0.95:
        return "covered"
    return "partial"


@dataclass
class _InsiderTx:
    avail_ns: int
    accession: str
    is_buy: bool
    is_sell: bool
    value: float  # NaN when price is NULL or non-positive
    owners: tuple[str, ...]
    any_officer: bool


def insider_features(
    version: Any,
    candidates: pd.DataFrame,
    *,
    time_policy: str,
    fundamentals: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Point-in-time Form 4 open-market purchase/sale features over 90d and 180d windows."""
    policy = _validate_candidates(candidates, time_policy)
    if "insider_transactions" not in _candidates.families(version):
        return _empty_result(candidates, ["insider_transactions"])

    n = len(candidates)
    sample_ciks = _resolve_candidate_ciks(version, candidates)
    mapped_assets = list(
        dict.fromkeys(
            aid
            for aid, cik in zip(candidates["asset_id"].astype(str), sample_ciks)
            if cik
        )
    )
    if mapped_assets:
        tx_df, present = _read_optional_family(
            version,
            "insider_transactions",
            symbols=mapped_assets,
        )
        if not present or tx_df is None:
            return _empty_result(candidates, ["insider_transactions"])
    else:
        tx_df = pd.DataFrame()

    checks_df, checks_present = _read_optional_family(version, "reference_checks")
    missing_notes = [] if checks_present else ["reference_checks"]

    decision_ns = clocks.instants(candidates["decision_at"])
    ny_dates = _decision_ny_dates(decision_ns)
    mcap = _extract_fundamental_numeric(
        fundamentals,
        candidates,
        ("market_cap_issuer_value",),
        ("market_cap_issuer_status",),
    )

    checks_idx = _prepare_insider_checks(checks_df, policy)

    # Index Form 4 P/A and S/D transactions by 10-digit issuer CIK.
    tx_by_cik: dict[str, tuple[np.ndarray, list[_InsiderTx]]] = {}
    if not tx_df.empty and "available_at" in tx_df.columns:
        cik_col = (
            "issuer_cik"
            if "issuer_cik" in tx_df.columns
            else ("cik" if "cik" in tx_df.columns else None)
        )
        if cik_col is not None and "document_type" in tx_df.columns:
            work = tx_df.copy()
            # Strictly Form 4 only (exclude 4/A, 5, 5/A, 3).
            work = work[work["document_type"].astype(str).str.strip() == "4"].copy()
            if not work.empty:
                eff_ns = _effective_available_ns(work, policy)
                work["_eff_ns"] = eff_ns
                work = work[work["_eff_ns"] != NAT].copy()
            if not work.empty:
                work["_cik"] = [_normalize_cik(v) for v in work[cik_col]]
                work = work[work["_cik"] != ""].copy()
            if not work.empty:
                work = work.sort_values("_eff_ns", kind="mergesort")
                buckets: dict[str, list[_InsiderTx]] = {}
                for rec in work.to_dict("records"):
                    t_code = str(rec.get("trans_code") or "").strip().upper()
                    acq_disp = str(rec.get("acq_disp") or "").strip().upper()
                    is_buy = t_code == "P" and acq_disp == "A"
                    is_sell = t_code == "S" and acq_disp == "D"
                    if not (is_buy or is_sell):
                        continue
                    sh_raw = rec.get("shares")
                    pr_raw = rec.get("price")
                    try:
                        sh_f = float(sh_raw) if sh_raw is not None else np.nan
                    except (TypeError, ValueError):
                        sh_f = np.nan
                    try:
                        pr_f = float(pr_raw) if pr_raw is not None else np.nan
                    except (TypeError, ValueError):
                        pr_f = np.nan
                    tx_val = (
                        sh_f * pr_f
                        if math.isfinite(sh_f)
                        and sh_f > 0.0
                        and math.isfinite(pr_f)
                        and pr_f > 0.0
                        else np.nan
                    )
                    owners = _extract_ciks_cell(
                        rec.get("owner_ciks")
                        if "owner_ciks" in rec
                        else rec.get("owner_cik")
                    )
                    off_raw = rec.get("any_officer")
                    any_off = (
                        bool(off_raw)
                        if isinstance(off_raw, (bool, np.bool_))
                        else False
                    )
                    buckets.setdefault(str(rec["_cik"]), []).append(
                        _InsiderTx(
                            avail_ns=int(rec["_eff_ns"]),
                            accession=str(rec.get("accession") or ""),
                            is_buy=is_buy,
                            is_sell=is_sell,
                            value=tx_val,
                            owners=owners,
                            any_officer=any_off,
                        )
                    )
                for cik_k, tx_list in buckets.items():
                    arr_ns = np.array([t.avail_ns for t in tx_list], dtype="int64")
                    tx_by_cik[cik_k] = (arr_ns, tx_list)

    float_data: dict[str, np.ndarray] = {}
    bool_data: dict[str, list[bool | None]] = {}
    for w in INSIDER_WINDOWS:
        for stem in (
            "ins_buy_filings",
            "ins_buyers",
            "ins_sellers",
            "ins_buy_value",
            "ins_sell_value",
            "ins_net_ratio",
            "ins_net_value_mcap",
        ):
            float_data[f"{stem}_{w}d"] = np.full(n, np.nan, dtype="float64")
        bool_data[f"ins_officer_buy_{w}d"] = [None] * n

    cov_labels: list[str] = []
    cov_cache: dict[tuple[str, int], str] = {}

    for i in range(n):
        cik = sample_ciks[i]
        d_ns = int(decision_ns[i])
        d_ny = ny_dates[i]
        if not cik:
            cov_labels.append("issuer_unmapped")
            continue
        if d_ns == NAT or d_ny is None:
            cov_labels.append("not_covered")
            continue
        cache_key = (cik, d_ns)
        cov = cov_cache.get(cache_key)
        if cov is None:
            cov = _insider_coverage_for_sample(checks_idx, cik, d_ns, d_ny)
            cov_cache[cache_key] = cov
        cov_labels.append(cov)
        if cov != "covered":
            continue

        entry = tx_by_cik.get(cik)
        mcap_i = mcap[i]
        for w in INSIDER_WINDOWS:
            lo_ns = d_ns - w * _DAY_NS
            if entry is None:
                buy_filings = 0.0
                buyers_cnt = 0.0
                sellers_cnt = 0.0
                buy_val = 0.0
                sell_val = 0.0
                officer_buy = False
            else:
                arr_ns, tx_list = entry
                lo_idx = int(np.searchsorted(arr_ns, lo_ns, side="left"))
                # Window [decision_at - w days, decision_at]: midnight ET clocks lie strictly
                # before 06:00 ET decision_at, and observed_content grace clocks are inclusive at decision_at.
                hi_idx = int(np.searchsorted(arr_ns, d_ns, side="right"))
                buy_acc: set[str] = set()
                buyers: set[str] = set()
                sellers: set[str] = set()
                buy_val = 0.0
                sell_val = 0.0
                officer_buy = False
                for tx in tx_list[lo_idx:hi_idx]:
                    if tx.is_buy:
                        if tx.accession:
                            buy_acc.add(tx.accession)
                        buyers.update(tx.owners)
                        if math.isfinite(tx.value):
                            buy_val += tx.value
                        if tx.any_officer:
                            officer_buy = True
                    elif tx.is_sell:
                        sellers.update(tx.owners)
                        if math.isfinite(tx.value):
                            sell_val += tx.value
                buy_filings = float(len(buy_acc))
                buyers_cnt = float(len(buyers))
                sellers_cnt = float(len(sellers))

            total_val = buy_val + sell_val
            net_val = buy_val - sell_val
            net_ratio = net_val / total_val if total_val > 0.0 else np.nan
            net_mcap = (
                net_val / mcap_i if math.isfinite(mcap_i) and mcap_i > 0.0 else np.nan
            )
            float_data[f"ins_buy_filings_{w}d"][i] = buy_filings
            float_data[f"ins_buyers_{w}d"][i] = buyers_cnt
            float_data[f"ins_sellers_{w}d"][i] = sellers_cnt
            float_data[f"ins_buy_value_{w}d"][i] = buy_val
            float_data[f"ins_sell_value_{w}d"][i] = sell_val
            float_data[f"ins_net_ratio_{w}d"][i] = net_ratio
            float_data[f"ins_net_value_mcap_{w}d"][i] = net_mcap
            bool_data[f"ins_officer_buy_{w}d"][i] = officer_buy

    cols_out: dict[str, Any] = {}
    for w in INSIDER_WINDOWS:
        for stem in (
            "ins_buy_filings",
            "ins_buyers",
            "ins_sellers",
            "ins_buy_value",
            "ins_sell_value",
            "ins_net_ratio",
            "ins_net_value_mcap",
        ):
            cols_out[f"{stem}_{w}d"] = float_data[f"{stem}_{w}d"]
        cols_out[f"ins_officer_buy_{w}d"] = pd.array(
            bool_data[f"ins_officer_buy_{w}d"], dtype="boolean"
        )
    cols_out["ins_coverage"] = pd.Categorical(
        cov_labels, categories=list(INSIDER_COVERAGE_CATEGORIES)
    )
    out = pd.DataFrame(cols_out, index=candidates.index)
    out.attrs["extra_missing"] = missing_notes
    return out


# ---------------------------------------------------------------------------
# 4. Exchange short-interest features
# ---------------------------------------------------------------------------


def _extended_session_ordinals(
    calendar_days: Sequence[date], min_day: date, max_day: date
) -> np.ndarray:
    """Build sorted session date ordinals covering ``[min_day, max_day]``."""
    base = sorted({clocks.day(d) for d in calendar_days})
    if not base:
        years = range(min_day.year, max_day.year + 1)
        holidays = set().union(*(clocks.nyse_holidays(y) for y in years))
        cur = min_day
        days: list[int] = []
        while cur <= max_day:
            if cur.weekday() < 5 and cur not in holidays:
                days.append(cur.toordinal())
            cur += timedelta(days=1)
        return np.array(days, dtype="int64")

    first_cal, last_cal = base[0], base[-1]
    pre: list[int] = []
    if min_day < first_cal:
        years = range(min_day.year, first_cal.year + 1)
        holidays = set().union(*(clocks.nyse_holidays(y) for y in years))
        cur = min_day
        while cur < first_cal:
            if cur.weekday() < 5 and cur not in holidays:
                pre.append(cur.toordinal())
            cur += timedelta(days=1)

    post: list[int] = []
    if max_day > last_cal:
        years = range(last_cal.year, max_day.year + 1)
        holidays = set().union(*(clocks.nyse_holidays(y) for y in years))
        cur = last_cal + timedelta(days=1)
        while cur <= max_day:
            if cur.weekday() < 5 and cur not in holidays:
                post.append(cur.toordinal())
            cur += timedelta(days=1)

    mid = [d.toordinal() for d in base]
    return np.array([*pre, *mid, *post], dtype="int64")


def _first_short_interest_available_ns(version: Any, si_df: pd.DataFrame) -> int:
    """Compute UTC nanosecond ``available_at`` of the first archive settlement file."""
    manifest = _manifest_of(version)
    ref_si = (
        manifest.get("reference", {}).get("short_interest", {})
        if isinstance(manifest.get("reference"), Mapping)
        else {}
    )
    first_settlement_str = (
        str(ref_si.get("first_settlement") or _DEFAULT_FIRST_SI_SETTLEMENT).strip()
        if isinstance(ref_si, Mapping)
        else _DEFAULT_FIRST_SI_SETTLEMENT
    )
    first_settlement = _parse_iso_day(first_settlement_str) or date(2017, 12, 29)

    if (
        not si_df.empty
        and "settlement_date" in si_df.columns
        and "available_at" in si_df.columns
    ):
        matches = si_df[
            si_df["settlement_date"].astype(str).str.slice(0, 10)
            == first_settlement.isoformat()
        ]
        if not matches.empty:
            ns_vals = clocks.instants(matches["available_at"])
            valid = ns_vals[ns_vals != NAT]
            if len(valid) > 0:
                return int(valid.min())

    # Rule: midnight America/New_York after the 8th NYSE session following settlement.
    cal_raw = getattr(version, "calendar", None) or []
    ords = _extended_session_ordinals(
        cal_raw, first_settlement, first_settlement + timedelta(days=30)
    )
    c0 = int(np.searchsorted(ords, first_settlement.toordinal(), side="left"))
    c8_ord = int(ords[min(c0 + 8, len(ords) - 1)])
    day_after_c8 = date.fromordinal(c8_ord + 1)
    midnight_ny = pd.Timestamp(day_after_c8).tz_localize(NEW_YORK)
    return int(midnight_ny.tz_convert("UTC").value)


def _is_split_flagged(value: Any) -> bool:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return False
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    text = str(value).strip().upper()
    return text not in {"", "0", "N", "NO", "FALSE", "NONE", "NAN", "<NA>"}


@dataclass
class _ShortInterestRow:
    settlement_ord: int
    seq: int
    avail_ns: int
    current_short: float
    previous_short: float
    days_to_cover: float
    split_flag: bool


def short_interest_features(
    version: Any,
    candidates: pd.DataFrame,
    *,
    time_policy: str,
    fundamentals: pd.DataFrame | None = None,
    allow_unverified_links: bool = False,
) -> pd.DataFrame:
    """Point-in-time FINRA bi-monthly exchange short-interest features."""
    policy = _validate_candidates(candidates, time_policy)
    selected_assets = list(dict.fromkeys(candidates["asset_id"].astype(str)))
    si_df, present = _read_optional_family(
        version,
        "short_interest",
        symbols=selected_assets if selected_assets else None,
    )
    if not present or si_df is None:
        return _empty_result(candidates, ["short_interest"])

    n = len(candidates)
    decision_ns = clocks.instants(candidates["decision_at"])
    sig_days = [
        _parse_iso_day(s) or clocks.day(s) for s in candidates["signal_session"]
    ]
    shares_out = _extract_fundamental_numeric(
        fundamentals,
        candidates,
        (
            "shares_outstanding_value",
            "shares_outstanding_i_value",
            "instant_shares_outstanding_value",
        ),
        (
            "shares_outstanding_status",
            "shares_outstanding_i_status",
            "instant_shares_outstanding_status",
        ),
    )

    archive_start_ns = _first_short_interest_available_ns(version, si_df)

    # Prepare session ordinal axis for session-age counting.
    cal_raw = getattr(version, "calendar", None)
    if cal_raw is None and isinstance(version, Mapping):
        cal_raw = version.get("calendar", [])
    min_day = min(sig_days) if sig_days else date(2017, 12, 29)
    max_day = max(sig_days) if sig_days else date(2026, 12, 31)

    by_asset: dict[str, list[_ShortInterestRow]] = {}
    if not si_df.empty and {"asset_id", "settlement_date", "available_at"}.issubset(
        si_df.columns
    ):
        work = si_df.copy()
        if "link_basis" in work.columns and not allow_unverified_links:
            work = work[work["link_basis"].astype(str) == "symbol_interval"].copy()
        if not work.empty:
            eff_ns = _effective_available_ns(work, policy)
            work["_eff_ns"] = eff_ns
            work = work[work["_eff_ns"] != NAT].copy()
        if not work.empty:
            work["_s_day"] = [_parse_iso_day(d) for d in work["settlement_date"]]
            work = work[work["_s_day"].notna()].copy()
        if not work.empty:
            s_min = min(work["_s_day"].tolist())
            min_day = min(min_day, s_min)
            if "observation_sequence" in work.columns:
                work["_seq"] = (
                    pd.to_numeric(work["observation_sequence"], errors="coerce")
                    .fillna(1)
                    .astype("int64")
                )
            else:
                work["_seq"] = np.ones(len(work), dtype="int64")
            work = work.sort_values(
                ["asset_id", "_s_day", "_seq", "_eff_ns"], kind="mergesort"
            )
            for rec in work.to_dict("records"):
                aid = str(rec["asset_id"])
                s_day: date = rec["_s_day"]
                cur_s = pd.to_numeric(rec.get("current_short"), errors="coerce")
                prev_s = pd.to_numeric(rec.get("previous_short"), errors="coerce")
                dtc = pd.to_numeric(rec.get("days_to_cover"), errors="coerce")
                adv = pd.to_numeric(rec.get("avg_daily_volume"), errors="coerce")
                cur_f = (
                    float(cur_s)
                    if pd.notna(cur_s) and math.isfinite(float(cur_s))
                    else np.nan
                )
                prev_f = (
                    float(prev_s)
                    if pd.notna(prev_s) and math.isfinite(float(prev_s))
                    else np.nan
                )
                if pd.notna(dtc) and math.isfinite(float(dtc)):
                    dtc_f = float(dtc)
                elif (
                    math.isfinite(cur_f)
                    and pd.notna(adv)
                    and math.isfinite(float(adv))
                    and float(adv) > 0.0
                ):
                    dtc_f = cur_f / float(adv)
                else:
                    dtc_f = np.nan
                by_asset.setdefault(aid, []).append(
                    _ShortInterestRow(
                        settlement_ord=s_day.toordinal(),
                        seq=int(rec["_seq"]),
                        avail_ns=int(rec["_eff_ns"]),
                        current_short=cur_f,
                        previous_short=prev_f,
                        days_to_cover=dtc_f,
                        split_flag=_is_split_flagged(rec.get("split_flag")),
                    )
                )

    session_ords = _extended_session_ordinals(cal_raw or [], min_day, max_day)

    si_shares = np.full(n, np.nan, dtype="float64")
    si_dtc = np.full(n, np.nan, dtype="float64")
    si_pct = np.full(n, np.nan, dtype="float64")
    si_chg = np.full(n, np.nan, dtype="float64")
    si_age: list[int | None] = [None] * n
    si_split: list[bool | None] = [None] * n
    si_cov: list[str] = []

    asset_ids = candidates["asset_id"].astype(str).tolist()
    for i in range(n):
        d_ns = int(decision_ns[i])
        if d_ns == NAT:
            si_cov.append("unlinked")
            continue
        if d_ns < archive_start_ns:
            si_cov.append("before_archive")
            continue

        rows_a = by_asset.get(asset_ids[i])
        if not rows_a:
            si_cov.append("unlinked")
            continue

        best: _ShortInterestRow | None = None
        for r in rows_a:
            if r.avail_ns <= d_ns and (
                best is None
                or (r.settlement_ord, r.seq) >= (best.settlement_ord, best.seq)
            ):
                best = r
        if best is None:
            si_cov.append("unlinked")
            continue

        s_pos = int(np.searchsorted(session_ords, best.settlement_ord, side="left"))
        sig_pos = (
            int(np.searchsorted(session_ords, sig_days[i].toordinal(), side="right"))
            - 1
        )
        age_sess = max(0, sig_pos - s_pos)
        si_age[i] = age_sess

        if age_sess > 25:
            si_cov.append("stale")
            continue

        si_cov.append("covered")
        si_shares[i] = best.current_short
        si_dtc[i] = best.days_to_cover
        si_split[i] = best.split_flag
        sh_o = shares_out[i]
        if math.isfinite(best.current_short) and math.isfinite(sh_o) and sh_o > 0.0:
            si_pct[i] = best.current_short / sh_o
        if (
            not best.split_flag
            and math.isfinite(best.current_short)
            and math.isfinite(best.previous_short)
            and best.previous_short > 0.0
        ):
            si_chg[i] = best.current_short / best.previous_short - 1.0

    out = pd.DataFrame(
        {
            "si_shares": si_shares,
            "si_days_to_cover": si_dtc,
            "si_pct_shares": si_pct,
            "si_change": si_chg,
            "si_age_sessions": pd.array(si_age, dtype="Int16"),
            "si_split_flag": pd.array(si_split, dtype="boolean"),
            "si_coverage": pd.Categorical(
                si_cov, categories=list(SHORT_INTEREST_COVERAGE_CATEGORIES)
            ),
        },
        index=candidates.index,
    )
    out.attrs["extra_missing"] = []
    return out


# ---------------------------------------------------------------------------
# 5. Year-over-year 10-K / 10-Q filing text-change features
# ---------------------------------------------------------------------------


@dataclass
class _FilingTextSummary:
    filing_date: date
    avail_ns: int
    accession: str
    form: str
    full_status: str
    sim_full: float
    jac_full: float
    sim_rf: float
    sim_mdna: float
    len_change_full: float


def text_change_features(
    version: Any,
    candidates: pd.DataFrame,
    *,
    time_policy: str,
) -> pd.DataFrame:
    """Point-in-time year-over-year 10-K/10-Q filing similarity and length-change features."""
    policy = _validate_candidates(candidates, time_policy)
    if "text_changes" not in _candidates.families(version):
        return _empty_result(candidates, ["text_changes"])

    n = len(candidates)
    sample_ciks = _resolve_candidate_ciks(version, candidates)
    mapped_assets = list(
        dict.fromkeys(
            aid
            for aid, cik in zip(candidates["asset_id"].astype(str), sample_ciks)
            if cik
        )
    )
    if mapped_assets:
        txt_df, present = _read_optional_family(
            version,
            "text_changes",
            symbols=mapped_assets,
        )
        if not present or txt_df is None:
            return _empty_result(candidates, ["text_changes"])
    else:
        txt_df = pd.DataFrame()

    decision_ns = clocks.instants(candidates["decision_at"])
    ny_dates = _decision_ny_dates(decision_ns)

    by_cik: dict[str, list[_FilingTextSummary]] = {}
    observed_forms: list[str] = ["10-K", "10-Q"]
    observed_statuses: list[str] = [
        "ok",
        "section_missing",
        "section_short",
        "doc_too_large",
        "doc_unavailable",
        "no_prior",
        "prior_unavailable",
        "prior_section_missing",
    ]

    if not txt_df.empty and {
        "cik",
        "accession",
        "form",
        "filing_date",
        "section",
        "status",
        "available_at",
    }.issubset(txt_df.columns):
        work = txt_df.copy()
        eff_ns = _effective_available_ns(work, policy)
        work["_eff_ns"] = eff_ns
        work = work[work["_eff_ns"] != NAT].copy()
        if not work.empty:
            work["_cik"] = [_normalize_cik(v) for v in work["cik"]]
            work["_f_day"] = [_parse_iso_day(d) for d in work["filing_date"]]
            work = work[(work["_cik"] != "") & work["_f_day"].notna()].copy()
        if not work.empty:
            grouped_filings: dict[tuple[str, str], dict[str, Any]] = {}
            for rec in work.to_dict("records"):
                cik = str(rec["_cik"])
                acc = str(rec["accession"])
                form_s = str(rec["form"]).strip()
                if form_s and form_s not in observed_forms:
                    observed_forms.append(form_s)
                st_s = str(rec["status"]).strip()
                if st_s and st_s not in observed_statuses:
                    observed_statuses.append(st_s)
                key = (cik, acc)
                entry = grouped_filings.get(key)
                if entry is None:
                    entry = {
                        "cik": cik,
                        "accession": acc,
                        "form": form_s,
                        "filing_date": rec["_f_day"],
                        "avail_ns": int(rec["_eff_ns"]),
                        "full_status": None,
                        "sim_full": np.nan,
                        "jac_full": np.nan,
                        "sim_rf": np.nan,
                        "sim_mdna": np.nan,
                        "len_change_full": np.nan,
                    }
                    grouped_filings[key] = entry
                else:
                    entry["avail_ns"] = max(int(entry["avail_ns"]), int(rec["_eff_ns"]))

                sec_name = str(rec["section"]).strip()
                cos_v = pd.to_numeric(rec.get("cosine"), errors="coerce")
                jac_v = pd.to_numeric(rec.get("jaccard"), errors="coerce")
                len_v = pd.to_numeric(rec.get("length_log_ratio"), errors="coerce")
                cos_f = (
                    float(cos_v)
                    if pd.notna(cos_v) and math.isfinite(float(cos_v))
                    else np.nan
                )
                jac_f = (
                    float(jac_v)
                    if pd.notna(jac_v) and math.isfinite(float(jac_v))
                    else np.nan
                )
                len_f = (
                    float(len_v)
                    if pd.notna(len_v) and math.isfinite(float(len_v))
                    else np.nan
                )

                if sec_name == "full":
                    entry["full_status"] = st_s
                    if st_s == "ok":
                        entry["sim_full"] = cos_f
                        entry["jac_full"] = jac_f
                        entry["len_change_full"] = len_f
                elif sec_name == "risk_factors":
                    if st_s == "ok":
                        entry["sim_rf"] = cos_f
                elif sec_name == "mdna":
                    if st_s == "ok":
                        entry["sim_mdna"] = cos_f

            for info in grouped_filings.values():
                by_cik.setdefault(info["cik"], []).append(
                    _FilingTextSummary(
                        filing_date=info["filing_date"],
                        avail_ns=info["avail_ns"],
                        accession=info["accession"],
                        form=info["form"],
                        full_status=info["full_status"] or "section_missing",
                        sim_full=info["sim_full"],
                        jac_full=info["jac_full"],
                        sim_rf=info["sim_rf"],
                        sim_mdna=info["sim_mdna"],
                        len_change_full=info["len_change_full"],
                    )
                )
            for filings_list in by_cik.values():
                filings_list.sort(
                    key=lambda item: (item.filing_date, item.avail_ns, item.accession)
                )

    sim_full = np.full(n, np.nan, dtype="float64")
    jac_full = np.full(n, np.nan, dtype="float64")
    sim_rf = np.full(n, np.nan, dtype="float64")
    sim_mdna = np.full(n, np.nan, dtype="float64")
    len_full = np.full(n, np.nan, dtype="float64")
    sim_10k = np.full(n, np.nan, dtype="float64")
    age_days: list[int | None] = [None] * n
    forms_out: list[str | None] = [None] * n
    status_out: list[str | None] = [None] * n

    for i in range(n):
        cik = sample_ciks[i]
        d_ns = int(decision_ns[i])
        d_ny = ny_dates[i]
        if not cik or d_ns == NAT or d_ny is None:
            continue
        filings = by_cik.get(cik)
        if not filings:
            continue

        latest_any: _FilingTextSummary | None = None
        latest_10k: _FilingTextSummary | None = None
        for f in filings:
            if f.avail_ns <= d_ns:
                latest_any = f
                if f.form == "10-K":
                    latest_10k = f

        if latest_any is not None:
            age = (d_ny - latest_any.filing_date).days
            age_days[i] = age
            forms_out[i] = latest_any.form
            status_out[i] = latest_any.full_status
            if age <= 200:
                sim_full[i] = latest_any.sim_full
                jac_full[i] = latest_any.jac_full
                sim_rf[i] = latest_any.sim_rf
                sim_mdna[i] = latest_any.sim_mdna
                len_full[i] = latest_any.len_change_full

        if latest_10k is not None:
            age_10k = (d_ny - latest_10k.filing_date).days
            if age_10k <= 400:
                sim_10k[i] = latest_10k.sim_full

    out = pd.DataFrame(
        {
            "txt_sim_full": sim_full,
            "txt_jac_full": jac_full,
            "txt_sim_rf": sim_rf,
            "txt_sim_mdna": sim_mdna,
            "txt_len_change_full": len_full,
            "txt_age_days": pd.array(age_days, dtype="Int16"),
            "txt_form": pd.Categorical(forms_out, categories=observed_forms),
            "txt_status": pd.Categorical(status_out, categories=observed_statuses),
            "txt_sim_full_10k": sim_10k,
        },
        index=candidates.index,
    )
    out.attrs["extra_missing"] = []
    return out


# ---------------------------------------------------------------------------
# 6. Broker borrow-availability features (opt-in)
# ---------------------------------------------------------------------------


def borrow_features(
    version: Any,
    candidates: pd.DataFrame,
    *,
    time_policy: str,
) -> pd.DataFrame:
    """Point-in-time broker shortable and easy-to-borrow flags (opt-in group)."""
    policy = _validate_candidates(candidates, time_policy)
    selected_assets = list(dict.fromkeys(candidates["asset_id"].astype(str)))
    brw_df, present = _read_optional_family(
        version,
        "borrow_availability",
        symbols=selected_assets if selected_assets else None,
        columns=[
            "asset_id",
            "observed_at",
            "available_at",
            "shortable",
            "easy_to_borrow",
        ],
    )
    if not present or brw_df is None:
        return _empty_result(candidates, ["borrow_availability"])

    n = len(candidates)
    decision_ns = clocks.instants(candidates["decision_at"])

    if brw_df.empty or not {"asset_id", "available_at"}.issubset(brw_df.columns):
        obs_arr = [None if int(ns) == NAT else False for ns in decision_ns.tolist()]
        out = pd.DataFrame(
            {
                "brw_shortable": pd.array([None] * n, dtype="boolean"),
                "brw_easy_to_borrow": pd.array([None] * n, dtype="boolean"),
                "brw_observed": pd.array(obs_arr, dtype="boolean"),
            },
            index=candidates.index,
        )
        out.attrs["extra_missing"] = []
        return out

    work = brw_df.copy()
    eff_ns = _effective_available_ns(work, policy)
    work = work[eff_ns != NAT].copy()
    if work.empty:
        obs_arr = [None if int(ns) == NAT else False for ns in decision_ns.tolist()]
        out = pd.DataFrame(
            {
                "brw_shortable": pd.array([None] * n, dtype="boolean"),
                "brw_easy_to_borrow": pd.array([None] * n, dtype="boolean"),
                "brw_observed": pd.array(obs_arr, dtype="boolean"),
            },
            index=candidates.index,
        )
        out.attrs["extra_missing"] = []
        return out

    work["_eff_avail"] = clocks.utc(eff_ns[eff_ns != NAT])
    if "shortable" not in work.columns:
        work["shortable"] = pd.array([None] * len(work), dtype="boolean")
    if "easy_to_borrow" not in work.columns:
        work["easy_to_borrow"] = pd.array([None] * len(work), dtype="boolean")

    joined = asof_join(
        candidates,
        work,
        by="asset_id",
        columns=["_eff_avail", "shortable", "easy_to_borrow"],
        sample_time="decision_at",
        table_time="_eff_avail",
        inclusive=True,
        family="borrow_availability",
    )
    matched_ns = clocks.instants(joined["_eff_avail"])

    short_out: list[bool | None] = [None] * n
    etb_out: list[bool | None] = [None] * n
    obs_out: list[bool | None] = [None] * n
    raw_short = joined["shortable"].tolist()
    raw_etb = joined["easy_to_borrow"].tolist()

    for i in range(n):
        d_ns = int(decision_ns[i])
        if d_ns == NAT:
            obs_out[i] = None
            continue
        m_ns = int(matched_ns[i])
        if m_ns == NAT or (d_ns - m_ns) > _THREE_DAYS_NS:
            obs_out[i] = False
            continue
        obs_out[i] = True
        s_val = raw_short[i]
        e_val = raw_etb[i]
        short_out[i] = (
            bool(s_val)
            if isinstance(s_val, (bool, np.bool_)) and not pd.isna(s_val)
            else None
        )
        etb_out[i] = (
            bool(e_val)
            if isinstance(e_val, (bool, np.bool_)) and not pd.isna(e_val)
            else None
        )

    out = pd.DataFrame(
        {
            "brw_shortable": pd.array(short_out, dtype="boolean"),
            "brw_easy_to_borrow": pd.array(etb_out, dtype="boolean"),
            "brw_observed": pd.array(obs_out, dtype="boolean"),
        },
        index=candidates.index,
    )
    out.attrs["extra_missing"] = []
    return out


# ---------------------------------------------------------------------------
# 7. Combined extra_features builder & cross-sectional ranks
# ---------------------------------------------------------------------------


def _rank_eligible_mask(version: Any, candidates: pd.DataFrame) -> np.ndarray:
    """Boolean mask of in-universe, non-benchmark rows per session for ``ranks=True``."""
    n = len(candidates)
    if n == 0:
        return np.zeros(0, dtype=bool)

    if "in_universe" in candidates.columns:
        in_uni = candidates["in_universe"]
        # Static-universe candidates have all-NA in_universe; treat non-False as eligible.
        if in_uni.isna().all():
            member_mask = np.ones(n, dtype=bool)
        else:
            member_mask = in_uni.fillna(False).to_numpy(dtype=bool)
    else:
        member_mask = np.ones(n, dtype=bool)

    if "is_benchmark" in candidates.columns:
        bench_mask = candidates["is_benchmark"].fillna(False).to_numpy(dtype=bool)
    else:
        flagged = {
            str(row["asset_id"])
            for row in _universe_records(version)
            if row.get("asset_id") and _candidates.flagged(row)
        }
        bench_mask = (
            candidates["asset_id"].astype(str).isin(flagged).to_numpy(dtype=bool)
        )

    return member_mask & (~bench_mask)


def extra_features(
    version: Any,
    candidates: pd.DataFrame,
    *,
    time_policy: str,
    groups: Sequence[str] = DEFAULT_EXTRA_GROUPS,
    fundamentals: pd.DataFrame | None = None,
    ranks: bool = False,
    allow_unverified_links: bool = False,
) -> pd.DataFrame:
    """Build union of requested extra feature groups aligned to ``candidates``."""
    policy = _validate_candidates(candidates, time_policy)
    if isinstance(groups, (str, bytes)) or not isinstance(groups, Sequence):
        raise TypeError("groups must be a sequence of group names")
    ordered_groups = list(dict.fromkeys(groups))
    unknown = [g for g in ordered_groups if g not in EXTRA_GROUPS]
    if unknown:
        raise ValueError(
            f"Unknown extra feature group(s) {unknown}; valid groups are {EXTRA_GROUPS}"
        )

    frames: list[pd.DataFrame] = []
    missing_all: list[str] = []

    for group in ordered_groups:
        if group == "reference":
            part = reference_features(version, candidates, time_policy=policy)
        elif group == "market_etf":
            part = market_etf_features(version, candidates, time_policy=policy)
        elif group == "insider":
            part = insider_features(
                version, candidates, time_policy=policy, fundamentals=fundamentals
            )
        elif group == "short_interest":
            part = short_interest_features(
                version,
                candidates,
                time_policy=policy,
                fundamentals=fundamentals,
                allow_unverified_links=allow_unverified_links,
            )
        elif group == "text_change":
            part = text_change_features(version, candidates, time_policy=policy)
        elif group == "borrow":
            part = borrow_features(version, candidates, time_policy=policy)
        else:  # pragma: no cover
            continue

        for m in part.attrs.get("extra_missing", []):
            if m not in missing_all:
                missing_all.append(m)
        if not part.columns.empty:
            frames.append(part)

    if frames:
        result = pd.concat(frames, axis=1)
    else:
        result = pd.DataFrame(index=candidates.index)

    if ranks and not result.columns.empty and len(candidates) > 0:
        eligible = _rank_eligible_mask(version, candidates)
        sessions_key = pd.Series(
            [_parse_iso_day(s) for s in candidates["signal_session"]],
            index=candidates.index,
        )
        for col in RANK_COLUMNS:
            if col not in result.columns:
                continue
            vals = pd.to_numeric(result[col], errors="coerce").where(eligible)
            ranked = vals.groupby(sessions_key, sort=False).rank(
                pct=True, method="average"
            )
            result[f"{col}_rank"] = ranked.astype("float64")

    result.attrs["extra_missing"] = missing_all
    result.attrs["groups"] = ordered_groups
    return result


# ---------------------------------------------------------------------------
# 8. Evaluation-only factor returns & daily risk-free series
# ---------------------------------------------------------------------------


def factor_matrix(
    version: Any,
    *,
    factor_set: str = "ff5_daily",
    start: str | date | None = None,
    end: str | date | None = None,
) -> pd.DataFrame:
    """Read evaluation-only academic factor returns as a ``date x factor`` DataFrame."""
    if not isinstance(factor_set, str) or not factor_set.strip():
        raise ValueError("factor_set must be a non-empty string")
    df = version.family("factor_returns", start=start, end=end)
    start_d = clocks.day(start) if start is not None else None
    end_d = clocks.day(end) if end is not None else None

    if df.empty:
        empty = pd.DataFrame(index=pd.Index([], name="date"))
        empty.attrs.update(evaluation_only=True, factor_set=factor_set)
        return empty

    work = df.copy()
    if "factor_set" in work.columns:
        work = work[work["factor_set"].astype(str) == factor_set].copy()
    work["_day"] = [_parse_iso_day(d) for d in work["date"]]
    work = work[work["_day"].notna()].copy()
    if start_d is not None:
        work = work[work["_day"] >= start_d].copy()
    if end_d is not None:
        work = work[work["_day"] <= end_d].copy()

    if work.empty:
        empty = pd.DataFrame(index=pd.Index([], name="date"))
        empty.attrs.update(evaluation_only=True, factor_set=factor_set)
        return empty

    if "retrieved_at" in work.columns:
        work = work.sort_values(["_day", "factor", "retrieved_at"], kind="mergesort")
    work["value"] = pd.to_numeric(work["value"], errors="coerce")
    work = work.drop_duplicates(["_day", "factor"], keep="last")

    wide = work.pivot(index="_day", columns="factor", values="value").sort_index()
    wide.index = pd.Index(wide.index.tolist(), name="date")
    wide.columns = pd.Index(wide.columns.astype(str).tolist(), name="factor")
    wide = wide.astype("float64")

    attrs: dict[str, Any] = {"evaluation_only": True, "factor_set": factor_set}
    if "vintage_id" in work.columns and not work["vintage_id"].dropna().empty:
        attrs["vintage_id"] = str(work["vintage_id"].dropna().iloc[-1])
    if "source_note" in work.columns and not work["source_note"].dropna().empty:
        attrs["source_note"] = str(work["source_note"].dropna().iloc[-1])
    wide.attrs.update(attrs)
    return wide


def risk_free_daily(
    version: Any,
    *,
    series: str = "DTB3",
    time_policy: str = "public_reconstructed",
) -> pd.Series:
    """Daily compounded risk-free return per session from ``(1 + y/100)^(1/252) - 1``."""
    policy = clocks.policy(time_policy)
    if not isinstance(series, str) or not series.strip():
        raise ValueError("series must be a non-empty series ID")
    sid = series.strip().upper()

    cal_raw = getattr(version, "calendar", None)
    if cal_raw is None and isinstance(version, Mapping):
        cal_raw = version.get("calendar", [])
    cal = clocks.Calendar(cal_raw or [])
    idx = pd.Index(list(cal.days), name="session")

    try:
        df, present = _read_optional_family(
            version,
            "reference_series",
            symbols=[sid],
            columns=[
                "series_id",
                "date",
                "value",
                "observation_sequence",
                "observed_at",
                "available_at",
            ],
        )
    except (KeyError, ValueError):
        df, present = _read_optional_family(
            version,
            "reference_series",
            columns=[
                "series_id",
                "date",
                "value",
                "observation_sequence",
                "observed_at",
                "available_at",
            ],
        )
    if not present or df is None or df.empty:
        out = pd.Series(np.full(len(cal), np.nan, dtype="float64"), index=idx, name=sid)
        out.attrs["extra_missing"] = [] if present else ["reference_series"]
        return out

    prepared = _prepare_reference_series(df, [sid], policy).get(sid)
    vals = np.full(len(cal), np.nan, dtype="float64")
    for i, d_day in enumerate(cal.days):
        d_ns = int(cal.decisions[i])
        y_pct, _, _ = _series_snapshot_at(prepared, d_ns, d_day, max_age_days=None)
        if math.isfinite(y_pct) and (1.0 + y_pct / 100.0) > 0.0:
            vals[i] = (1.0 + y_pct / 100.0) ** (1.0 / 252.0) - 1.0

    out = pd.Series(vals, index=idx, name=sid, dtype="float64")
    out.attrs["extra_missing"] = []
    return out
