"""Server pre-materialized training bundles, streaming prefetch, and zero-leakage JAX views.

Implements the two-layer preprocessing architecture (DATA-AND-MODEL-SPEC v2.9 §0.6 & §3.6):
- Tier 1 (Server-frozen, single-date stateless): physical domain clipping, Type-B raw level drops,
  EV multiple inversion, full-universe GaussRank (Type A1), and FF12 industry-conditional
  GaussRank (Type A2) per single ``signal_session`` with zero cross-date coupling.
- Tier 2 (Client in-memory, < 50 ms): hard ``<= as_of`` anchor/store truncation, independent
  per-horizon label maturity masking (``exit_session_H <= as_of``), ``<= fit_end`` sparse/binary
  scaling & causal expanding macro Z-scoring, and static TPU-MXU-aligned JAX/XLA tensors.
"""

from __future__ import annotations

import gc
import hashlib
import json
import math
import shutil
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from . import clocks
from .client import DatasetError
from .labels import gauss_rank_cross_section, norm_ppf_vec
from .materialize import MaterializedDataset, materialize, validate_recipe
from .stores import PRICE_CHANNELS, MacroStore, PriceStore

TRAINING_BUNDLE_SCHEMA_VERSION = 1
DEFAULT_JAX_HORIZONS: tuple[int, ...] = (5, 10, 21, 63)
DEFAULT_PAD_TO = 1280
SEQ_PRICE_CHANNELS: tuple[str, ...] = (
    "ret_1d",
    "overnight_ret",
    "intraday_ret",
    "log_dollar_volume",
    "hl_range_ratio",
    "open_close_ratio",
)

# Type B: raw USD/share levels & redundant age columns dropped before model matrices.
_TYPE_B_DROP_COLS: frozenset[str] = frozenset(
    {
        "revenue_q_value",
        "revenue_ttm_value",
        "revenue_fy_value",
        "gross_profit_q_value",
        "gross_profit_ttm_value",
        "gross_profit_fy_value",
        "operating_income_q_value",
        "operating_income_ttm_value",
        "operating_income_fy_value",
        "net_income_q_value",
        "net_income_ttm_value",
        "net_income_fy_value",
        "operating_cash_flow_q_value",
        "operating_cash_flow_ttm_value",
        "operating_cash_flow_fy_value",
        "capex_q_value",
        "capex_ttm_value",
        "capex_fy_value",
        "ebitda_q_value",
        "ebitda_ttm_value",
        "ebitda_fy_value",
        "fcf_q_value",
        "fcf_ttm_value",
        "fcf_fy_value",
        "cash_value",
        "total_assets_value",
        "total_liabilities_value",
        "equity_value",
        "total_debt_value",
        "shares_outstanding_value",
        "diluted_eps_q_value",
        "diluted_eps_ttm_value",
        "diluted_eps_fy_value",
        "val_market_cap_issuer",
        "val_enterprise_value",
        "si_shares",
        "ins_buy_value_90d",
        "ins_sell_value_90d",
        "ins_buy_value_180d",
        "ins_sell_value_180d",
    }
)

_INVERT_MULTIPLES: Mapping[str, str] = {
    "val_ev_to_sales": "val_sales_to_ev",
    "val_ev_to_ebit": "val_ebit_to_ev",
}

# Type A2: sector-conditional (FF12) cross-sectional GaussRank features.
_TYPE_A2_EXACT: frozenset[str] = frozenset(
    {
        "val_earnings_yield",
        "val_fcf_yield",
        "val_book_to_market",
        "val_sales_yield",
        "val_ebit_to_ev",
        "val_sales_to_ev",
        "val_dividend_yield",
    }
)
_TYPE_A2_PREFIXES: tuple[str, ...] = (
    "roe_",
    "roa_",
    "gross_margin_",
    "operating_margin_",
    "net_margin_",
    "fcf_margin_",
    "debt_to_",
    "cash_to_",
    "accruals_",
    "asset_growth_",
    "revenue_q_yoy",
    "revenue_ttm_yoy",
    "net_income_q_yoy",
    "net_income_ttm_yoy",
    "eps_diluted_q_yoy",
    "eps_diluted_ttm_yoy",
    "gross_profit_to_assets",
    "operating_profitability",
)

# Type C binary / indicator / low-cardinality flags preserved in [0, 1].
_TYPE_C_BINARY_EXACT: frozenset[str] = frozenset(
    {
        "earn_ear_pending",
        "earn_next_overdue",
        "si_split_flag",
        "restate_any_downward_4q",
        "restate_sec_non_reliance_365d",
        "buyback_authorized",
        "dividend_announced",
        "guidance_issued",
        "guidance_raised",
        "guidance_lowered",
        "guidance_maintained",
        "guidance_withdrawn",
        "guidance_revenue_raised",
        "guidance_revenue_lowered",
        "guidance_revenue_reaffirmed",
        "guidance_revenue_initiated",
        "guidance_revenue_withdrawn",
        "guidance_eps_raised",
        "guidance_eps_lowered",
        "guidance_eps_reaffirmed",
        "guidance_eps_initiated",
        "guidance_eps_withdrawn",
    }
)

# Type C sparse/count/event features scaled via <= fit_end median + 4*tanh(sign*log1p(|x|/s)/4).
_TYPE_C_SPARSE_EXACT: frozenset[str] = frozenset(
    {
        "earn_days_since",
        "earn_sessions_since",
        "earn_candidates_in_period",
        "earn_days_until_next_est",
        "earn_sue_age_days",
        "fund_visible_quarters",
        "fund_age_days",
        "si_age_sessions",
        "txt_age_days",
        "restate_ni_assets",
        "restate_rev_assets",
        "restate_ni_count_4q",
        "restate_rev_count_4q",
        "restate_sec_amendment_365d",
        "sec_events_1d",
        "sec_events_5d",
        "sec_events_21d",
        "sec_events_63d",
        "release_sessions_since",
    }
)
_TYPE_C_SPARSE_PREFIXES: tuple[str, ...] = (
    "ev_unexplained_",
    "sec_shock_",
    "mac_panic_",
    "ins_buy_filings_",
    "ins_buyers_",
    "ins_sellers_",
    "ins_net_ratio_",
    "ins_net_value_mcap_",
    "ins_officer_buy_",
    "guidance_",
    "buyback_",
    "dividend_",
    "release_",
    "alpaca_news_events_",
    "finnhub_news_events_",
    "news_decay_",
)

# Type D market-wide regime features (identical across all stocks on a given date).
_TYPE_D_PREFIXES: tuple[str, ...] = ("ref_", "etf_", "crypto_")


def _classify_feature(name: str) -> str:
    if name == "ind_ff12_code":
        return "categorical"
    if name.startswith(_TYPE_D_PREFIXES):
        return "tier2_d_macro"
    if name in _TYPE_C_BINARY_EXACT or name.endswith(("_flag", "_pending", "_overdue")):
        return "tier2_c_binary"
    if name in _TYPE_C_SPARSE_EXACT or name.startswith(_TYPE_C_SPARSE_PREFIXES):
        return "tier2_c_sparse"
    if name in _TYPE_A2_EXACT or name.startswith(_TYPE_A2_PREFIXES):
        return "tier1_a2"
    return "tier1_a1"


def _clip_physical_domain(name: str, vals: np.ndarray) -> np.ndarray:
    arr = np.where(np.isfinite(vals), vals, np.nan).astype(np.float64, copy=False)
    if name.startswith(("txt_sim_", "txt_jac_")):
        return np.clip(arr, 0.0, 1.0)
    if name.startswith(
        (
            "pvol_rvol_",
            "pvol_parkinson_",
            "pvol_down_vol_",
            "pvol_up_vol_",
            "pvol_idio_",
        )
    ):
        return np.where(np.isfinite(arr), np.maximum(arr, 0.0), np.nan)
    if name.startswith("prange_dist_high_"):
        return np.where(np.isfinite(arr), np.minimum(arr, 0.0), np.nan)
    if name.startswith("prange_dist_low_"):
        return np.where(np.isfinite(arr), np.maximum(arr, 0.0), np.nan)
    if name.startswith("ins_net_ratio_"):
        return np.clip(arr, -1.0, 1.0)
    return arr


def _sector_gauss_rank(
    values: np.ndarray,
    sessions: np.ndarray,
    ind_codes: np.ndarray,
    valid_mask: np.ndarray,
    *,
    min_sector_size: int = 15,
) -> np.ndarray:
    """Single-session FF12-conditional GaussRank falling back to full-universe when sector < 15."""
    full_gr = gauss_rank_cross_section(values, sessions, valid_mask)
    vals = np.asarray(values, dtype=np.float64)
    mask = (
        np.asarray(valid_mask, dtype=bool)
        & np.isfinite(vals)
        & (ind_codes >= 0)
        & (ind_codes < 12)
    )
    if not mask.any():
        return full_gr

    valid_idx = np.flatnonzero(mask)
    sub_v = vals[valid_idx]
    g_codes = sessions[valid_idx].astype(np.int64, copy=False) * 16 + ind_codes[
        valid_idx
    ].astype(np.int64, copy=False)
    k = len(valid_idx)
    order = np.lexsort((sub_v, g_codes))
    g_s = g_codes[order]
    v_s = sub_v[order]

    g_change = np.empty(k + 1, dtype=bool)
    g_change[0] = True
    g_change[k] = True
    if k > 1:
        g_change[1:k] = g_s[1:] != g_s[:-1]
    g_starts = np.flatnonzero(g_change[:-1])
    g_ends = np.flatnonzero(g_change[1:]) + 1
    g_lens = g_ends - g_starts
    elem_g_start = np.repeat(g_starts, g_lens)
    elem_g_len = np.repeat(g_lens, g_lens)

    keep = elem_g_len >= int(min_sector_size)
    if not keep.any():
        return full_gr

    ord_rank = (np.arange(k, dtype=np.float64) - elem_g_start) + 1.0
    t_change = np.empty(k + 1, dtype=bool)
    t_change[0] = True
    t_change[k] = True
    if k > 1:
        t_change[1:k] = (g_s[1:] != g_s[:-1]) | (v_s[1:] != v_s[:-1])
    t_starts = np.flatnonzero(t_change[:-1])
    t_ends = np.flatnonzero(t_change[1:]) + 1
    t_lens = t_ends - t_starts
    avg_rank = np.repeat(0.5 * (ord_rank[t_starts] + ord_rank[t_ends - 1]), t_lens)

    u = np.clip(
        (avg_rank[keep] - 0.5) / elem_g_len[keep].astype(np.float64),
        1e-6,
        1.0 - 1e-6,
    )
    out = full_gr.copy()
    out[valid_idx[order[keep]]] = norm_ppf_vec(u)
    return out


def build_tier1_features(
    x_raw: pd.DataFrame,
    anchors_df: pd.DataFrame,
) -> tuple[pd.DataFrame, dict[str, list[str]]]:
    """Run Tier-1 stateless single-date preprocessing with zero cross-date coupling."""
    n = len(x_raw)
    if n == 0:
        return pd.DataFrame(index=x_raw.index), {
            "tier1_a1": [],
            "tier1_a2": [],
            "tier2_c_sparse": [],
            "tier2_c_binary": [],
            "tier2_d_macro": [],
            "categorical": [],
            "dropped": [],
        }

    sessions = np.array(
        [clocks.day(d).toordinal() for d in anchors_df["signal_session"]],
        dtype=np.int32,
    )
    in_uni = (
        anchors_df["in_universe"].fillna(True).to_numpy(dtype=bool)
        if "in_universe" in anchors_df.columns
        else np.ones(n, dtype=bool)
    )
    is_bench = (
        anchors_df["is_benchmark"].fillna(False).to_numpy(dtype=bool)
        if "is_benchmark" in anchors_df.columns
        else np.zeros(n, dtype=bool)
    )
    cs_mask = in_uni & ~is_bench

    if "ind_ff12_code" in x_raw.columns:
        raw_ind = pd.to_numeric(x_raw["ind_ff12_code"], errors="coerce").to_numpy(
            dtype=np.float64
        )
        ok_ind = np.isfinite(raw_ind) & (raw_ind >= 0) & (raw_ind < 12)
        ind_codes = np.where(ok_ind, np.nan_to_num(raw_ind, nan=12.0), 12.0).astype(
            np.int32
        )
    else:
        ind_codes = np.full(n, 12, dtype=np.int32)

    out_cols: dict[str, np.ndarray] = {}
    col_types: dict[str, list[str]] = {
        "tier1_a1": [],
        "tier1_a2": [],
        "tier2_c_sparse": [],
        "tier2_c_binary": [],
        "tier2_d_macro": [],
        "categorical": [],
        "dropped": [],
    }

    # Collapse redundant *_age_days columns from fundamentals_pit into one `fund_age_days`.
    fund_age_cols = [
        c
        for c in x_raw.columns
        if c.endswith("_age_days")
        and c not in {"earn_sue_age_days", "txt_age_days", "fund_age_days"}
    ]
    if fund_age_cols:
        age_mat = np.column_stack(
            [
                pd.to_numeric(x_raw[c], errors="coerce").to_numpy(dtype=np.float64)
                for c in fund_age_cols
            ]
        )
        with np.errstate(invalid="ignore"):
            any_fin = np.any(np.isfinite(age_mat), axis=1)
            f_age = np.full(n, np.nan, dtype=np.float64)
            if any_fin.any():
                f_age[any_fin] = np.nanmin(age_mat[any_fin], axis=1)
        out_cols["fund_age_days"] = np.where(
            np.isfinite(f_age), np.maximum(f_age, 0.0), np.nan
        ).astype(np.float32)
        col_types["tier2_c_sparse"].append("fund_age_days")

    for raw_name in x_raw.columns:
        if raw_name in _TYPE_B_DROP_COLS or raw_name in fund_age_cols:
            col_types["dropped"].append(str(raw_name))
            continue

        arr = pd.to_numeric(x_raw[raw_name], errors="coerce").to_numpy(dtype=np.float64)
        out_name = _INVERT_MULTIPLES.get(str(raw_name), str(raw_name))
        if raw_name in _INVERT_MULTIPLES:
            with np.errstate(divide="ignore", invalid="ignore"):
                arr = np.where(
                    np.isfinite(arr) & (np.abs(arr) > 1e-6), 1.0 / arr, np.nan
                )

        arr = _clip_physical_domain(out_name, arr)

        # Drop strictly empty (0% finite) placeholder columns.
        if out_name != "ind_ff12_code" and not np.any(np.isfinite(arr)):
            col_types["dropped"].append(out_name)
            continue

        ctype = _classify_feature(out_name)
        if ctype == "categorical":
            out_cols["ind_ff12_code"] = ind_codes.astype(np.float32)
            col_types["categorical"].append("ind_ff12_code")
        elif ctype == "tier1_a1":
            gr = gauss_rank_cross_section(arr, sessions, cs_mask)
            out_cols[out_name] = np.where(np.isfinite(gr), gr, 0.0).astype(np.float32)
            col_types["tier1_a1"].append(out_name)
        elif ctype == "tier1_a2":
            gr = _sector_gauss_rank(arr, sessions, ind_codes, cs_mask)
            out_cols[out_name] = np.where(np.isfinite(gr), gr, 0.0).astype(np.float32)
            col_types["tier1_a2"].append(out_name)
        else:
            out_cols[out_name] = arr.astype(np.float32)
            col_types[ctype].append(out_name)

    if "ind_ff12_code" not in out_cols:
        out_cols["ind_ff12_code"] = ind_codes.astype(np.float32)
        col_types["categorical"].append("ind_ff12_code")

    return pd.DataFrame(out_cols, index=x_raw.index), col_types


def _compact_labels_frame(y_df: pd.DataFrame, horizons: Sequence[int]) -> pd.DataFrame:
    """Keep compact training/audit label columns with explicit exit_session per horizon."""
    wanted: list[str] = [
        "asset_id",
        "signal_session",
        "in_universe",
        "welch_beta_252d",
        "resid_vol_63d",
    ]
    for h in horizons:
        h_i = int(h)
        wanted.extend(
            [
                f"h{h_i}_exit_session",
                f"h{h_i}_asset_return",
                f"h{h_i}_benchmark_return",
                f"forward_excess_return_{h_i}d",
                f"h{h_i}_beta_adj_return",
                f"h{h_i}_ir_return",
                f"h{h_i}_gauss_rank",
                f"h{h_i}_fwd_rvol",
                f"h{h_i}_fwd_max_dd",
                f"h{h_i}_fwd_rel_dvol",
                f"trainable_{h_i}d",
            ]
        )
    cols = [c for c in wanted if c in y_df.columns]
    out = y_df[cols].copy()
    if "signal_session" in out.columns:
        out["signal_session"] = [
            clocks.day(v).isoformat() for v in out["signal_session"]
        ]
    for h in horizons:
        ec = f"h{int(h)}_exit_session"
        if ec in out.columns:
            out[ec] = [
                clocks.day(v).isoformat() if pd.notna(v) and v is not None else ""
                for v in out[ec]
            ]
    for col in out.columns:
        if pd.api.types.is_float_dtype(out[col].dtype):
            out[col] = out[col].astype(np.float32)
    return out


def _sha256_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    total = 0
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
            total += len(chunk)
    return digest.hexdigest(), total


def _write_zstd_tensor_shards(
    arr: np.ndarray,
    output_dir: Path,
    *,
    prefix: str = "price_store",
    target_shard_bytes: int = 96 * 1024 * 1024,
) -> list[dict[str, Any]]:
    """Split ``arr`` along axis 0 into bounded Zstd-compressed float32 binary shards."""
    n0 = arr.shape[0]
    if n0 == 0:
        return []
    row_bytes = max(1, int(np.prod(arr.shape[1:])) * arr.dtype.itemsize)
    rows_per_shard = max(1, target_shard_bytes // row_bytes)
    shards: list[dict[str, Any]] = []
    for part_idx, start in enumerate(range(0, n0, rows_per_shard)):
        stop = min(n0, start + rows_per_shard)
        chunk_arr = np.ascontiguousarray(arr[start:stop], dtype=np.float32)
        raw_buf = pa.py_buffer(chunk_arr.tobytes(order="C"))
        comp_buf = pa.compress(raw_buf, codec="zstd", asbytes=True)
        fname = f"{prefix}_part-{part_idx:05d}.bin.zst"
        fpath = output_dir / fname
        fpath.write_bytes(comp_buf)
        sha, size = _sha256_file(fpath)
        shards.append(
            {
                "filename": fname,
                "start_asset": int(start),
                "end_asset": int(stop),
                "shape": [int(d) for d in chunk_arr.shape],
                "dtype": "float32",
                "codec": "zstd",
                "sha256": sha,
                "size_bytes": size,
            }
        )
    return shards


def _read_zstd_tensor_shards(
    shard_paths: Sequence[tuple[Path, Mapping[str, Any]]],
    full_shape: Sequence[int],
) -> np.ndarray:
    out = np.empty(tuple(int(d) for d in full_shape), dtype=np.float32)
    for path, meta in shard_paths:
        comp = path.read_bytes()
        shape = tuple(int(d) for d in meta["shape"])
        uncomp_size = int(np.prod(shape)) * 4
        raw = pa.decompress(comp, decompressed_size=uncomp_size, codec="zstd")
        arr = np.frombuffer(raw, dtype=np.float32).reshape(shape)
        out[int(meta["start_asset"]) : int(meta["end_asset"])] = arr
    return out


def _transform_tier1_column(
    raw_name: str,
    raw_series: pd.Series | np.ndarray,
    *,
    sessions: np.ndarray,
    ind_codes: np.ndarray,
    cs_mask: np.ndarray,
) -> tuple[str, str, np.ndarray | None]:
    """Run Tier-1 single-date transform on one raw feature column.

    Returns ``(out_name, col_type, float32_array_or_None)``. ``None`` means dropped.
    """
    if raw_name in _TYPE_B_DROP_COLS:
        return str(raw_name), "dropped", None

    arr = pd.to_numeric(raw_series, errors="coerce").to_numpy(dtype=np.float64)
    out_name = _INVERT_MULTIPLES.get(str(raw_name), str(raw_name))
    if raw_name in _INVERT_MULTIPLES:
        with np.errstate(divide="ignore", invalid="ignore"):
            arr = np.where(np.isfinite(arr) & (np.abs(arr) > 1e-6), 1.0 / arr, np.nan)

    arr = _clip_physical_domain(out_name, arr)

    # Drop strictly empty (0% finite) placeholder columns.
    if out_name != "ind_ff12_code" and not np.any(np.isfinite(arr)):
        return out_name, "dropped", None

    ctype = _classify_feature(out_name)
    if ctype == "categorical":
        return "ind_ff12_code", "categorical", ind_codes.astype(np.float32)
    if ctype == "tier1_a1":
        gr = gauss_rank_cross_section(arr, sessions, cs_mask)
        return (
            out_name,
            "tier1_a1",
            np.where(np.isfinite(gr), gr, 0.0).astype(np.float32),
        )
    if ctype == "tier1_a2":
        gr = _sector_gauss_rank(arr, sessions, ind_codes, cs_mask)
        return (
            out_name,
            "tier1_a2",
            np.where(np.isfinite(gr), gr, 0.0).astype(np.float32),
        )
    return out_name, ctype, arr.astype(np.float32)


def _stream_tier1_x_shards(
    ordered_groups: Sequence[tuple[str, str, Sequence[str]]],
    anchors_df: pd.DataFrame,
    out_dir: Path,
    *,
    x_rows_per_part: int,
    on_progress: Callable[[str, str, int, int], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> tuple[list[dict[str, Any]], int, int, list[str], dict[str, list[str]]]:
    """Stream per-group part Parquets into Zstd Tier-1 ``x_tier1_part-*.parquet`` shards.

    Holds only one feature group (~30 MB) during Tier-1 transforms and one row-slice
    (~220 MB for 200k rows) during shard assembly, producing output identical to
    ``build_tier1_features(mat.X, anchors_df)``.
    """
    n = len(anchors_df)
    col_types: dict[str, list[str]] = {
        "tier1_a1": [],
        "tier1_a2": [],
        "tier2_c_sparse": [],
        "tier2_c_binary": [],
        "tier2_d_macro": [],
        "categorical": [],
        "dropped": [],
    }
    step = max(1, int(x_rows_per_part))
    if n == 0:
        empty_tbl = pa.table({})
        fname = "x_tier1_part-00000.parquet"
        fpath = out_dir / fname
        pq.write_table(empty_tbl, fpath, compression="zstd", compression_level=6)
        sha, size = _sha256_file(fpath)
        return (
            [
                {
                    "filename": fname,
                    "start_row": 0,
                    "end_row": 0,
                    "rows": 0,
                    "sha256": sha,
                    "size_bytes": size,
                }
            ],
            0,
            0,
            [],
            col_types,
        )

    sessions = np.array(
        [clocks.day(d).toordinal() for d in anchors_df["signal_session"]],
        dtype=np.int32,
    )
    in_uni = (
        anchors_df["in_universe"].fillna(True).to_numpy(dtype=bool)
        if "in_universe" in anchors_df.columns
        else np.ones(n, dtype=bool)
    )
    is_bench = (
        anchors_df["is_benchmark"].fillna(False).to_numpy(dtype=bool)
        if "is_benchmark" in anchors_df.columns
        else np.zeros(n, dtype=bool)
    )
    cs_mask = in_uni & ~is_bench

    # Resolve FF12 industry codes once before transforming any group.
    ind_codes = np.full(n, 12, dtype=np.int32)
    for _gname, p_path, kept_cols in ordered_groups:
        if "ind_ff12_code" in kept_cols:
            ind_tbl = pq.read_table(p_path, columns=["ind_ff12_code"])
            raw_ind = pd.to_numeric(
                ind_tbl.column(0).to_pandas(), errors="coerce"
            ).to_numpy(dtype=np.float64)
            ok_ind = np.isfinite(raw_ind) & (raw_ind >= 0) & (raw_ind < 12)
            ind_codes = np.where(ok_ind, np.nan_to_num(raw_ind, nan=12.0), 12.0).astype(
                np.int32
            )
            del ind_tbl, raw_ind
            break

    # Identify redundant *_age_days columns across groups to collapse into one `fund_age_days`.
    fund_age_sources: list[tuple[str, list[str]]] = []
    fund_age_set: set[str] = set()
    for _gname, p_path, kept_cols in ordered_groups:
        age_in_group = [
            c
            for c in kept_cols
            if c.endswith("_age_days")
            and c not in {"earn_sue_age_days", "txt_age_days", "fund_age_days"}
        ]
        if age_in_group:
            fund_age_sources.append((p_path, age_in_group))
            fund_age_set.update(age_in_group)

    tmp_dir = out_dir / ".tier1_stream_tmp"
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir)
    tmp_dir.mkdir(parents=True, exist_ok=True)
    temp_files: list[Path] = []
    tier1_columns: list[str] = []
    emitted_cols: set[str] = set()
    n_groups = len(ordered_groups)
    n_shards = (n + step - 1) // step

    try:
        # 1. Collapsed `fund_age_days` column (emitted first, matching build_tier1_features).
        if fund_age_sources:
            f_age = np.full(n, np.nan, dtype=np.float64)
            for p_path, age_cols in fund_age_sources:
                age_tbl = pq.read_table(p_path, columns=age_cols)
                for col_i in range(age_tbl.num_columns):
                    vals = pd.to_numeric(
                        age_tbl.column(col_i).to_pandas(), errors="coerce"
                    ).to_numpy(dtype=np.float64)
                    fin = np.isfinite(vals)
                    if fin.any():
                        take = fin & (~np.isfinite(f_age) | (vals < f_age))
                        f_age[take] = vals[take]
                del age_tbl
            f_age_out = np.where(
                np.isfinite(f_age), np.maximum(f_age, 0.0), np.nan
            ).astype(np.float32)
            age_tmp = tmp_dir / "g_000_fund_age.parquet"
            pq.write_table(
                pa.table({"fund_age_days": pa.array(f_age_out, type=pa.float32())}),
                age_tmp,
                row_group_size=step,
                compression="snappy",
            )
            temp_files.append(age_tmp)
            tier1_columns.append("fund_age_days")
            emitted_cols.add("fund_age_days")
            col_types["tier2_c_sparse"].append("fund_age_days")
            del f_age, f_age_out

        # 2. Stream each feature group part through Tier-1 and flush as aligned row-groups.
        for g_idx, (gname, p_path, kept_cols) in enumerate(ordered_groups):
            if cancel_check is not None and cancel_check():
                raise RuntimeError("MATERIALIZE_CANCELLED")
            if on_progress is not None:
                on_progress(
                    "writing_training_bundle",
                    f"tier1:{gname}",
                    g_idx + 1,
                    n_groups + n_shards,
                )
            if not kept_cols:
                continue
            read_cols = [
                c
                for c in kept_cols
                if c not in _TYPE_B_DROP_COLS and c not in fund_age_set
            ]
            # Record dropped columns in exact column order.
            if not read_cols:
                for raw_name in kept_cols:
                    col_types["dropped"].append(str(raw_name))
                continue
            part_tbl = pq.read_table(p_path, columns=read_cols)
            col_lookup = {name: i for i, name in enumerate(part_tbl.schema.names)}
            arrays_out: dict[str, pa.Array] = {}
            for raw_name in kept_cols:
                if raw_name in _TYPE_B_DROP_COLS or raw_name in fund_age_set:
                    col_types["dropped"].append(str(raw_name))
                    continue
                raw_s = part_tbl.column(col_lookup[raw_name]).to_pandas()
                out_name, ctype, out_arr = _transform_tier1_column(
                    str(raw_name),
                    raw_s,
                    sessions=sessions,
                    ind_codes=ind_codes,
                    cs_mask=cs_mask,
                )
                del raw_s
                if out_arr is None:
                    col_types["dropped"].append(out_name)
                    continue
                if out_name not in emitted_cols:
                    tier1_columns.append(out_name)
                    emitted_cols.add(out_name)
                    col_types[ctype].append(out_name)
                arrays_out[out_name] = pa.array(out_arr, type=pa.float32())
                del out_arr
            del part_tbl
            if arrays_out:
                g_tmp = tmp_dir / f"g_{g_idx + 1:03d}_{gname}.parquet"
                pq.write_table(
                    pa.table(arrays_out),
                    g_tmp,
                    row_group_size=step,
                    compression="snappy",
                )
                temp_files.append(g_tmp)
            del arrays_out
            gc.collect()
            pa.default_memory_pool().release_unused()

        if "ind_ff12_code" not in emitted_cols:
            ind_tmp = tmp_dir / "g_999_ind.parquet"
            pq.write_table(
                pa.table(
                    {
                        "ind_ff12_code": pa.array(
                            ind_codes.astype(np.float32), type=pa.float32()
                        )
                    }
                ),
                ind_tmp,
                row_group_size=step,
                compression="snappy",
            )
            temp_files.append(ind_tmp)
            tier1_columns.append("ind_ff12_code")
            emitted_cols.add("ind_ff12_code")
            col_types["categorical"].append("ind_ff12_code")

        # 3. Assemble final Zstd-compressed x_tier1_part-*.parquet one 200k-row slice at a time.
        x_parts: list[dict[str, Any]] = []
        readers = [pq.ParquetFile(p) for p in temp_files]
        for part_i, lo in enumerate(range(0, n, step)):
            if cancel_check is not None and cancel_check():
                raise RuntimeError("MATERIALIZE_CANCELLED")
            hi = min(n, lo + step)
            fname = f"x_tier1_part-{part_i:05d}.parquet"
            if on_progress is not None:
                on_progress(
                    "writing_training_bundle",
                    fname,
                    n_groups + part_i + 1,
                    n_groups + n_shards,
                )
            col_arrays: dict[str, pa.ChunkedArray] = {}
            for rdr in readers:
                rg_tbl = rdr.read_row_group(part_i)
                for col_name, col_arr in zip(
                    rg_tbl.schema.names, rg_tbl.columns, strict=True
                ):
                    col_arrays[col_name] = col_arr
                del rg_tbl
            ordered_names = [c for c in tier1_columns if c in col_arrays]
            chunk_tbl = pa.table(
                [col_arrays[c] for c in ordered_names], names=ordered_names
            )
            fpath = out_dir / fname
            pq.write_table(
                chunk_tbl,
                fpath,
                compression="zstd",
                compression_level=6,
            )
            sha, size = _sha256_file(fpath)
            x_parts.append(
                {
                    "filename": fname,
                    "start_row": int(lo),
                    "end_row": int(hi),
                    "rows": int(hi - lo),
                    "sha256": sha,
                    "size_bytes": size,
                }
            )
            del col_arrays, chunk_tbl
            gc.collect()
            pa.default_memory_pool().release_unused()
        del readers
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return x_parts, n, len(tier1_columns), tier1_columns, col_types


def build_server_training_bundle(
    dataset: Any,
    output_dir: str | Path,
    *,
    recipe_yaml: str | Mapping[str, Any] | None = None,
    cache_dir: str | Path | None = None,
    benchmark: str = "SPY",
    universe: str = "pit",
    x_rows_per_part: int = 200_000,
    price_shard_raw_bytes: int = 96 * 1024 * 1024,
    on_progress: Callable[[str, str, int, int], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    """Materialize a frozen dataset and emit compact Zstd-compressed server ``training/`` shards."""
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    _, norm_yaml, r_sha = validate_recipe(
        recipe_yaml
        if recipe_yaml is not None
        else (dataset.recipe_yaml() if hasattr(dataset, "recipe_yaml") else None)
    )

    # Fallback gracefully if benchmark ETF (e.g. SPY) is absent in a tiny synthetic test fixture.
    eff_benchmark: str | None = benchmark
    if eff_benchmark:
        try:
            dataset.resolve(eff_benchmark)
        except (DatasetError, KeyError, ValueError):
            eff_benchmark = None

    mat = materialize(
        dataset,
        recipe_yaml=norm_yaml,
        cache_dir=cache_dir,
        benchmark=eff_benchmark,
        universe=universe,
        include_stores=True,
        include_labels=True,
        return_matrix=False,
        on_progress=on_progress,
        cancel_check=cancel_check,
    )
    assert mat.stores is not None and mat.y is not None
    horizons = tuple(
        int(h) for h in mat.recipe.get("horizons_trading_days", DEFAULT_JAX_HORIZONS)
    )
    anc_frame = mat.anchors.frame
    anc_order_sha = str(mat.anchors.order_sha256)
    anc_sampling = str(mat.anchors.sampling)
    anc_time_policy = str(mat.anchors.time_policy)
    ordered_groups = list(mat.report.get("ordered_groups") or ())
    pstore = mat.stores.prices
    mstore = mat.stores.macro

    # 1. Anchors parquet
    if on_progress is not None:
        on_progress("writing_training_bundle", "anchors.parquet", 1, 4)
    anc_df = anc_frame.copy()
    anc_df["asset_id"] = anc_df["asset_id"].astype(str)
    anc_df["signal_session"] = [
        clocks.day(v).isoformat() for v in anc_df["signal_session"]
    ]
    anc_df["entry_session"] = [
        clocks.day(v).isoformat() if pd.notna(v) and v is not None else ""
        for v in anc_df["entry_session"]
    ]
    anc_path = out_dir / "anchors.parquet"
    pq.write_table(
        pa.Table.from_pandas(anc_df, preserve_index=False),
        anc_path,
        compression="zstd",
        compression_level=6,
    )
    anc_sha, anc_size = _sha256_file(anc_path)
    del anc_df

    # 2. Compact labels parquet — write & immediately free mat.y
    if on_progress is not None:
        on_progress("writing_training_bundle", "labels.parquet", 2, 4)
    y_compact = _compact_labels_frame(mat.y, horizons)
    label_columns = list(y_compact.columns)
    y_path = out_dir / "labels.parquet"
    pq.write_table(
        pa.Table.from_pandas(y_compact, preserve_index=False),
        y_path,
        compression="zstd",
        compression_level=6,
    )
    y_sha, y_size = _sha256_file(y_path)
    del y_compact
    mat.y = None
    gc.collect()
    pa.default_memory_pool().release_unused()

    # 3. Write MacroStore & PriceStore shards BEFORE Tier-1 X and release all Stores
    # (PriceStore + FundStore + EventStore + MacroStore) to keep peak RSS well under 2 GiB.
    if on_progress is not None:
        on_progress("writing_training_bundle", "macro_store.parquet", 3, 4)
    price_shape = [int(d) for d in pstore.data.shape]
    price_channels = list(pstore.channels)
    price_assets = list(pstore.assets)
    price_sessions = [d.isoformat() for d in pstore.sessions]
    benchmark_idx = int(pstore.benchmark_idx)
    macro_columns = list(mstore.columns)
    macro_sessions = [d.isoformat() for d in mstore.sessions]

    macro_df = pd.DataFrame(
        mstore.data.astype(np.float32, copy=False),
        columns=macro_columns,
    )
    macro_df.insert(0, "session", macro_sessions)
    m_path = out_dir / "macro_store.parquet"
    pq.write_table(
        pa.Table.from_pandas(macro_df, preserve_index=False),
        m_path,
        compression="zstd",
        compression_level=6,
    )
    m_sha, m_size = _sha256_file(m_path)
    del macro_df

    if on_progress is not None:
        on_progress("writing_training_bundle", "price_store.bin.zst", 4, 4)
    price_shards = _write_zstd_tensor_shards(
        pstore.data,
        out_dir,
        prefix="price_store",
        target_shard_bytes=price_shard_raw_bytes,
    )
    mat.stores = None
    del pstore, mstore
    gc.collect()
    pa.default_memory_pool().release_unused()

    # 4. Streaming per-group Tier-1 X shards (never materializes full monolithic X in RAM)
    x_parts, n_rows, n_features_tier1, tier1_columns, col_types = (
        _stream_tier1_x_shards(
            ordered_groups,
            anc_frame,
            out_dir,
            x_rows_per_part=x_rows_per_part,
            on_progress=on_progress,
            cancel_check=cancel_check,
        )
    )

    bundle_id = f"tb-v1-{r_sha[:12]}"
    bundle_meta: dict[str, Any] = {
        "schema_version": TRAINING_BUNDLE_SCHEMA_VERSION,
        "bundle_id": bundle_id,
        "dataset_id": str(dataset.id),
        "recipe_sha256": r_sha,
        "anchor_order_sha256": anc_order_sha,
        "sampling": anc_sampling,
        "time_policy": anc_time_policy,
        "horizons": list(horizons),
        "n_rows": int(n_rows),
        "n_features_tier1": n_features_tier1,
        "tier1_columns": tier1_columns,
        "column_types": col_types,
        "label_columns": label_columns,
        "price_shape": price_shape,
        "price_channels": price_channels,
        "price_assets": price_assets,
        "price_sessions": price_sessions,
        "benchmark_idx": benchmark_idx,
        "macro_columns": macro_columns,
        "macro_sessions": macro_sessions,
        "artifacts": {
            "anchors": {
                "filename": "anchors.parquet",
                "sha256": anc_sha,
                "size_bytes": anc_size,
            },
            "x_tier1_parts": x_parts,
            "labels": {
                "filename": "labels.parquet",
                "sha256": y_sha,
                "size_bytes": y_size,
            },
            "macro_store": {
                "filename": "macro_store.parquet",
                "sha256": m_sha,
                "size_bytes": m_size,
            },
            "price_shards": price_shards,
        },
    }
    bundle_json_path = out_dir / "bundle.json"
    bundle_json_path.write_text(
        json.dumps(bundle_meta, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
    )
    b_sha, b_size = _sha256_file(bundle_json_path)
    bundle_meta["bundle_json"] = {
        "filename": "bundle.json",
        "sha256": b_sha,
        "size_bytes": b_size,
    }
    return bundle_meta


# ---------------------------------------------------------------------------
# Streaming prefetch with tqdm.auto progress bar (stdlib fallback if absent)
# ---------------------------------------------------------------------------


class _StdlibProgressBar:
    """Minimal byte progress fallback when `tqdm` is not installed."""

    def __init__(self, total: int, desc: str) -> None:
        self.total = max(1, int(total))
        self.desc = desc
        self.done = 0
        self.postfix = ""
        self._last_print = 0.0

    def set_postfix_str(self, text: str) -> None:
        self.postfix = text

    def update(self, n: int) -> None:
        self.done += int(n)
        now = time.monotonic()
        if now - self._last_print >= 0.5 or self.done >= self.total:
            pct = min(100.0, 100.0 * self.done / self.total)
            mb_done = self.done / (1024 * 1024)
            mb_tot = self.total / (1024 * 1024)
            sys.stderr.write(
                f"\r{self.desc}: {pct:5.1f}% ({mb_done:.1f}/{mb_tot:.1f} MiB) {self.postfix}"
            )
            sys.stderr.flush()
            self._last_print = now

    def close(self) -> None:
        sys.stderr.write("\n")
        sys.stderr.flush()


def _open_progress_bar(total_bytes: int, desc: str) -> Any:
    try:
        from tqdm.auto import tqdm  # type: ignore[import-not-found]

        return tqdm(
            total=total_bytes,
            unit="B",
            unit_scale=True,
            unit_divisor=1024,
            desc=desc,
            leave=True,
        )
    except (ImportError, OSError, RuntimeError):
        return _StdlibProgressBar(total_bytes, desc)


def training_bundle_descriptor(manifest: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """Return the manifest's pre-materialized training bundle descriptor, if present."""
    direct = manifest.get("training_bundle")
    if isinstance(direct, Mapping) and direct.get("bundle_json"):
        return direct
    rr = manifest.get("research_recipe")
    if isinstance(rr, Mapping):
        nested = rr.get("training_bundle")
        if isinstance(nested, Mapping) and nested.get("bundle_json"):
            return nested
    return None


def _bundle_file_items(
    bundle_meta: Mapping[str, Any], key_prefix: str
) -> list[dict[str, Any]]:
    arts = bundle_meta["artifacts"]
    items: list[dict[str, Any]] = []

    def _entry(obj: Mapping[str, Any]) -> dict[str, Any]:
        key = str(obj.get("key") or f"{key_prefix}/{obj['filename']}")
        return {
            "key": key,
            "sha256": str(obj["sha256"]),
            "size_bytes": int(obj["size_bytes"]),
        }

    items.append(_entry(arts["anchors"]))
    for p in arts.get("x_tier1_parts", ()):
        items.append(_entry(p))
    items.append(_entry(arts["labels"]))
    items.append(_entry(arts["macro_store"]))
    for p in arts.get("price_shards", ()):
        items.append(_entry(p))
    return items


def prefetch_training_bundle(
    dataset: Any,
    *,
    progress: bool = True,
) -> dict[str, Any] | None:
    """Download all uncached pre-materialized training shards to local SSD cache with SHA-256 checks."""
    desc = training_bundle_descriptor(dataset.manifest)
    if desc is None:
        return None
    client = dataset._client
    bundle_json_item = desc["bundle_json"]
    bundle_json_path = client._artifact(bundle_json_item)
    bundle_meta = json.loads(bundle_json_path.read_text(encoding="utf-8"))
    key_prefix = str(bundle_json_item["key"]).rsplit("/", 1)[0]
    items = _bundle_file_items(bundle_meta, key_prefix)

    missing: list[dict[str, Any]] = []
    cached_count = 0
    for item in items:
        if hasattr(client, "_artifact_cached") and client._artifact_cached(item):
            cached_count += 1
        else:
            missing.append(item)

    if not missing:
        return {
            "bundle_id": bundle_meta["bundle_id"],
            "shards_total": len(items),
            "shards_cached": cached_count,
            "shards_downloaded": 0,
            "bytes_downloaded": 0,
        }

    total_bytes = sum(int(it["size_bytes"]) for it in missing)
    bar = (
        _open_progress_bar(
            total_bytes, f"research_datasets {str(dataset.id)[:8]} training bundle"
        )
        if progress
        else None
    )
    downloaded_bytes = 0
    try:
        for item in missing:
            short = str(item["key"]).rsplit("/", 1)[-1]
            if bar is not None:
                bar.set_postfix_str(short)

            def _on_chunk(n_bytes: int, _bar: Any = bar) -> None:
                nonlocal downloaded_bytes
                downloaded_bytes += n_bytes
                if _bar is not None:
                    _bar.update(n_bytes)

            client._artifact(item, on_chunk=_on_chunk)
    finally:
        if bar is not None:
            bar.close()

    return {
        "bundle_id": bundle_meta["bundle_id"],
        "shards_total": len(items),
        "shards_cached": cached_count,
        "shards_downloaded": len(missing),
        "bytes_downloaded": downloaded_bytes,
    }


# ---------------------------------------------------------------------------
# Warm RAM Training Bundle & <50 ms Zero-Leakage Tier-2 Slicer + JAX Tensors
# ---------------------------------------------------------------------------


@dataclass
class _LoadedTrainingBundle:
    dataset_id: str
    bundle_id: str
    anchors_df: pd.DataFrame
    sig_ordinals: np.ndarray  # [N] int32, non-decreasing
    asset_idx: np.ndarray  # [N] int32
    session_idx: np.ndarray  # [N] int32
    in_universe: np.ndarray  # [N] bool
    is_benchmark: np.ndarray  # [N] bool
    x_cols_np: dict[str, np.ndarray]  # col -> [N] float32 (excluding ind_ff12_code)
    x_tier1_cols: tuple[str, ...]
    ind_ff12: np.ndarray  # [N] int32 (0..11, 12=unknown)
    col_types: dict[str, list[str]]
    labels_cols_np: dict[str, np.ndarray]  # col -> [N] array
    labels_cols_order: tuple[str, ...]
    horizons: tuple[int, ...]
    label_exit_ords: dict[int, np.ndarray]  # horizon -> [N] int32 (0 if missing)
    price_store: PriceStore
    macro_store: MacroStore
    session_ordinals: np.ndarray  # [T_sessions] int32
    macro_causal_z: dict[
        str, np.ndarray
    ]  # col -> [T_sessions] float32 (strictly causal)
    sparse_csr: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]] = (
        field(default_factory=dict)
    )  # col -> (nz_idx int32, abs_nz float32, sign_nz float32, nz_fit_ok bool)
    binary_prefix: dict[str, tuple[np.ndarray, np.ndarray]] = field(
        default_factory=dict
    )  # col -> (pos_csum int32 [N+1], fin_csum int32 [N+1])
    seq_prefix: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]] = field(
        default_factory=dict
    )  # ch -> (cnt_csum float64 [T+1], s1_csum float64 [T+1], s2_csum float64 [T+1])
    sparse_fit_cache: dict[tuple[str, int], tuple[float, np.ndarray]] = field(
        default_factory=dict, repr=False
    )


def _compute_causal_macro_z(macro_store: MacroStore) -> dict[str, np.ndarray]:
    """Precompute strictly causal expanding Z-score + 4*tanh(z/4) along MacroStore sessions."""
    n_s = macro_store.data.shape[0]
    out: dict[str, np.ndarray] = {}
    if n_s == 0:
        return out
    for c_idx, col_name in enumerate(macro_store.columns):
        raw = macro_store.data[:, c_idx].astype(np.float64)
        fin = np.isfinite(raw)
        vals = np.where(fin, raw, 0.0)
        cnt = np.cumsum(fin.astype(np.float64))
        s1 = np.cumsum(vals)
        s2 = np.cumsum(vals * vals)
        with np.errstate(invalid="ignore", divide="ignore"):
            mean = np.where(cnt >= 21.0, s1 / cnt, np.nan)
            var = np.where(
                cnt >= 21.0,
                np.maximum((s2 - (s1 * s1) / cnt) / (cnt - 1.0), 1e-12),
                np.nan,
            )
            std = np.sqrt(var)
            z = np.where(
                fin & np.isfinite(mean) & (std > 1e-8), (raw - mean) / std, 0.0
            )
        out[str(col_name)] = (4.0 * np.tanh(z / 4.0)).astype(np.float32)
    return out


def _extract_exit_ordinals(
    labels_df: pd.DataFrame, horizons: Sequence[int]
) -> dict[int, np.ndarray]:
    n = len(labels_df)
    out: dict[int, np.ndarray] = {}
    for h in horizons:
        h_i = int(h)
        ec = f"h{h_i}_exit_session"
        arr = np.zeros(n, dtype=np.int32)
        if ec in labels_df.columns:
            raw_vals = labels_df[ec].tolist()
            for i, v in enumerate(raw_vals):
                if v is not None and v != "" and pd.notna(v):
                    try:
                        arr[i] = clocks.day(v).toordinal()
                    except (TypeError, ValueError):
                        arr[i] = 0
        out[h_i] = arr
    return out


def load_training_bundle(
    dataset: Any,
    *,
    progress: bool = True,
    recipe_yaml: str | Mapping[str, Any] | None = None,
) -> _LoadedTrainingBundle:
    """Load pre-materialized server training shards (or local materialize fallback) into RAM."""
    desc = training_bundle_descriptor(dataset.manifest)
    if desc is not None and recipe_yaml is None:
        prefetch_training_bundle(dataset, progress=progress)
        client = dataset._client
        b_path = client._artifact(desc["bundle_json"])
        meta = json.loads(b_path.read_text(encoding="utf-8"))
        key_prefix = str(desc["bundle_json"]["key"]).rsplit("/", 1)[0]
        arts = meta["artifacts"]

        def _get_path(obj: Mapping[str, Any]) -> Path:
            item = {
                "key": str(obj.get("key") or f"{key_prefix}/{obj['filename']}"),
                "sha256": str(obj["sha256"]),
                "size_bytes": int(obj["size_bytes"]),
            }
            return client._artifact(item)

        anc_df = pd.read_parquet(_get_path(arts["anchors"]))
        anc_df["signal_session"] = pd.Series(
            [clocks.day(v) for v in anc_df["signal_session"]],
            index=anc_df.index,
            dtype=object,
        )
        anc_df["entry_session"] = pd.Series(
            [
                clocks.day(v) if isinstance(v, str) and v else None
                for v in anc_df["entry_session"]
            ],
            index=anc_df.index,
            dtype=object,
        )
        anc_df["decision_at"] = pd.to_datetime(anc_df["decision_at"], utc=True)

        x_frames = [
            pd.read_parquet(_get_path(p)) for p in arts.get("x_tier1_parts", ())
        ]
        x_df = pd.concat(x_frames, ignore_index=True) if x_frames else pd.DataFrame()
        labels_df = pd.read_parquet(_get_path(arts["labels"]))
        if "signal_session" in labels_df.columns:
            labels_df["signal_session"] = pd.Series(
                [clocks.day(v) for v in labels_df["signal_session"]],
                index=labels_df.index,
                dtype=object,
            )

        macro_df = pd.read_parquet(_get_path(arts["macro_store"]))
        m_sessions = [clocks.day(d) for d in macro_df["session"].tolist()]
        m_cols = [c for c in macro_df.columns if c != "session"]
        m_arr = (
            macro_df[m_cols].to_numpy(dtype=np.float32, copy=True)
            if m_cols
            else np.empty((len(m_sessions), 0), dtype=np.float32)
        )
        macro_store = MacroStore(
            m_arr,
            columns=m_cols,
            sessions=m_sessions,
            time_policy=str(meta["time_policy"]),
        )

        p_shard_paths = [(_get_path(p), p) for p in arts.get("price_shards", ())]
        p_arr = _read_zstd_tensor_shards(p_shard_paths, meta["price_shape"])
        p_sessions = [clocks.day(d) for d in meta["price_sessions"]]
        price_store = PriceStore(
            p_arr,
            assets=meta["price_assets"],
            sessions=p_sessions,
            benchmark_idx=int(meta.get("benchmark_idx", -1)),
            channels=meta.get("price_channels", PRICE_CHANNELS),
        )
        horizons = tuple(int(h) for h in meta["horizons"])
        col_types = {k: list(v) for k, v in meta["column_types"].items()}
        bundle_id = str(meta["bundle_id"])
    else:
        # Fallback for datasets without server pre-materialized bundles or custom recipes.
        eff_bench: str | None = "SPY"
        try:
            dataset.resolve(eff_bench)
        except (DatasetError, KeyError, ValueError):
            eff_bench = None
        mat: MaterializedDataset = materialize(
            dataset,
            recipe_yaml=recipe_yaml,
            benchmark=eff_bench,
            include_stores=True,
            include_labels=True,
        )
        assert mat.stores is not None and mat.y is not None
        anc_df = mat.anchors.frame.copy()
        x_df, col_types = build_tier1_features(mat.X, anc_df)
        horizons = tuple(
            int(h)
            for h in mat.recipe.get("horizons_trading_days", DEFAULT_JAX_HORIZONS)
        )
        labels_df = _compact_labels_frame(mat.y, horizons)
        labels_df["signal_session"] = pd.Series(
            [clocks.day(v) for v in labels_df["signal_session"]],
            index=labels_df.index,
            dtype=object,
        )
        price_store = mat.stores.prices
        macro_store = mat.stores.macro
        bundle_id = f"local-{mat.recipe_sha256[:12]}"

    sig_ords = np.array(
        [clocks.day(d).toordinal() for d in anc_df["signal_session"]], dtype=np.int32
    )
    a_idx = anc_df["asset_idx"].to_numpy(dtype=np.int32, copy=True)
    # Sort once by (signal_session, asset_idx) so Tier-2 <= as_of / <= fit_end slicing is O(1) contiguous!
    if len(sig_ords) > 1 and not bool(np.all(sig_ords[1:] >= sig_ords[:-1])):
        order = np.lexsort((a_idx, sig_ords))
        anc_df = anc_df.iloc[order].reset_index(drop=True)
        x_df = x_df.iloc[order].reset_index(drop=True)
        labels_df = labels_df.iloc[order].reset_index(drop=True)
        sig_ords = sig_ords[order]
        a_idx = a_idx[order]

    if "ind_ff12_code" in x_df.columns:
        raw_ind = pd.to_numeric(x_df["ind_ff12_code"], errors="coerce").to_numpy(
            dtype=np.float64
        )
        ind_ff12 = np.where(
            np.isfinite(raw_ind) & (raw_ind >= 0) & (raw_ind < 12),
            raw_ind.astype(np.int32),
            12,
        )
    else:
        ind_ff12 = np.full(len(anc_df), 12, dtype=np.int32)

    feat_cols = tuple(c for c in x_df.columns if c != "ind_ff12_code")
    tier1_set = set(col_types.get("tier1_a1", ())) | set(col_types.get("tier1_a2", ()))
    bin_set = set(col_types.get("tier2_c_binary", ()))
    sparse_set = set(col_types.get("tier2_c_sparse", ()))
    macro_set = set(col_types.get("tier2_d_macro", ()))

    si_all = anc_df["session_idx"].to_numpy(dtype=np.int32, copy=True)
    in_uni_all = anc_df["in_universe"].fillna(True).to_numpy(dtype=bool, copy=True)
    is_bench_all = anc_df["is_benchmark"].fillna(False).to_numpy(dtype=bool, copy=True)
    fit_ok_all = in_uni_all & (~is_bench_all)
    macro_causal_z = _compute_causal_macro_z(macro_store)
    n_macro = macro_store.data.shape[0]
    ok_s_all = (si_all >= 0) & (si_all < n_macro) if n_macro > 0 else None
    ok_s_any = bool(ok_s_all.any()) if ok_s_all is not None else False

    x_cols_np: dict[str, np.ndarray] = {}
    sparse_csr: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]] = {}
    binary_prefix: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    n_all = len(anc_df)
    for col in feat_cols:
        arr = np.ascontiguousarray(x_df[col].to_numpy(dtype=np.float32, copy=True))
        if col in tier1_set:
            np.nan_to_num(arr, copy=False, nan=0.0, posinf=4.0, neginf=-4.0)
            x_cols_np[col] = arr
        elif col in macro_set:
            # Strictly causal expanding Z-score depends only on <= t: precompute once for 0-copy slicing
            cz = macro_causal_z.get(col)
            if cz is not None and ok_s_all is not None:
                out_m = np.zeros(n_all, dtype=np.float32)
                if ok_s_any:
                    out_m[ok_s_all] = cz[si_all[ok_s_all]]
                x_cols_np[col] = out_m
            else:
                np.nan_to_num(arr, copy=False, nan=0.0, posinf=4.0, neginf=-4.0)
                x_cols_np[col] = arr
        elif col in bin_set:
            fin_fit = np.isfinite(arr) & fit_ok_all
            pos_fit = fin_fit & (arr > 0.5)
            pos_csum = np.zeros(n_all + 1, dtype=np.int32)
            fin_csum = np.zeros(n_all + 1, dtype=np.int32)
            np.cumsum(pos_fit, dtype=np.int32, out=pos_csum[1:])
            np.cumsum(fin_fit, dtype=np.int32, out=fin_csum[1:])
            binary_prefix[col] = (pos_csum, fin_csum)
            np.nan_to_num(arr, copy=False, nan=0.0, posinf=1.0, neginf=0.0)
            x_cols_np[col] = arr
        elif col in sparse_set:
            x_cols_np[col] = arr
            nz_mask = np.isfinite(arr) & (arr != 0.0)
            nz_idx = np.flatnonzero(nz_mask).astype(np.int32)
            nz_v = np.ascontiguousarray(arr[nz_idx], dtype=np.float32)
            sparse_csr[col] = (
                nz_idx,
                np.ascontiguousarray(np.abs(nz_v), dtype=np.float32),
                np.ascontiguousarray(np.sign(nz_v), dtype=np.float32),
                np.ascontiguousarray(fit_ok_all[nz_idx], dtype=bool),
            )
        else:
            np.nan_to_num(arr, copy=False, nan=0.0, posinf=4.0, neginf=-4.0)
            x_cols_np[col] = arr

    labels_cols_order = tuple(str(c) for c in labels_df.columns)
    labels_cols_np: dict[str, np.ndarray] = {}
    for col in labels_cols_order:
        ser = labels_df[col]
        if col.startswith("trainable_"):
            labels_cols_np[col] = np.ascontiguousarray(
                ser.fillna(False).to_numpy(dtype=bool, copy=True)
            )
        elif pd.api.types.is_float_dtype(ser.dtype):
            labels_cols_np[col] = np.ascontiguousarray(
                ser.to_numpy(dtype=np.float32, copy=True)
            )
        else:
            labels_cols_np[col] = ser.to_numpy(copy=True)

    sess_ords = np.array([d.toordinal() for d in price_store.sessions], dtype=np.int32)
    seq_prefix: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]] = {}
    if price_store.data.shape[0] > 0 and price_store.data.shape[1] > 0:
        n_t = price_store.data.shape[1]
        inv_ch = price_store._channel_pos["bar_invalid"]
        inv_all = price_store.data[:, :, inv_ch]
        good_all = (~np.isfinite(inv_all)) | (inv_all <= 0.5)
        for cname in SEQ_PRICE_CHANNELS:
            ch_i = price_store._channel_pos[cname]
            vals = price_store.data[:, :, ch_i]
            ok = good_all & np.isfinite(vals)
            v64 = np.where(ok, vals, 0.0).astype(np.float64)
            cnt_c = np.zeros(n_t + 1, dtype=np.float64)
            s1_c = np.zeros(n_t + 1, dtype=np.float64)
            s2_c = np.zeros(n_t + 1, dtype=np.float64)
            np.cumsum(ok.sum(axis=0, dtype=np.float64), out=cnt_c[1:])
            np.cumsum(v64.sum(axis=0, dtype=np.float64), out=s1_c[1:])
            np.cumsum((v64 * v64).sum(axis=0, dtype=np.float64), out=s2_c[1:])
            seq_prefix[cname] = (cnt_c, s1_c, s2_c)
    return _LoadedTrainingBundle(
        dataset_id=str(dataset.id),
        bundle_id=bundle_id,
        anchors_df=anc_df,
        sig_ordinals=sig_ords,
        asset_idx=a_idx,
        session_idx=si_all,
        in_universe=in_uni_all,
        is_benchmark=is_bench_all,
        x_cols_np=x_cols_np,
        x_tier1_cols=feat_cols,
        ind_ff12=ind_ff12,
        col_types=col_types,
        labels_cols_np=labels_cols_np,
        labels_cols_order=labels_cols_order,
        horizons=horizons,
        label_exit_ords=_extract_exit_ordinals(labels_df, horizons),
        price_store=price_store,
        macro_store=macro_store,
        session_ordinals=sess_ords,
        macro_causal_z=macro_causal_z,
        sparse_csr=sparse_csr,
        binary_prefix=binary_prefix,
        seq_prefix=seq_prefix,
    )


@dataclass
class JaxTrainingBatch:
    """Static TPU-MXU-aligned tensor view (default ``pad_to=1280``, multiple of 128)."""

    x_tab: Any  # [T_weeks, pad_to, D_tab] float32
    ind_id: Any  # [T_weeks, pad_to] int32
    valid_mask: Any  # [T_weeks, pad_to] bool
    y_ret: Any  # [T_weeks, pad_to, H] float32
    trainable_mask: Any  # [T_weeks, pad_to, H] bool
    y_risk: Any  # [T_weeks, pad_to, 4] float32
    risk_mask: Any  # [T_weeks, pad_to, 4] bool
    asset_idx: Any  # [T_weeks, pad_to] int32
    session_idx: Any  # [T_weeks] int32
    signal_sessions: tuple[date, ...]
    feature_names: tuple[str, ...]
    horizons: tuple[int, ...]
    pad_to: int
    _price_store: PriceStore | None = field(default=None, repr=False)
    _seq_stats: Mapping[str, tuple[float, float]] = field(
        default_factory=dict, repr=False
    )

    def seq_window_batch(
        self,
        week_indices: Sequence[int] | np.ndarray,
        *,
        window: int = 250,
        as_jax: bool = False,
    ) -> dict[str, Any]:
        """Extract causal ``[B, pad_to, window, 7]`` sequence tensor (6 channels + bar_invalid)."""
        if self._price_store is None:
            raise ValueError("PriceStore is unavailable on this training view")
        w_idx = np.asarray(week_indices, dtype=np.int64)
        b_size = len(w_idx)
        n_ch = len(SEQ_PRICE_CHANNELS) + 1
        out = np.zeros((b_size, self.pad_to, int(window), n_ch), dtype=np.float32)
        p_data = self._price_store.data
        ch_indices = [self._price_store._channel_pos[c] for c in SEQ_PRICE_CHANNELS]
        inv_ch = self._price_store._channel_pos["bar_invalid"]
        means = np.array(
            [self._seq_stats.get(c, (0.0, 1.0))[0] for c in SEQ_PRICE_CHANNELS],
            dtype=np.float32,
        )
        stds = np.array(
            [
                max(self._seq_stats.get(c, (0.0, 1.0))[1], 1e-6)
                for c in SEQ_PRICE_CHANNELS
            ],
            dtype=np.float32,
        )

        a_mat = np.asarray(self.asset_idx)
        s_vec = np.asarray(self.session_idx)
        v_mat = np.asarray(self.valid_mask)
        for bi, wi in enumerate(w_idx.tolist()):
            s_end = int(s_vec[wi])
            s_lo = max(0, s_end - int(window) + 1)
            seg_len = s_end - s_lo + 1
            pad_left = int(window) - seg_len
            active = np.flatnonzero(v_mat[wi])
            if not len(active) or seg_len <= 0:
                continue
            a_ids = a_mat[wi, active]
            ok = (a_ids >= 0) & (a_ids < p_data.shape[0])
            if not ok.any():
                continue
            act_ok = active[ok]
            a_ok = a_ids[ok]
            raw_seg = p_data[a_ok, s_lo : s_end + 1, :][:, :, ch_indices].astype(
                np.float32, copy=False
            )
            inv_seg = p_data[a_ok, s_lo : s_end + 1, inv_ch].astype(
                np.float32, copy=False
            )
            bad = (~np.isfinite(inv_seg)) | (inv_seg > 0.5)
            norm_seg = (raw_seg - means[None, None, :]) / stds[None, None, :]
            norm_seg = np.where(
                np.isfinite(norm_seg) & (~bad[:, :, None]), norm_seg, 0.0
            )
            norm_seg = np.clip(norm_seg, -8.0, 8.0)
            out[bi, act_ok, pad_left:, : len(SEQ_PRICE_CHANNELS)] = norm_seg
            out[bi, act_ok, pad_left:, len(SEQ_PRICE_CHANNELS)] = bad.astype(np.float32)

        result: dict[str, Any] = {
            "x_seq": out,
            "valid_mask": np.asarray(self.valid_mask)[w_idx],
            "session_idx": s_vec[w_idx],
        }
        if as_jax:
            import jax.numpy as jnp  # type: ignore[import-not-found]

            return {k: jnp.asarray(v) for k, v in result.items()}
        return result


@dataclass
class TrainingView:
    """Zero-leakage, cutoff-truncated, Tier-2-scaled training view (< 50 ms RAM slice)."""

    dataset_id: str
    bundle_id: str
    as_of: date
    fit_end: date
    pad_to: int
    anchors: pd.DataFrame
    X: pd.DataFrame
    y: pd.DataFrame
    ind_ff12: np.ndarray
    horizons: tuple[int, ...]
    column_types: dict[str, list[str]]
    transform_state: dict[str, Any]
    price_store: PriceStore | None
    macro_store: MacroStore | None
    _x_cols_np: dict[str, np.ndarray] = field(repr=False)
    _x_cols_order: tuple[str, ...] = field(repr=False)
    _jax_cache: dict[tuple[Any, ...], JaxTrainingBatch] = field(
        default_factory=dict, repr=False
    )

    def to_jax(
        self,
        *,
        pad_to: int | None = None,
        horizons: Sequence[int] | None = None,
        as_jax: bool = False,
    ) -> JaxTrainingBatch:
        """Pack static TPU-MXU-aligned ``[T_weeks, pad_to, ...]`` tensors."""
        eff_pad = int(self.pad_to if pad_to is None else pad_to)
        if eff_pad <= 0:
            raise ValueError("pad_to must be positive")
        eff_h = tuple(
            int(h)
            for h in (
                horizons
                if horizons is not None
                else [h for h in DEFAULT_JAX_HORIZONS if h in self.horizons]
                or list(self.horizons)
            )
        )
        cache_key = (eff_pad, eff_h, bool(as_jax))
        if cache_key in self._jax_cache:
            return self._jax_cache[cache_key]

        af = self.anchors
        in_uni = af["in_universe"].fillna(True).to_numpy(dtype=bool)
        is_bench = af["is_benchmark"].fillna(False).to_numpy(dtype=bool)
        keep = in_uni & ~is_bench
        keep_idx = np.flatnonzero(keep)

        d_tab = len(self._x_cols_order)
        n_h = len(eff_h)
        if len(keep_idx) == 0:
            empty_batch = JaxTrainingBatch(
                x_tab=np.zeros((0, eff_pad, d_tab), dtype=np.float32),
                ind_id=np.full((0, eff_pad), 12, dtype=np.int32),
                valid_mask=np.zeros((0, eff_pad), dtype=bool),
                y_ret=np.zeros((0, eff_pad, n_h), dtype=np.float32),
                trainable_mask=np.zeros((0, eff_pad, n_h), dtype=bool),
                y_risk=np.zeros((0, eff_pad, 4), dtype=np.float32),
                risk_mask=np.zeros((0, eff_pad, 4), dtype=bool),
                asset_idx=np.full((0, eff_pad), -1, dtype=np.int32),
                session_idx=np.zeros(0, dtype=np.int32),
                signal_sessions=(),
                feature_names=self._x_cols_order,
                horizons=eff_h,
                pad_to=eff_pad,
                _price_store=self.price_store,
                _seq_stats=self.transform_state.get("seq_stats", {}),
            )
            self._jax_cache[cache_key] = empty_batch
            return empty_batch

        si_all = af["session_idx"].to_numpy(dtype=np.int32, copy=False)[keep_idx]
        ai_all = af["asset_idx"].to_numpy(dtype=np.int32, copy=False)[keep_idx]
        sig_days_all = af["signal_session"].to_numpy(dtype=object)[keep_idx]

        order = np.lexsort((ai_all, si_all))
        rows_ord = keep_idx[order]
        si_ord = si_all[order]
        ai_ord = ai_all[order]
        sig_ord = sig_days_all[order]

        diffs = np.flatnonzero(np.diff(si_ord)) + 1
        starts = np.concatenate(([0], diffs))
        ends = np.concatenate((diffs, [len(rows_ord)]))
        t_weeks = len(starts)
        max_w = int(np.max(ends - starts))
        if max_w > eff_pad:
            raise ValueError(
                f"Cross-section size {max_w} exceeds pad_to={eff_pad}; pass a larger pad_to (e.g. {((max_w + 127) // 128) * 128})."
            )

        x_tab = np.zeros((t_weeks, eff_pad, d_tab), dtype=np.float32)
        ind_id = np.full((t_weeks, eff_pad), 12, dtype=np.int32)
        valid_mask = np.zeros((t_weeks, eff_pad), dtype=bool)
        y_ret = np.zeros((t_weeks, eff_pad, n_h), dtype=np.float32)
        trainable_mask = np.zeros((t_weeks, eff_pad, n_h), dtype=bool)
        y_risk = np.zeros((t_weeks, eff_pad, 4), dtype=np.float32)
        risk_mask = np.zeros((t_weeks, eff_pad, 4), dtype=bool)
        asset_mat = np.full((t_weeks, eff_pad), -1, dtype=np.int32)
        sess_vec = np.zeros(t_weeks, dtype=np.int32)
        sig_sessions: list[date] = []

        # Pre-extract target arrays once across all kept rows
        y_gr_cols = []
        y_tr_cols = []
        for h in eff_h:
            gr_c = f"h{h}_gauss_rank"
            tr_c = f"trainable_{h}d"
            gr_v = (
                pd.to_numeric(self.y[gr_c], errors="coerce").to_numpy(dtype=np.float32)
                if gr_c in self.y.columns
                else np.full(len(self.y), np.nan, dtype=np.float32)
            )
            tr_v = (
                self.y[tr_c].fillna(False).to_numpy(dtype=bool)
                if tr_c in self.y.columns
                else np.zeros(len(self.y), dtype=bool)
            )
            y_gr_cols.append(gr_v)
            y_tr_cols.append(tr_v & np.isfinite(gr_v))

        risk_specs = (
            ("h21_fwd_rvol", True),
            ("h63_fwd_rvol", True),
            ("h21_fwd_rel_dvol", False),
            ("h63_fwd_rel_dvol", False),
        )
        risk_vals_all = np.zeros((len(self.y), 4), dtype=np.float32)
        risk_ok_all = np.zeros((len(self.y), 4), dtype=bool)
        for r_i, (r_col, use_log) in enumerate(risk_specs):
            if r_col not in self.y.columns:
                continue
            rv = pd.to_numeric(self.y[r_col], errors="coerce").to_numpy(
                dtype=np.float64
            )
            if use_log:
                ok = np.isfinite(rv) & (rv > 1e-8)
                risk_vals_all[ok, r_i] = np.log(rv[ok]).astype(np.float32)
                risk_ok_all[:, r_i] = ok
            else:
                ok = np.isfinite(rv)
                risk_vals_all[ok, r_i] = rv[ok].astype(np.float32)
                risk_ok_all[:, r_i] = ok

        # Vectorized scatter indices: week_id[k], slot_id[k] for every kept row k
        w_lens = ends - starts
        w_ids = np.repeat(np.arange(t_weeks, dtype=np.int64), w_lens)
        slot_ids = np.arange(len(rows_ord), dtype=np.int64) - np.repeat(starts, w_lens)
        for c_i, col in enumerate(self._x_cols_order):
            x_tab[w_ids, slot_ids, c_i] = self._x_cols_np[col][rows_ord]
        ind_id[w_ids, slot_ids] = self.ind_ff12[rows_ord]
        valid_mask[w_ids, slot_ids] = True
        asset_mat[w_ids, slot_ids] = ai_ord
        for h_i in range(n_h):
            tm = y_tr_cols[h_i][rows_ord]
            gv = y_gr_cols[h_i][rows_ord]
            trainable_mask[w_ids, slot_ids, h_i] = tm
            y_ret[w_ids, slot_ids, h_i] = np.where(tm, gv, 0.0)
        rk_ok = risk_ok_all[rows_ord]
        risk_mask[w_ids, slot_ids, :] = rk_ok
        y_risk[w_ids, slot_ids, :] = np.where(rk_ok, risk_vals_all[rows_ord], 0.0)
        sess_vec = si_ord[starts].astype(np.int32, copy=False)
        sig_sessions = [clocks.day(sig_ord[int(s0)]) for s0 in starts]

        if as_jax:
            import jax.numpy as jnp  # type: ignore[import-not-found]

            batch = JaxTrainingBatch(
                x_tab=jnp.asarray(x_tab),
                ind_id=jnp.asarray(ind_id),
                valid_mask=jnp.asarray(valid_mask),
                y_ret=jnp.asarray(y_ret),
                trainable_mask=jnp.asarray(trainable_mask),
                y_risk=jnp.asarray(y_risk),
                risk_mask=jnp.asarray(risk_mask),
                asset_idx=jnp.asarray(asset_mat),
                session_idx=jnp.asarray(sess_vec),
                signal_sessions=tuple(sig_sessions),
                feature_names=tuple(self.X.columns),
                horizons=eff_h,
                pad_to=eff_pad,
                _price_store=self.price_store,
                _seq_stats=self.transform_state.get("seq_stats", {}),
            )
        else:
            batch = JaxTrainingBatch(
                x_tab=x_tab,
                ind_id=ind_id,
                valid_mask=valid_mask,
                y_ret=y_ret,
                trainable_mask=trainable_mask,
                y_risk=y_risk,
                risk_mask=risk_mask,
                asset_idx=asset_mat,
                session_idx=sess_vec,
                signal_sessions=tuple(sig_sessions),
                feature_names=tuple(self.X.columns),
                horizons=eff_h,
                pad_to=eff_pad,
                _price_store=self.price_store,
                _seq_stats=self.transform_state.get("seq_stats", {}),
            )
        self._jax_cache[cache_key] = batch
        return batch

    @property
    def jax(self) -> JaxTrainingBatch:
        return self.to_jax(pad_to=self.pad_to, as_jax=False)


def slice_training_view(
    loaded: _LoadedTrainingBundle,
    *,
    as_of: str | date | None = None,
    fit_end: str | date | None = None,
    pad_to: int = DEFAULT_PAD_TO,
    include_stores: bool = True,
) -> TrainingView:
    """Execute Tier-2 causal slicing & <= fit_end fitting purely in RAM (< 50 ms)."""
    max_sess_d = (
        loaded.price_store.sessions[-1]
        if loaded.price_store.sessions
        else date(1970, 1, 1)
    )
    as_of_d = clocks.day(as_of) if as_of is not None else max_sess_d
    fit_end_d = clocks.day(fit_end) if fit_end is not None else as_of_d
    if fit_end_d > as_of_d:
        raise ValueError(
            f"LEAKAGE_GUARD: fit_end ({fit_end_d}) cannot exceed as_of ({as_of_d})"
        )

    as_of_ord = as_of_d.toordinal()
    fit_end_ord = fit_end_d.toordinal()

    # 1. Hard <= as_of O(1) contiguous prefix cutoff (bundle is sorted by signal_session)
    n_cut = int(np.searchsorted(loaded.sig_ordinals, as_of_ord, side="right"))
    n_fit = int(np.searchsorted(loaded.sig_ordinals, fit_end_ord, side="right"))
    max_s_idx = (
        int(np.searchsorted(loaded.session_ordinals, as_of_ord, side="right")) - 1
    )
    fit_s_idx = (
        int(np.searchsorted(loaded.session_ordinals, fit_end_ord, side="right")) - 1
    )

    anc_cut = loaded.anchors_df.iloc[:n_cut]
    ind_cut = loaded.ind_ff12[:n_cut]
    si_cut = loaded.session_idx[:n_cut]
    fit_valid = loaded.in_universe[:n_fit] & (~loaded.is_benchmark[:n_fit])

    # 2. Tier-2 split-aware scaling strictly fitted on <= fit_end;
    # Tier-1 A1/A2, binary, and causal macro columns are zero-copy contiguous views!
    x_out_cols: dict[str, np.ndarray] = {
        col: loaded.x_cols_np[col][:n_cut] for col in loaded.x_tier1_cols
    }
    sparse_scales: dict[str, float] = {}
    n_total = len(loaded.sig_ordinals)
    for col in loaded.col_types.get("tier2_c_sparse", ()):
        if col not in x_out_cols:
            continue
        csr = loaded.sparse_csr.get(col)
        if csr is not None:
            cache_k = (col, n_fit)
            cached_sp = loaded.sparse_fit_cache.get(cache_k)
            if cached_sp is not None:
                scale, full_scaled = cached_sp
                sparse_scales[col] = scale
                x_out_cols[col] = full_scaled[:n_cut]
                continue
            nz_idx, abs_nz, sign_nz, nz_fit_ok = csr
            k_fit = int(np.searchsorted(nz_idx, n_fit, side="left"))
            if k_fit > 0:
                fit_abs = abs_nz[:k_fit][nz_fit_ok[:k_fit]]
                if len(fit_abs) > 8192:
                    stride = len(fit_abs) // 8192
                    scale = float(np.median(fit_abs[::stride]))
                elif len(fit_abs) > 0:
                    scale = float(np.median(fit_abs))
                else:
                    scale = 1.0
            else:
                scale = 1.0
            if not math.isfinite(scale) or scale <= 1e-8:
                scale = 1.0
            sparse_scales[col] = scale
            inv_s = np.float32(1.0 / scale)
            full_scaled = np.zeros(n_total, dtype=np.float32)
            if len(nz_idx) > 0:
                buf = abs_nz * inv_s
                np.log1p(buf, out=buf)
                buf *= sign_nz
                buf *= np.float32(0.25)
                np.tanh(buf, out=buf)
                buf *= np.float32(4.0)
                full_scaled[nz_idx] = buf
            if len(loaded.sparse_fit_cache) > 512:
                loaded.sparse_fit_cache.clear()
            loaded.sparse_fit_cache[cache_k] = (scale, full_scaled)
            x_out_cols[col] = full_scaled[:n_cut]
        else:
            vals = loaded.x_cols_np[col][:n_cut]
            fit_v = vals[:n_fit][fit_valid]
            nz = np.abs(fit_v[np.isfinite(fit_v) & (fit_v != 0.0)])
            scale = float(np.median(nz)) if len(nz) > 0 else 1.0
            if not math.isfinite(scale) or scale <= 1e-8:
                scale = 1.0
            sparse_scales[col] = scale
            fin = np.isfinite(vals)
            scaled = np.zeros(n_cut, dtype=np.float32)
            if fin.any():
                vf = vals[fin]
                inv_s = np.float32(1.0 / scale)
                scaled[fin] = np.float32(4.0) * np.tanh(
                    (np.sign(vf) * np.log1p(np.abs(vf) * inv_s)) * np.float32(0.25)
                )
            x_out_cols[col] = scaled

    binary_rates: dict[str, float] = {}
    for col in loaded.col_types.get("tier2_c_binary", ()):
        if col not in x_out_cols:
            continue
        pref = loaded.binary_prefix.get(col)
        if pref is not None:
            pos_csum, fin_csum = pref
            denom = int(fin_csum[n_fit])
            binary_rates[col] = float(pos_csum[n_fit]) / denom if denom > 0 else 0.0
        else:
            vals = loaded.x_cols_np[col][:n_cut]
            fit_v = vals[:n_fit][fit_valid]
            fin_fit = fit_v[np.isfinite(fit_v)]
            binary_rates[col] = float(np.mean(fin_fit > 0.5)) if len(fin_fit) else 0.0

    # 3. Per-horizon label maturity masking: exit_session_H <= as_of AND session_idx + H <= max_s_idx
    y_out_cols: dict[str, np.ndarray] = {
        col: loaded.labels_cols_np[col][:n_cut] for col in loaded.labels_cols_order
    }
    for h in loaded.horizons:
        h_i = int(h)
        exit_ords = loaded.label_exit_ords[h_i][:n_cut]
        mature = (si_cut + h_i) <= max_s_idx
        has_exit = exit_ords > 0
        mature = mature & (~has_exit | (exit_ords <= as_of_ord))
        if not np.all(mature):
            immature = ~mature
            tr_col = f"trainable_{h_i}d"
            if tr_col in y_out_cols:
                tr_arr = y_out_cols[tr_col].copy()
                tr_arr[immature] = False
                y_out_cols[tr_col] = tr_arr
            for target_col in (
                f"h{h_i}_asset_return",
                f"h{h_i}_benchmark_return",
                f"forward_excess_return_{h_i}d",
                f"h{h_i}_beta_adj_return",
                f"h{h_i}_ir_return",
                f"h{h_i}_gauss_rank",
                f"h{h_i}_fwd_rvol",
                f"h{h_i}_fwd_max_dd",
                f"h{h_i}_fwd_rel_dvol",
            ):
                if target_col in y_out_cols:
                    col_arr = y_out_cols[target_col].copy()
                    col_arr[immature] = np.nan
                    y_out_cols[target_col] = col_arr
    y_cut = pd.DataFrame(y_out_cols, copy=False)

    # 4. Zero-copy cutoff-truncated PriceStore & MacroStore views + <= fit_end seq stats
    p_cut: PriceStore | None = None
    m_cut: MacroStore | None = None
    seq_stats: dict[str, tuple[float, float]] = {}
    if include_stores:
        s_stop = max(0, max_s_idx + 1)
        p_cut = PriceStore(
            loaded.price_store.data[:, :s_stop, :],
            assets=loaded.price_store.assets,
            sessions=loaded.price_store.sessions[:s_stop],
            benchmark_idx=loaded.price_store.benchmark_idx,
            channels=loaded.price_store.channels,
        )
        m_stop = min(s_stop, loaded.macro_store.data.shape[0])
        m_cut = MacroStore(
            loaded.macro_store.data[:m_stop, :],
            columns=loaded.macro_store.columns,
            sessions=loaded.macro_store.sessions[:m_stop],
            time_policy=loaded.macro_store.time_policy,
        )
        f_stop = max(0, min(fit_s_idx + 1, p_cut.data.shape[1]))
        if f_stop > 0 and loaded.seq_prefix:
            for cname in SEQ_PRICE_CHANNELS:
                pref = loaded.seq_prefix.get(cname)
                if pref is not None:
                    cnt_c, s1_c, s2_c = pref
                    cnt = float(cnt_c[f_stop])
                    if cnt > 0.0:
                        mu = float(s1_c[f_stop]) / cnt
                        var = max(0.0, float(s2_c[f_stop]) / cnt - mu * mu)
                        sd = math.sqrt(var)
                        seq_stats[cname] = (mu, sd if sd > 1e-6 else 1.0)
                    else:
                        seq_stats[cname] = (0.0, 1.0)
                else:
                    seq_stats[cname] = (0.0, 1.0)
        elif f_stop > 0:
            a_step = max(1, p_cut.data.shape[0] // 512)
            s_step = max(1, f_stop // 512)
            inv_ch = p_cut._channel_pos["bar_invalid"]
            inv_sub = p_cut.data[::a_step, :f_stop:s_step, inv_ch]
            good_mask = (~np.isfinite(inv_sub)) | (inv_sub <= 0.5)
            for cname in SEQ_PRICE_CHANNELS:
                ch_i = p_cut._channel_pos[cname]
                vals = p_cut.data[::a_step, :f_stop:s_step, ch_i]
                ok = good_mask & np.isfinite(vals)
                if ok.any():
                    sub = vals[ok].astype(np.float64)
                    mu = float(np.mean(sub))
                    sd = float(np.std(sub))
                    seq_stats[cname] = (mu, sd if sd > 1e-6 else 1.0)
                else:
                    seq_stats[cname] = (0.0, 1.0)

    x_frame = pd.DataFrame(x_out_cols, copy=False)
    transform_state = {
        "as_of": as_of_d.isoformat(),
        "fit_end": fit_end_d.isoformat(),
        "sparse_scales": sparse_scales,
        "binary_rates": binary_rates,
        "seq_stats": seq_stats,
        "max_session_idx": max_s_idx,
        "fit_session_idx": fit_s_idx,
    }
    return TrainingView(
        dataset_id=loaded.dataset_id,
        bundle_id=loaded.bundle_id,
        as_of=as_of_d,
        fit_end=fit_end_d,
        pad_to=int(pad_to),
        anchors=anc_cut,
        X=x_frame,
        y=y_cut,
        ind_ff12=ind_cut,
        horizons=loaded.horizons,
        column_types=loaded.col_types,
        transform_state=transform_state,
        price_store=p_cut,
        macro_store=m_cut,
        _x_cols_np=x_out_cols,
        _x_cols_order=loaded.x_tier1_cols,
    )
