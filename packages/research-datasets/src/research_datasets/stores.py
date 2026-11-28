"""Untruncated multi-clock sequence and array stores for materialized datasets."""

from __future__ import annotations

import hashlib
import json
import math
from bisect import bisect_right
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from . import candidates as _candidates
from . import clocks
from . import fundamentals_derived as _fund
from . import sec_events as _sec_events
from .clocks import NAT, NEVER
from .concepts import required_base_concepts
from .constants import REFERENCE_ETFS, SOURCE_CONTRACTS
from .extra_features import (
    _prepare_reference_series,
    _series_snapshot_at,
)
from .extra_features import (
    market_etf_features as _market_etf_features,
)
from .extra_features import (
    reference_features as _reference_features,
)
from .price_reader import projected_prices as _project_prices
from .release_features import default_extractor_version as _default_extractor_version

PRICE_CHANNELS: tuple[str, ...] = (
    "open_raw",
    "high_raw",
    "low_raw",
    "close_raw",
    "volume_raw",
    "vwap_raw",
    "trade_count_raw",
    "close_adj",
    "tr_index",
    "ret_1d",
    "overnight_ret",
    "intraday_ret",
    "tr_suspect",
    "split_index",
    "bar_invalid",
    "bar_extreme",
    "log_dollar_volume",
    "hl_range_ratio",
    "open_close_ratio",
)


def _has_adjustment_suspect(val: Any) -> bool:
    if val is None or (isinstance(val, float) and math.isnan(val)):
        return False
    if isinstance(val, str):
        return "adjustment_suspect" in val
    try:
        return "adjustment_suspect" in list(val)
    except TypeError:
        return False


FUND_CHANNELS: tuple[str, ...] = (
    "revenue",
    "gross_profit",
    "operating_income",
    "net_income",
    "operating_cash_flow",
    "capex",
    "diluted_eps",
    "ebitda",
    "fcf",
    "cash",
    "total_assets",
    "total_liabilities",
    "equity",
    "total_debt",
    "shares_outstanding",
)
_FUND_INDEX = {name: idx for idx, name in enumerate(FUND_CHANNELS)}
_FUND_DURATION_CONCEPT_MAP: tuple[tuple[str, str], ...] = (
    ("revenue", "revenue"),
    ("gross_profit", "gross_profit"),
    ("operating_income", "operating_income"),
    ("net_income", "net_income"),
    ("operating_cash_flow", "operating_cash_flow"),
    ("capex", "capex"),
    ("diluted_eps", "eps_diluted"),
    ("ebitda", "ebitda"),
    ("fcf", "fcf"),
)
_FUND_INSTANT_CONCEPT_MAP: tuple[tuple[str, str], ...] = (
    ("cash", "cash"),
    ("total_assets", "total_assets"),
    ("total_liabilities", "total_liabilities"),
    ("equity", "equity"),
    ("total_debt", "total_debt"),
    ("shares_outstanding", "shares_outstanding"),
)
_FUND_QUARTER_CONCEPTS: tuple[str, ...] = tuple(
    c for _, c in _FUND_DURATION_CONCEPT_MAP
)
_FUND_ALL_TARGET_CONCEPTS: tuple[str, ...] = (
    *_FUND_QUARTER_CONCEPTS,
    *(c for _, c in _FUND_INSTANT_CONCEPT_MAP),
)
_FUND_NORMALIZE_CONCEPTS = frozenset(
    required_base_concepts(list(_FUND_ALL_TARGET_CONCEPTS))
    | {
        "revenue_total",
        "revenue_contracts",
        "cost_of_revenue",
        "net_income_parent",
        "net_income_total",
        "net_income_nci",
        "net_income_common",
        "equity_parent",
        "equity_total",
        "minority_interest",
        "cash_incl_restricted",
        "liabilities_and_equity",
        "d_and_a",
        "debt_current",
        "long_term_debt_current",
        "short_term_borrowings",
        "long_term_debt_noncurrent",
        "long_term_debt",
        "shares_outstanding_cover",
        "shares_outstanding_bs",
        "shares_weighted_diluted",
        "shares_weighted_basic",
        "eps_diluted",
    }
)
_RAW_MACRO_SERIES: tuple[str, ...] = (
    "DTB3",
    "DGS3MO",
    "DGS1",
    "DGS2",
    "DGS5",
    "DGS10",
    "DGS30",
    "DFII10",
    "T10YIE",
    "BAA10Y",
    "AAA10Y",
    "VIXCLS",
    "VXVCLS",
    "DTWEXBGS",
    "DCOILWTICO",
    "CBBTCUSD",
    "CBETHUSD",
    "ALPACA_BTC_CLOSE16",
    "ALPACA_BTC_PRE06",
    "ALPACA_ETH_CLOSE16",
    "ALPACA_ETH_PRE06",
)
_MACRO_ETF_SYMBOLS: tuple[str, ...] = (
    "SPY",
    "QQQ",
    "IWB",
    "IWM",
    "RSP",
    "IWD",
    "IWF",
    "GLD",
    "XLB",
    "XLC",
    "XLE",
    "XLF",
    "XLI",
    "XLK",
    "XLP",
    "XLRE",
    "XLU",
    "XLV",
    "XLY",
)
_NEWS_SOURCES: frozenset[str] = frozenset({"alpaca_news", "finnhub_news"})

_ANCHOR_META_COLS = (
    "row_id",
    "asset_id",
    "signal_session",
    "entry_session",
    "decision_at",
    "in_universe",
    "is_benchmark",
    "asset_idx",
    "session_idx",
    "fund_snap_id",
    "event_start_cursor",
    "event_end_cursor",
    "market_cap_usd",
    "adv21_usd",
)


def compute_anchor_order_sha256(anchors_df: pd.DataFrame) -> str:
    """Compute canonical SHA-256 binding ordered `(asset_id, signal_session, decision_at)`."""
    if anchors_df.empty:
        return hashlib.sha256(b"empty-anchors-v1").hexdigest()
    digest = hashlib.sha256()
    aids = anchors_df["asset_id"].astype(str).tolist()
    days = [clocks.day(v).isoformat() for v in anchors_df["signal_session"].tolist()]
    decs = clocks.instants(anchors_df["decision_at"].to_numpy(dtype=object)).tolist()
    for idx, (aid, day_s, dec_ns) in enumerate(zip(aids, days, decs, strict=True)):
        digest.update(f"{idx}:{aid}|{day_s}|{dec_ns}\n".encode())
    return digest.hexdigest()


@dataclass
class Anchors:
    """Decision-time anchor index separating keys/cursors from model matrix X."""

    frame: pd.DataFrame
    order_sha256: str
    assets: tuple[str, ...]
    sessions: tuple[date, ...]
    time_policy: str
    sampling: str
    benchmark_id: str | None = None

    def save(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        out_df = self.frame.copy()
        out_df["asset_id"] = out_df["asset_id"].astype(str)
        out_df["signal_session"] = [
            clocks.day(v).isoformat() for v in out_df["signal_session"]
        ]
        out_df["entry_session"] = [
            clocks.day(v).isoformat() if pd.notna(v) and v is not None else ""
            for v in out_df["entry_session"]
        ]
        tmp_pq = directory / ".anchors.parquet.tmp"
        final_pq = directory / "anchors.parquet"
        out_df.to_parquet(tmp_pq, index=False, engine="pyarrow")
        tmp_pq.replace(final_pq)
        meta = {
            "order_sha256": self.order_sha256,
            "assets": list(self.assets),
            "sessions": [d.isoformat() for d in self.sessions],
            "time_policy": self.time_policy,
            "sampling": self.sampling,
            "benchmark_id": self.benchmark_id,
            "rows": len(self.frame),
        }
        tmp_json = directory / ".anchors.meta.json.tmp"
        final_json = directory / "anchors.meta.json"
        tmp_json.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        tmp_json.replace(final_json)

    @classmethod
    def load(cls, directory: Path) -> Anchors:
        meta = json.loads((directory / "anchors.meta.json").read_text("utf-8"))
        df = pd.read_parquet(directory / "anchors.parquet")
        df["signal_session"] = pd.Series(
            [clocks.day(v) for v in df["signal_session"]],
            index=df.index,
            dtype=object,
        )
        df["entry_session"] = pd.Series(
            [
                clocks.day(v) if isinstance(v, str) and v else None
                for v in df["entry_session"]
            ],
            index=df.index,
            dtype=object,
        )
        df["decision_at"] = pd.to_datetime(df["decision_at"], utc=True)
        order_sha = compute_anchor_order_sha256(df)
        if order_sha != meta["order_sha256"]:
            raise ValueError(
                "ANCHOR_ORDER_MISMATCH: cached anchors failed SHA-256 verification"
            )
        return cls(
            frame=df,
            order_sha256=order_sha,
            assets=tuple(meta["assets"]),
            sessions=tuple(clocks.day(d) for d in meta["sessions"]),
            time_policy=str(meta["time_policy"]),
            sampling=str(meta["sampling"]),
            benchmark_id=meta.get("benchmark_id"),
        )


class PriceStore:
    """Compact memory-mappable ``[N_assets, T_sessions, C_price]`` float32 tensor."""

    def __init__(
        self,
        data: np.ndarray,
        *,
        assets: Sequence[str],
        sessions: Sequence[date],
        benchmark_idx: int = -1,
        channels: Sequence[str] = PRICE_CHANNELS,
    ) -> None:
        self.data = data
        self.assets = tuple(assets)
        self.sessions = tuple(sessions)
        self.benchmark_idx = int(benchmark_idx)
        self.channels = tuple(channels)
        self._asset_pos = {aid: idx for idx, aid in enumerate(self.assets)}
        self._channel_pos = {name: idx for idx, name in enumerate(self.channels)}

    def channel(self, name: str) -> np.ndarray:
        """Return ``[N_assets, T_sessions]`` float32 view for ``name``."""
        if name in self._channel_pos:
            return self.data[:, :, self._channel_pos[name]]
        if name in PRICE_CHANNELS:
            return np.full(self.data.shape[:2], np.nan, dtype=np.float32)
        raise KeyError(name)

    def slice_asset(self, asset_idx: int, end_session_idx: int) -> np.ndarray:
        """Full untruncated history ``[0 : end_session_idx + 1, C_price]``."""
        if asset_idx < 0 or end_session_idx < 0:
            return np.empty((0, len(self.channels)), dtype=np.float32)
        return self.data[asset_idx, : end_session_idx + 1, :]

    def slice_row(self, anchors: Anchors, row_idx: int) -> np.ndarray:
        """Untruncated price history visible at anchor ``row_idx``."""
        a_idx = int(anchors.frame["asset_idx"].iat[row_idx])
        s_idx = int(anchors.frame["session_idx"].iat[row_idx])
        return self.slice_asset(a_idx, s_idx)

    def save(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        tmp_npy = directory / ".price_store.tmp.npy"
        final_npy = directory / "price_store.npy"
        np.save(tmp_npy, self.data, allow_pickle=False)
        tmp_npy.replace(final_npy)
        meta = {
            "assets": list(self.assets),
            "sessions": [d.isoformat() for d in self.sessions],
            "benchmark_idx": self.benchmark_idx,
            "channels": list(self.channels),
            "shape": list(self.data.shape),
        }
        tmp_json = directory / ".price_store.meta.json.tmp"
        final_json = directory / "price_store.meta.json"
        tmp_json.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        tmp_json.replace(final_json)

    @classmethod
    def load(cls, directory: Path, *, mmap: bool = True) -> PriceStore:
        meta = json.loads((directory / "price_store.meta.json").read_text("utf-8"))
        arr = np.load(
            directory / "price_store.npy",
            mmap_mode="r" if mmap else None,
            allow_pickle=False,
        )
        return cls(
            arr,
            assets=meta["assets"],
            sessions=[clocks.day(d) for d in meta["sessions"]],
            benchmark_idx=int(meta.get("benchmark_idx", -1)),
            channels=meta["channels"],
        )


def _fill_price_channels(
    tensor: np.ndarray,
    frame: pd.DataFrame,
    asset_pos: Mapping[str, int],
    day_pos: Mapping[str, int],
    *,
    fields: Mapping[str, int],
) -> None:
    if frame is None or frame.empty:
        return
    aids = frame["asset_id"].astype(str).map(asset_pos)
    raw_dates = frame["date"]
    if pd.api.types.is_datetime64_any_dtype(raw_dates.dtype):
        date_strs = raw_dates.dt.strftime("%Y-%m-%d")
    else:
        date_strs = raw_dates.map(lambda v: clocks.day(v).isoformat())
    sids = date_strs.map(day_pos)
    keep = (aids.notna() & sids.notna()).to_numpy()
    if not keep.any():
        return
    ai = aids[keep].to_numpy(dtype=np.int64)
    si = sids[keep].to_numpy(dtype=np.int64)
    for src_col, ch_idx in fields.items():
        if src_col not in frame.columns:
            continue
        vals = pd.to_numeric(frame[src_col], errors="coerce").to_numpy(
            dtype=np.float32
        )[keep]
        tensor[ai, si, ch_idx] = vals


def _stream_parquet_prices(
    tensor: np.ndarray,
    version: Any,
    kind: str,
    asset_list: Sequence[str],
    asset_pos: Mapping[str, int],
    day_pos: Mapping[str, int],
    fields: Mapping[str, int],
) -> bool:
    """Stream price parts batch-by-batch directly into float32 ``tensor`` when supported."""
    if not (hasattr(version, "_parts") and hasattr(version, "_client")):
        return False
    import pyarrow.dataset as pads

    wanted_cols = ["asset_id", "date", *fields.keys()]
    parts = version._parts(kind, asset_list)
    if not parts:
        return True
    paths = [str(version._client._part(item)) for item in parts]
    ds = pads.dataset(paths, format="parquet")
    avail_cols = [c for c in wanted_cols if c in ds.schema.names]
    scanner = ds.scanner(
        columns=avail_cols,
        filter=pads.field("asset_id").isin(list(asset_list)),
        batch_size=32_768,
        batch_readahead=1,
        fragment_readahead=1,
    )
    import pyarrow as pa

    for batch_idx, batch in enumerate(scanner.to_batches()):
        if batch.num_rows == 0:
            continue
        _fill_price_channels(
            tensor, batch.to_pandas(), asset_pos, day_pos, fields=fields
        )
        del batch
        if (batch_idx + 1) % 16 == 0:
            pa.default_memory_pool().release_unused()

    pa.default_memory_pool().release_unused()
    return True


def _fill_daily_returns_batch(
    tensor: np.ndarray,
    disputed_mat: np.ndarray,
    dr_df: pd.DataFrame,
    asset_pos: Mapping[str, int],
    day_pos: Mapping[str, int],
) -> None:
    if dr_df is None or dr_df.empty:
        return
    if "row_kind" in dr_df.columns:
        dr_df = dr_df[dr_df["row_kind"].astype(str).isin({"first", "session"})]
        if dr_df.empty:
            return
    dr_fields = {"tr_index": 8}
    if "split_index" in dr_df.columns:
        dr_fields["split_index"] = 13
    _fill_price_channels(tensor, dr_df, asset_pos, day_pos, fields=dr_fields)
    aids = dr_df["asset_id"].astype(str).map(asset_pos)
    raw_dates = dr_df["date"]
    if pd.api.types.is_datetime64_any_dtype(raw_dates.dtype):
        date_strs = raw_dates.dt.strftime("%Y-%m-%d")
    else:
        date_strs = raw_dates.map(lambda v: clocks.day(v).isoformat())
    sids = date_strs.map(day_pos)
    keep = (aids.notna() & sids.notna()).to_numpy()
    if not keep.any():
        return
    ai = aids[keep].to_numpy(dtype=np.int64)
    si = sids[keep].to_numpy(dtype=np.int64)
    if "flags" in dr_df.columns:
        susp = (
            dr_df["flags"]
            .iloc[np.flatnonzero(keep)]
            .map(_has_adjustment_suspect)
            .to_numpy(dtype=np.float32)
        )
        tensor[ai, si, 12] = susp
    else:
        tensor[ai, si, 12] = np.float32(0.0)
    if "tr_status" in dr_df.columns:
        disp = (
            dr_df["tr_status"].iloc[np.flatnonzero(keep)].fillna("").astype(str)
            == "disputed"
        ).to_numpy(dtype=bool)
        disputed_mat[ai, si] = disp


def _stream_parquet_daily_returns(
    tensor: np.ndarray,
    disputed_mat: np.ndarray,
    version: Any,
    asset_list: Sequence[str],
    asset_pos: Mapping[str, int],
    day_pos: Mapping[str, int],
    wanted_cols: Sequence[str],
) -> bool:
    """Stream `daily_returns` parquet parts in bounded 65k-row batches to cap RSS."""
    if not (hasattr(version, "_parts") and hasattr(version, "_client")):
        return False
    import pyarrow.dataset as pads

    parts = version._parts("daily_returns", asset_list)
    if not parts:
        return True
    paths = [str(version._client._part(item)) for item in parts]
    ds = pads.dataset(paths, format="parquet")
    avail_cols = [c for c in wanted_cols if c in ds.schema.names]
    scanner = ds.scanner(
        columns=avail_cols,
        filter=pads.field("asset_id").isin(list(asset_list)),
        batch_size=32_768,
        batch_readahead=1,
        fragment_readahead=1,
    )
    import pyarrow as pa

    for batch_idx, batch in enumerate(scanner.to_batches()):
        if batch.num_rows == 0:
            continue
        _fill_daily_returns_batch(
            tensor, disputed_mat, batch.to_pandas(), asset_pos, day_pos
        )
        del batch
        if (batch_idx + 1) % 16 == 0:
            pa.default_memory_pool().release_unused()

    pa.default_memory_pool().release_unused()
    return True


def build_price_store(
    version: Any,
    assets: Sequence[str],
    sessions: Sequence[date],
    *,
    benchmark_id: str | None = None,
    max_date: str | date | None = None,
) -> PriceStore:
    """Build compact ``float32 [N_assets, T_sessions, C_price]`` store without wide pivots."""
    if max_date is not None:
        cutoff_d = clocks.day(max_date)
        sessions = [d for d in sessions if clocks.day(d) <= cutoff_d]
    asset_list = list(
        dict.fromkeys(
            [*map(str, assets), *([str(benchmark_id)] if benchmark_id else [])]
        )
    )
    asset_pos = {aid: idx for idx, aid in enumerate(asset_list)}
    day_pos = {d.isoformat(): idx for idx, d in enumerate(sessions)}
    n_assets, n_sessions = len(asset_list), len(sessions)
    tensor = np.full(
        (n_assets, n_sessions, len(PRICE_CHANNELS)), np.nan, dtype=np.float32
    )

    raw_fields = {
        "open": 0,
        "high": 1,
        "low": 2,
        "close": 3,
        "volume": 4,
        "vwap": 5,
        "trade_count": 6,
    }
    if not _stream_parquet_prices(
        tensor, version, "raw", asset_list, asset_pos, day_pos, raw_fields
    ):
        raw_df = _project_prices(
            version, asset_list, adjusted=False, fields=tuple(raw_fields)
        )
        _fill_price_channels(tensor, raw_df, asset_pos, day_pos, fields=raw_fields)
        del raw_df

    if not _stream_parquet_prices(
        tensor, version, "all", asset_list, asset_pos, day_pos, {"close": 7}
    ):
        adj_df = _project_prices(version, asset_list, adjusted=True, fields=("close",))
        _fill_price_channels(tensor, adj_df, asset_pos, day_pos, fields={"close": 7})
        del adj_df

    disputed_mat = np.zeros((n_assets, n_sessions), dtype=bool)
    if "daily_returns" in _candidates.families(version):
        wanted_dr = [
            "asset_id",
            "date",
            "row_kind",
            "tr_index",
            "split_index",
            "flags",
            "tr_status",
        ]
        if not _stream_parquet_daily_returns(
            tensor, disputed_mat, version, asset_list, asset_pos, day_pos, wanted_dr
        ):
            if hasattr(version, "_read_family"):
                dr_df = version._read_family(
                    "daily_returns",
                    symbols=asset_list,
                    columns=wanted_dr,
                    optional_columns=True,
                )
            else:
                from .client import DatasetError

                try:
                    dr_df = version.family(
                        "daily_returns", asset_list, columns=wanted_dr
                    )
                except (DatasetError, KeyError, ValueError):
                    dr_df = version.family(
                        "daily_returns",
                        asset_list,
                        columns=["asset_id", "date", "row_kind", "tr_index"],
                    )
            _fill_daily_returns_batch(tensor, disputed_mat, dr_df, asset_pos, day_pos)
            del dr_df

    # Derive causal daily total return + intraday/overnight decomposition in 256-asset
    # chunks so float64 intermediates stay < 20 MB instead of ~1 GiB across the universe.
    # Never mix dollar `close_adj` with `tr_index` inside one asset.
    chunk_assets = 256
    for a0 in range(0, n_assets, chunk_assets):
        a1 = min(n_assets, a0 + chunk_assets)
        sl = slice(a0, a1)
        m = a1 - a0
        tr_lvl = tensor[sl, :, 8].astype(np.float64)
        adj_close = tensor[sl, :, 7].astype(np.float64)
        has_tr = np.any(np.isfinite(tr_lvl) & (tr_lvl > 0), axis=1, keepdims=True)
        base_lvl = np.where(has_tr, tr_lvl, adj_close)
        tr_suspect = tensor[sl, :, 12].astype(np.float64)
        suspect_mask = np.isfinite(tr_suspect) & (tr_suspect > 0.5)
        ret_1d = np.full((m, n_sessions), np.nan, dtype=np.float64)
        valid_prev = (base_lvl[:, :-1] > 0) & np.isfinite(base_lvl[:, :-1])
        valid_curr = (base_lvl[:, 1:] > 0) & np.isfinite(base_lvl[:, 1:])
        ok_ret = valid_prev & valid_curr & ~suspect_mask[:, 1:]
        ret_1d[:, 1:][ok_ret] = base_lvl[:, 1:][ok_ret] / base_lvl[:, :-1][ok_ret] - 1.0
        tensor[sl, :, 9] = ret_1d.astype(np.float32)

        open_raw = tensor[sl, :, 0].astype(np.float64)
        high_raw = tensor[sl, :, 1].astype(np.float64)
        low_raw = tensor[sl, :, 2].astype(np.float64)
        close_raw = tensor[sl, :, 3].astype(np.float64)
        vol_raw = tensor[sl, :, 4].astype(np.float64)
        ok_intra = (
            np.isfinite(open_raw)
            & (open_raw > 0)
            & np.isfinite(close_raw)
            & (close_raw > 0)
        )
        intraday = np.full((m, n_sessions), np.nan, dtype=np.float64)
        intraday[ok_intra] = close_raw[ok_intra] / open_raw[ok_intra] - 1.0
        tensor[sl, :, 11] = intraday.astype(np.float32)

        ok_over = np.isfinite(ret_1d) & ok_intra & ((1.0 + intraday) > 0)
        overnight = np.full((m, n_sessions), np.nan, dtype=np.float64)
        overnight[ok_over] = (1.0 + ret_1d[ok_over]) / (1.0 + intraday[ok_over]) - 1.0
        tensor[sl, :, 10] = overnight.astype(np.float32)

        # Dual quality masks:
        # - bar_invalid: adjustment_suspect, missing/non-positive price level, or zero-volume zombie bar
        # - bar_extreme: disputed-but-kept or genuine >50% single-day move (retained for risk modeling)
        zero_vol = np.isfinite(vol_raw) & (vol_raw <= 0.0)
        missing_lvl = ~(np.isfinite(base_lvl) & (base_lvl > 0.0))
        bar_invalid = suspect_mask | zero_vol | missing_lvl
        bar_extreme = (~bar_invalid) & (
            disputed_mat[sl] | (np.isfinite(ret_1d) & (np.abs(ret_1d) > 0.50))
        )
        tensor[sl, :, 14] = bar_invalid.astype(np.float32)
        tensor[sl, :, 15] = bar_extreme.astype(np.float32)

        # Split-invariant channels: log_dollar_volume, hl_range_ratio, open_close_ratio
        dvol = np.full((m, n_sessions), np.nan, dtype=np.float64)
        ok_dv = (
            np.isfinite(close_raw)
            & (close_raw > 0.0)
            & np.isfinite(vol_raw)
            & (vol_raw >= 0.0)
        )
        dvol[ok_dv] = np.log1p(close_raw[ok_dv] * vol_raw[ok_dv])
        tensor[sl, :, 16] = dvol.astype(np.float32)

        hl_ratio = np.full((m, n_sessions), np.nan, dtype=np.float64)
        ok_hl = (
            np.isfinite(high_raw)
            & np.isfinite(low_raw)
            & np.isfinite(close_raw)
            & (close_raw > 0.0)
            & (low_raw > 0.0)
            & (high_raw >= low_raw)
        )
        hl_ratio[ok_hl] = (high_raw[ok_hl] - low_raw[ok_hl]) / close_raw[ok_hl]
        tensor[sl, :, 17] = hl_ratio.astype(np.float32)

        oc_ratio = np.full((m, n_sessions), np.nan, dtype=np.float64)
        oc_ratio[ok_intra] = np.log(close_raw[ok_intra] / open_raw[ok_intra])
        tensor[sl, :, 18] = oc_ratio.astype(np.float32)

    del disputed_mat

    bench_idx = asset_pos.get(str(benchmark_id), -1) if benchmark_id else -1
    return PriceStore(
        tensor,
        assets=asset_list,
        sessions=sessions,
        benchmark_idx=bench_idx,
    )


class FundStore:
    """Restatement-proof CSR store holding ALL visible historical quarters per snapshot epoch."""

    def __init__(
        self,
        *,
        ciks: Sequence[str],
        snap_cik_idx: np.ndarray,
        snap_epoch_ns: np.ndarray,
        snap_offsets: np.ndarray,
        quarter_values: np.ndarray,
        quarter_period_end_ordinals: np.ndarray,
        quarter_public_ns: np.ndarray,
        snap_pre_ret_21d: np.ndarray,
        snap_post_1d_ret: np.ndarray,
        snap_post_3d_ret: np.ndarray,
        snap_post_1d_ready_ns: np.ndarray,
        snap_post_3d_ready_ns: np.ndarray,
        cik_snap_starts: np.ndarray,
        cik_snap_ends: np.ndarray,
        time_policy: str,
        dropped_counts: Mapping[str, int] | None = None,
    ) -> None:
        self.ciks = tuple(ciks)
        self._cik_pos = {cik: idx for idx, cik in enumerate(self.ciks)}
        self.snap_cik_idx = snap_cik_idx
        self.snap_epoch_ns = snap_epoch_ns
        self.snap_offsets = snap_offsets
        self.quarter_values = quarter_values
        self.quarter_period_end_ordinals = quarter_period_end_ordinals
        self.quarter_public_ns = quarter_public_ns
        self.snap_pre_ret_21d = snap_pre_ret_21d
        self.snap_post_1d_ret = snap_post_1d_ret
        self.snap_post_3d_ret = snap_post_3d_ret
        self.snap_post_1d_ready_ns = snap_post_1d_ready_ns
        self.snap_post_3d_ready_ns = snap_post_3d_ready_ns
        self.cik_snap_starts = cik_snap_starts
        self.cik_snap_ends = cik_snap_ends
        self.time_policy = time_policy
        self.dropped_counts = dict(dropped_counts or {})

    def lookup_snap_id(self, cik: str, decision_at_ns: int) -> int:
        """Return latest snapshot index with ``epoch_ns <= decision_at_ns`` for ``cik``, else -1."""
        c_idx = self._cik_pos.get(cik)
        if c_idx is None or decision_at_ns == NAT:
            return -1
        lo = int(self.cik_snap_starts[c_idx])
        hi = int(self.cik_snap_ends[c_idx])
        if lo >= hi:
            return -1
        epochs = self.snap_epoch_ns[lo:hi]
        pos = bisect_right(epochs.tolist(), int(decision_at_ns)) - 1
        return lo + pos if pos >= 0 else -1

    def slice_snapshot(
        self, snap_id: int, decision_at_ns: int | None = None
    ) -> dict[str, Any]:
        """Return untruncated quarterly sequence for immutable ``snap_id``."""
        if snap_id < 0 or snap_id + 1 >= len(self.snap_offsets):
            return {
                "values": np.empty((0, len(FUND_CHANNELS)), dtype=np.float32),
                "period_end_ordinals": np.empty(0, dtype=np.int32),
                "public_ns": np.empty(0, dtype=np.int64),
                "pre_ret_21d": np.float32(np.nan),
                "post_1d_ret": np.float32(np.nan),
                "post_3d_ret": np.float32(np.nan),
                "reaction_1d_ready": False,
                "reaction_3d_ready": False,
            }
        start = int(self.snap_offsets[snap_id])
        end = int(self.snap_offsets[snap_id + 1])
        r1_ok = (
            decision_at_ns is not None
            and decision_at_ns != NAT
            and int(self.snap_post_1d_ready_ns[snap_id]) <= int(decision_at_ns)
        )
        r3_ok = (
            decision_at_ns is not None
            and decision_at_ns != NAT
            and int(self.snap_post_3d_ready_ns[snap_id]) <= int(decision_at_ns)
        )
        return {
            "values": self.quarter_values[start:end],
            "period_end_ordinals": self.quarter_period_end_ordinals[start:end],
            "public_ns": self.quarter_public_ns[start:end],
            "pre_ret_21d": float(self.snap_pre_ret_21d[snap_id]),
            "post_1d_ret": float(self.snap_post_1d_ret[snap_id])
            if r1_ok
            else float("nan"),
            "post_3d_ret": float(self.snap_post_3d_ret[snap_id])
            if r3_ok
            else float("nan"),
            "reaction_1d_ready": bool(r1_ok),
            "reaction_3d_ready": bool(r3_ok),
        }

    def save(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        tmp_npz = directory / ".fund_store.tmp.npz"
        final_npz = directory / "fund_store.npz"
        np.savez(
            tmp_npz,
            snap_cik_idx=self.snap_cik_idx,
            snap_epoch_ns=self.snap_epoch_ns,
            snap_offsets=self.snap_offsets,
            quarter_values=self.quarter_values,
            quarter_period_end_ordinals=self.quarter_period_end_ordinals,
            quarter_public_ns=self.quarter_public_ns,
            snap_pre_ret_21d=self.snap_pre_ret_21d,
            snap_post_1d_ret=self.snap_post_1d_ret,
            snap_post_3d_ret=self.snap_post_3d_ret,
            snap_post_1d_ready_ns=self.snap_post_1d_ready_ns,
            snap_post_3d_ready_ns=self.snap_post_3d_ready_ns,
            cik_snap_starts=self.cik_snap_starts,
            cik_snap_ends=self.cik_snap_ends,
        )
        tmp_npz.replace(final_npz)
        meta = {
            "ciks": list(self.ciks),
            "channels": list(FUND_CHANNELS),
            "time_policy": self.time_policy,
            "dropped_counts": self.dropped_counts,
        }
        tmp_json = directory / ".fund_store.meta.json.tmp"
        final_json = directory / "fund_store.meta.json"
        tmp_json.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        tmp_json.replace(final_json)

    @classmethod
    def load(cls, directory: Path) -> FundStore:
        meta = json.loads((directory / "fund_store.meta.json").read_text("utf-8"))
        arrays = np.load(directory / "fund_store.npz", allow_pickle=False)
        return cls(
            ciks=meta["ciks"],
            snap_cik_idx=arrays["snap_cik_idx"],
            snap_epoch_ns=arrays["snap_epoch_ns"],
            snap_offsets=arrays["snap_offsets"],
            quarter_values=arrays["quarter_values"],
            quarter_period_end_ordinals=arrays["quarter_period_end_ordinals"],
            quarter_public_ns=arrays["quarter_public_ns"],
            snap_pre_ret_21d=arrays["snap_pre_ret_21d"],
            snap_post_1d_ret=arrays["snap_post_1d_ret"],
            snap_post_3d_ret=arrays["snap_post_3d_ret"],
            snap_post_1d_ready_ns=arrays["snap_post_1d_ready_ns"],
            snap_post_3d_ready_ns=arrays["snap_post_3d_ready_ns"],
            cik_snap_starts=arrays["cik_snap_starts"],
            cik_snap_ends=arrays["cik_snap_ends"],
            time_policy=str(meta["time_policy"]),
            dropped_counts=meta.get("dropped_counts"),
        )


def _cutoff_close_ns(cal: clocks.Calendar, max_date: str | date | None) -> int | None:
    """Return latest session close instant in ``cal`` with session <= ``max_date``."""
    if max_date is None:
        return None
    max_d = clocks.day(max_date)
    if not len(cal.days):
        return int(clocks.wall_instants([max_d], clocks.LABEL_CLOSE_TIME)[0])
    pos = (
        int(np.searchsorted(np.array(cal.days, dtype=object), max_d, side="right")) - 1
    )
    if pos < 0:
        return int(clocks.wall_instants([max_d], clocks.LABEL_CLOSE_TIME)[0])
    return int(cal.closes[pos])


def _reaction_window_metrics(
    asset_idx: int,
    public_ns: int,
    price_store: PriceStore | None,
    cal: clocks.Calendar,
    *,
    max_decision_ns: int | None = None,
) -> tuple[float, float, float, int, int]:
    """Return market-adjusted ``(pre_ret_21d, post_1d_ret, post_3d_ret, ready_1d_ns, ready_3d_ns)``."""
    if price_store is None or asset_idx < 0 or public_ns == NAT or not len(cal.days):
        return (float("nan"), float("nan"), float("nan"), NEVER, NEVER)
    n_sess = min(len(cal.days), price_store.data.shape[1])
    if n_sess <= 0:
        return (float("nan"), float("nan"), float("nan"), NEVER, NEVER)
    close_adj = price_store.channel("close_adj")[asset_idx]
    tr_lvl = price_store.channel("tr_index")[asset_idx]
    has_tr = bool(np.any(np.isfinite(tr_lvl[:n_sess]) & (tr_lvl[:n_sess] > 0)))
    lvl = tr_lvl if has_tr else close_adj
    inv_ch = price_store.channel("bar_invalid")[asset_idx]
    inv = np.isfinite(inv_ch) & (inv_ch > 0.5)

    bench_idx = price_store.benchmark_idx
    use_bench = (
        bench_idx >= 0
        and bench_idx < price_store.data.shape[0]
        and bench_idx != asset_idx
    )
    b_lvl: np.ndarray | None = None
    b_inv: np.ndarray | None = None
    if use_bench:
        b_tr = price_store.channel("tr_index")[bench_idx]
        b_adj = price_store.channel("close_adj")[bench_idx]
        b_has_tr = bool(np.any(np.isfinite(b_tr[:n_sess]) & (b_tr[:n_sess] > 0)))
        b_lvl = b_tr if b_has_tr else b_adj
        b_inv_ch = price_store.channel("bar_invalid")[bench_idx]
        b_inv = np.isfinite(b_inv_ch) & (b_inv_ch > 0.5)

    def _valid_at(arr: np.ndarray, bad: np.ndarray, i: int) -> bool:
        return bool(
            0 <= i < n_sess and not bad[i] and np.isfinite(arr[i]) and arr[i] > 0
        )

    r0_idx = int(np.searchsorted(cal.closes[:n_sess], int(public_ns), side="right"))
    pre_idx = r0_idx - 1
    while pre_idx >= 0 and not _valid_at(lvl, inv, pre_idx):
        pre_idx -= 1
    pre_ret = float("nan")
    if (
        pre_idx >= 21
        and _valid_at(lvl, inv, pre_idx - 21)
        and _valid_at(lvl, inv, pre_idx)
    ):
        pre_ret = float(lvl[pre_idx]) / float(lvl[pre_idx - 21]) - 1.0
        if (
            b_lvl is not None
            and b_inv is not None
            and _valid_at(b_lvl, b_inv, pre_idx - 21)
            and _valid_at(b_lvl, b_inv, pre_idx)
        ):
            pre_ret -= float(b_lvl[pre_idx]) / float(b_lvl[pre_idx - 21]) - 1.0

    def _post(k: int) -> tuple[float, int]:
        # r0_idx is the 1st reaction session close after public_ns (k=1 -> r0_idx, k=3 -> r0_idx+2).
        idx = r0_idx + k - 1
        while idx < n_sess and not _valid_at(lvl, inv, idx):
            idx += 1
        if idx >= n_sess:
            return float("nan"), NEVER
        ready_ns = int(cal.closes[idx])
        if max_decision_ns is not None and ready_ns > max_decision_ns:
            return float("nan"), NEVER
        if pre_idx < 0 or not _valid_at(lvl, inv, pre_idx):
            return float("nan"), ready_ns
        ret = float(lvl[idx]) / float(lvl[pre_idx]) - 1.0
        if (
            b_lvl is not None
            and b_inv is not None
            and _valid_at(b_lvl, b_inv, pre_idx)
            and _valid_at(b_lvl, b_inv, idx)
        ):
            ret -= float(b_lvl[idx]) / float(b_lvl[pre_idx]) - 1.0
        return ret, ready_ns

    p1_ret, r1_ns = _post(1)
    p3_ret, r3_ns = _post(3)
    return pre_ret, p1_ret, p3_ret, r1_ns, r3_ns


def _parse_optional_iso_day(value: Any) -> date | None:
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


def build_fund_store(
    version: Any,
    ciks: Sequence[str],
    *,
    time_policy: str,
    cal: clocks.Calendar,
    price_store: PriceStore | None = None,
    primary_asset_of_cik: Mapping[str, int] | None = None,
    max_date: str | date | None = None,
) -> FundStore:
    """Build restatement-proof PIT CSR ``FundStore`` using ``IssuerStateMachine`` derivation."""
    clocks.policy(time_policy)
    unique_ciks = sorted({c for c in ciks if c})
    if not unique_ciks or "fundamentals" not in _candidates.families(version):
        return FundStore(
            ciks=unique_ciks,
            snap_cik_idx=np.empty(0, dtype=np.int32),
            snap_epoch_ns=np.empty(0, dtype=np.int64),
            snap_offsets=np.zeros(1, dtype=np.int64),
            quarter_values=np.empty((0, len(FUND_CHANNELS)), dtype=np.float32),
            quarter_period_end_ordinals=np.empty(0, dtype=np.int32),
            quarter_public_ns=np.empty(0, dtype=np.int64),
            snap_pre_ret_21d=np.empty(0, dtype=np.float32),
            snap_post_1d_ret=np.empty(0, dtype=np.float32),
            snap_post_3d_ret=np.empty(0, dtype=np.float32),
            snap_post_1d_ready_ns=np.empty(0, dtype=np.int64),
            snap_post_3d_ready_ns=np.empty(0, dtype=np.int64),
            cik_snap_starts=np.zeros(len(unique_ciks), dtype=np.int64),
            cik_snap_ends=np.zeros(len(unique_ciks), dtype=np.int64),
            time_policy=time_policy,
        )

    max_ns = _cutoff_close_ns(cal, max_date)
    manifest_obj = getattr(version, "manifest", None)
    part_idx = (
        manifest_obj.get("part_index") if isinstance(manifest_obj, Mapping) else None
    )
    has_cik_part_index = isinstance(part_idx, Sequence) and any(
        isinstance(item, Mapping)
        and item.get("family") == "fundamentals"
        and "first_cik" in item
        for item in part_idx
    )
    batch_size = (
        128 if (has_cik_part_index and len(unique_ciks) > 128) else len(unique_ciks)
    )
    cik_batches = [
        unique_ciks[i : i + batch_size]
        for i in range(0, len(unique_ciks), max(1, batch_size))
    ]
    cik_splits = _fund._cik_split_events(version, unique_ciks)

    totals = {
        "dropped_unknown_clock_versions": 0,
        "dropped_invalid_clock_versions": 0,
        "dropped_unmapped_tags": 0,
        "dropped_unit_mismatch": 0,
    }
    snap_cik_idx: list[int] = []
    snap_epoch_ns: list[int] = []
    snap_offsets: list[int] = [0]
    q_values_chunks: list[np.ndarray] = []
    q_pe_ords: list[int] = []
    q_pub_ns: list[int] = []
    snap_pre_ret: list[float] = []
    snap_p1_ret: list[float] = []
    snap_p3_ret: list[float] = []
    snap_p1_ns: list[int] = []
    snap_p3_ns: list[int] = []
    cik_starts = np.zeros(len(unique_ciks), dtype=np.int64)
    cik_ends = np.zeros(len(unique_ciks), dtype=np.int64)

    c_idx_base = 0
    for cik_batch in cik_batches:
        manifest, frames = _fund._iter_fact_frames(version, cik_batch)
        zones = (
            manifest.get("source_timezones", {})
            if isinstance(manifest, Mapping)
            else {}
        )
        by_cik: dict[str, list[_fund.FactVersion]] = {}
        for chunk in frames:
            if chunk is None or chunk.empty:
                continue
            versions_chunk, stats = _fund.normalize_facts(
                chunk,
                time_policy=time_policy,
                source_timezones=zones,
                concepts=_FUND_NORMALIZE_CONCEPTS,
            )
            for k, cnt in stats.items():
                totals[k] = totals.get(k, 0) + cnt
            for v in versions_chunk:
                if max_ns is not None and int(v.available_ns) > max_ns:
                    continue
                by_cik.setdefault(v.cik, []).append(v)

        for offset_i, cik in enumerate(cik_batch):
            c_idx = c_idx_base + offset_i
            cik_starts[c_idx] = len(snap_epoch_ns)
            versions = by_cik.pop(cik, [])
            if not versions:
                cik_ends[c_idx] = len(snap_epoch_ns)
                continue
            versions.sort(key=lambda v: (v.available_ns, v.observation_sequence))
            primary_aid = (primary_asset_of_cik or {}).get(cik, -1)
            raw_splits = cik_splits.get(cik, ())
            cur_snap_day: list[date | None] = [None]

            def _causal_split_fn(
                d_from: date | None,
                d_to: date | None,
                *,
                _evs: Sequence[tuple[date, float]] = raw_splits,
                _day_box: list[date | None] = cur_snap_day,
            ) -> float:
                if not _evs or d_from is None or d_to is None:
                    return 1.0
                cap_day = _day_box[0]
                if cap_day is not None:
                    causal_evs = [(ex_d, r) for ex_d, r in _evs if ex_d <= cap_day]
                else:
                    causal_evs = list(_evs)
                return _fund._split_ratio_between(causal_evs, d_from, d_to)

            split_fn = _causal_split_fn if raw_splits else None

            batch_pub_map: dict[int, int] = {}
            for v in versions:
                ep = int(v.available_ns)
                if v.public_ns != NAT:
                    prev_pub = batch_pub_map.get(ep)
                    pv_ns = int(v.public_ns)
                    batch_pub_map[ep] = (
                        pv_ns if prev_pub is None else max(prev_pub, pv_ns)
                    )

            def _on_snapshot(
                epoch_ns: int,
                quarters_by_concept: Mapping[
                    str, Mapping[tuple[date, int], _fund.PeriodValue]
                ],
                concept_periods: Mapping[
                    str, Mapping[tuple[date | None, date], _fund.PeriodValue]
                ],
                *,
                _c_idx: int = c_idx,
                _primary_aid: int = primary_aid,
                _split_fn: Any = split_fn,
                _day_box: list[date | None] = cur_snap_day,
                _pub_map: Mapping[int, int] = batch_pub_map,
            ) -> None:
                snap_day = _day_box[0]
                dur_by_pe: dict[date, dict[str, _fund.PeriodValue]] = {}
                for ch_name, concept_name in _FUND_DURATION_CONCEPT_MAP:
                    q_map = quarters_by_concept.get(concept_name, {})
                    for pv in q_map.values():
                        if not pv.usable:
                            continue
                        slot = dur_by_pe.setdefault(pv.period_end, {})
                        prev = slot.get(ch_name)
                        if prev is None or pv.available_ns >= prev.available_ns:
                            slot[ch_name] = pv
                    # Fallback for standalone 70..115d duration facts outside a fiscal calendar slot.
                    p_map = concept_periods.get(concept_name, {})
                    for (ps, pe), pv in p_map.items():
                        if ps is None or not pv.usable:
                            continue
                        if pe in dur_by_pe and ch_name in dur_by_pe[pe]:
                            continue
                        span = (pe - ps).days + 1
                        if 70 <= span <= 115:
                            dur_by_pe.setdefault(pe, {})[ch_name] = pv

                inst_by_pe: dict[date, dict[str, _fund.PeriodValue]] = {}
                for ch_name, concept_name in _FUND_INSTANT_CONCEPT_MAP:
                    p_map = concept_periods.get(concept_name, {})
                    for (ps, pe), pv in p_map.items():
                        if ps is not None or not pv.usable:
                            continue
                        inst_by_pe.setdefault(pe, {})[ch_name] = pv
                # Fallback to diluted -> basic quarterly shares when instant cover/BS shares are absent
                for fallback_sh in ("shares_weighted_diluted", "shares_weighted_basic"):
                    q_sh_map = quarters_by_concept.get(fallback_sh, {})
                    for pv in q_sh_map.values():
                        if not pv.usable:
                            continue
                        slot_i = inst_by_pe.setdefault(pv.period_end, {})
                        if "shares_outstanding" not in slot_i:
                            slot_i["shares_outstanding"] = pv
                    p_sh_map = concept_periods.get(fallback_sh, {})
                    for (ps, pe), pv in p_sh_map.items():
                        if ps is None or not pv.usable:
                            continue
                        span = (pe - ps).days + 1
                        if 70 <= span <= 375:
                            slot_i = inst_by_pe.setdefault(pe, {})
                            if "shares_outstanding" not in slot_i:
                                slot_i["shares_outstanding"] = pv

                all_pes = sorted(set(dur_by_pe) | set(inst_by_pe))
                if not all_pes:
                    return

                mat = np.full(
                    (len(all_pes), len(FUND_CHANNELS)), np.nan, dtype=np.float32
                )
                for row_i, pe in enumerate(all_pes):
                    d_row = dur_by_pe.get(pe, {})
                    i_row = inst_by_pe.get(pe, {})
                    pe_pub = -1
                    for ch_name, _ in _FUND_DURATION_CONCEPT_MAP:
                        pv = d_row.get(ch_name)
                        if pv is None or pv.decimal_value is None:
                            continue
                        if (
                            ch_name == "diluted_eps"
                            and _split_fn is not None
                            and snap_day is not None
                        ):
                            val = float(
                                _fund._scale_decimal_to_ref(
                                    pv, "per_share", snap_day, _split_fn
                                )
                            )
                        else:
                            val = pv.float_value
                        if math.isfinite(val):
                            mat[row_i, _FUND_INDEX[ch_name]] = np.float32(val)
                            if pv.available_ns > pe_pub:
                                pe_pub = int(pv.available_ns)
                    for ch_name, _ in _FUND_INSTANT_CONCEPT_MAP:
                        pv = i_row.get(ch_name)
                        if pv is None or pv.decimal_value is None:
                            continue
                        if (
                            ch_name == "shares_outstanding"
                            and _split_fn is not None
                            and snap_day is not None
                        ):
                            val = float(
                                _fund._scale_decimal_to_ref(
                                    pv, "shares", snap_day, _split_fn
                                )
                            )
                        else:
                            val = pv.float_value
                        if math.isfinite(val):
                            mat[row_i, _FUND_INDEX[ch_name]] = np.float32(val)
                            if pv.available_ns > pe_pub:
                                pe_pub = int(pv.available_ns)
                    q_pe_ords.append(pe.toordinal())
                    q_pub_ns.append(pe_pub if pe_pub >= 0 else int(epoch_ns))

                snap_pub_ns = _pub_map.get(int(epoch_ns), int(epoch_ns))
                pre_r, p1_r, p3_r, r1_ns, r3_ns = _reaction_window_metrics(
                    _primary_aid,
                    snap_pub_ns,
                    price_store,
                    cal,
                    max_decision_ns=max_ns,
                )
                snap_cik_idx.append(_c_idx)
                snap_epoch_ns.append(int(epoch_ns))
                q_values_chunks.append(mat)
                snap_offsets.append(snap_offsets[-1] + len(all_pes))
                snap_pre_ret.append(pre_r)
                snap_p1_ret.append(p1_r)
                snap_p3_ret.append(p3_r)
                snap_p1_ns.append(r1_ns)
                snap_p3_ns.append(r3_ns)

            machine = _fund.IssuerStateMachine(
                cik,
                target_views=(),
                record_quarters=(
                    *_FUND_QUARTER_CONCEPTS,
                    "shares_weighted_diluted",
                    "shares_weighted_basic",
                ),
                split_factor_fn=split_fn,
                snapshot_callback=_on_snapshot,
                update_ledger=False,
            )
            idx = 0
            total_v = len(versions)
            while idx < total_v:
                epoch_ns = int(versions[idx].available_ns)
                end_idx = idx + 1
                while (
                    end_idx < total_v
                    and int(versions[end_idx].available_ns) == epoch_ns
                ):
                    end_idx += 1
                cur_snap_day[0] = (
                    pd.Timestamp(epoch_ns, unit="ns", tz="UTC")
                    .tz_convert(clocks.NEW_YORK)
                    .date()
                )
                machine._apply_batch(versions[idx:end_idx], epoch_ns)
                idx = end_idx

            cik_ends[c_idx] = len(snap_epoch_ns)
        by_cik.clear()
        c_idx_base += len(cik_batch)

    q_values = (
        np.concatenate(q_values_chunks, axis=0)
        if q_values_chunks
        else np.empty((0, len(FUND_CHANNELS)), dtype=np.float32)
    )
    return FundStore(
        ciks=unique_ciks,
        snap_cik_idx=np.asarray(snap_cik_idx, dtype=np.int32),
        snap_epoch_ns=np.asarray(snap_epoch_ns, dtype=np.int64),
        snap_offsets=np.asarray(snap_offsets, dtype=np.int64),
        quarter_values=q_values.astype(np.float32, copy=False),
        quarter_period_end_ordinals=np.asarray(q_pe_ords, dtype=np.int32),
        quarter_public_ns=np.asarray(q_pub_ns, dtype=np.int64),
        snap_pre_ret_21d=np.asarray(snap_pre_ret, dtype=np.float32),
        snap_post_1d_ret=np.asarray(snap_p1_ret, dtype=np.float32),
        snap_post_3d_ret=np.asarray(snap_p3_ret, dtype=np.float32),
        snap_post_1d_ready_ns=np.asarray(snap_p1_ns, dtype=np.int64),
        snap_post_3d_ready_ns=np.asarray(snap_p3_ns, dtype=np.int64),
        cik_snap_starts=cik_starts,
        cik_snap_ends=cik_ends,
        time_policy=time_policy,
        dropped_counts=totals,
    )


EVENT_SOURCES: tuple[str, ...] = (
    "sec",
    "alpaca_news",
    "finnhub_news",
    "earnings",
    "extraction",
)
_EV_SRC_ID = {name: idx for idx, name in enumerate(EVENT_SOURCES)}


class EventStore:
    """CSR untruncated discrete event & LLM release stream with causal reaction masks."""

    def __init__(
        self,
        *,
        assets: Sequence[str],
        asset_offsets: np.ndarray,
        public_at_ns: np.ndarray,
        available_at_ns: np.ndarray,
        source_id: np.ndarray,
        kind_code: np.ndarray,
        kinds: Sequence[str],
        numeric_value: np.ndarray,
        pre_ret_21d: np.ndarray,
        post_1d_ret: np.ndarray,
        post_3d_ret: np.ndarray,
        post_1d_ready_ns: np.ndarray,
        post_3d_ready_ns: np.ndarray,
        time_policy: str,
        event_date_ordinals: np.ndarray | None = None,
    ) -> None:
        self.assets = tuple(assets)
        self.asset_offsets = asset_offsets
        self.public_at_ns = public_at_ns
        self.available_at_ns = available_at_ns
        self.source_id = source_id
        self.kind_code = kind_code
        self.kinds = tuple(kinds)
        self.numeric_value = numeric_value
        self.pre_ret_21d = pre_ret_21d
        self.post_1d_ret = post_1d_ret
        self.post_3d_ret = post_3d_ret
        self.post_1d_ready_ns = post_1d_ready_ns
        self.post_3d_ready_ns = post_3d_ready_ns
        self.time_policy = time_policy
        self.event_date_ordinals = (
            event_date_ordinals
            if event_date_ordinals is not None
            else np.zeros(len(public_at_ns), dtype=np.int32)
        )

    def slice_asset_events(self, asset_idx: int, decision_at_ns: int) -> dict[str, Any]:
        """Return causal events visible at ``decision_at_ns`` with masked reactions."""
        if (
            asset_idx < 0
            or asset_idx + 1 >= len(self.asset_offsets)
            or decision_at_ns == NAT
        ):
            return {
                "public_at_ns": np.empty(0, dtype=np.int64),
                "available_at_ns": np.empty(0, dtype=np.int64),
                "source_id": np.empty(0, dtype=np.uint8),
                "kind_code": np.empty(0, dtype=np.int32),
                "event_date_ordinals": np.empty(0, dtype=np.int32),
                "numeric_value": np.empty(0, dtype=np.float32),
                "pre_ret_21d": np.empty(0, dtype=np.float32),
                "post_1d_ret": np.empty(0, dtype=np.float32),
                "post_3d_ret": np.empty(0, dtype=np.float32),
                "reaction_1d_ready": np.empty(0, dtype=bool),
                "reaction_3d_ready": np.empty(0, dtype=bool),
            }
        start = int(self.asset_offsets[asset_idx])
        end = int(self.asset_offsets[asset_idx + 1])
        avail = self.available_at_ns[start:end]
        vis = (avail != NAT) & (avail <= int(decision_at_ns))
        idx = np.arange(start, end)[vis]
        r1_ready = self.post_1d_ready_ns[idx] <= int(decision_at_ns)
        r3_ready = self.post_3d_ready_ns[idx] <= int(decision_at_ns)
        p1 = np.where(r1_ready, self.post_1d_ret[idx], np.nan).astype(np.float32)
        p3 = np.where(r3_ready, self.post_3d_ret[idx], np.nan).astype(np.float32)
        return {
            "public_at_ns": self.public_at_ns[idx],
            "available_at_ns": self.available_at_ns[idx],
            "source_id": self.source_id[idx],
            "kind_code": self.kind_code[idx],
            "event_date_ordinals": self.event_date_ordinals[idx],
            "numeric_value": self.numeric_value[idx],
            "pre_ret_21d": self.pre_ret_21d[idx],
            "post_1d_ret": p1,
            "post_3d_ret": p3,
            "reaction_1d_ready": r1_ready,
            "reaction_3d_ready": r3_ready,
        }

    def save(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        tmp_npz = directory / ".event_store.tmp.npz"
        final_npz = directory / "event_store.npz"
        np.savez(
            tmp_npz,
            asset_offsets=self.asset_offsets,
            public_at_ns=self.public_at_ns,
            available_at_ns=self.available_at_ns,
            source_id=self.source_id,
            kind_code=self.kind_code,
            event_date_ordinals=self.event_date_ordinals,
            numeric_value=self.numeric_value,
            pre_ret_21d=self.pre_ret_21d,
            post_1d_ret=self.post_1d_ret,
            post_3d_ret=self.post_3d_ret,
            post_1d_ready_ns=self.post_1d_ready_ns,
            post_3d_ready_ns=self.post_3d_ready_ns,
        )
        tmp_npz.replace(final_npz)
        meta = {
            "assets": list(self.assets),
            "kinds": list(self.kinds),
            "time_policy": self.time_policy,
        }
        tmp_json = directory / ".event_store.meta.json.tmp"
        final_json = directory / "event_store.meta.json"
        tmp_json.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        tmp_json.replace(final_json)

    @classmethod
    def load(cls, directory: Path) -> EventStore:
        meta = json.loads((directory / "event_store.meta.json").read_text("utf-8"))
        arrays = np.load(directory / "event_store.npz", allow_pickle=False)
        ev_ords = (
            arrays["event_date_ordinals"]
            if "event_date_ordinals" in arrays
            else np.zeros(len(arrays["public_at_ns"]), dtype=np.int32)
        )
        return cls(
            assets=meta["assets"],
            asset_offsets=arrays["asset_offsets"],
            public_at_ns=arrays["public_at_ns"],
            available_at_ns=arrays["available_at_ns"],
            source_id=arrays["source_id"],
            kind_code=arrays["kind_code"],
            kinds=meta["kinds"],
            event_date_ordinals=ev_ords,
            numeric_value=arrays["numeric_value"],
            pre_ret_21d=arrays["pre_ret_21d"],
            post_1d_ret=arrays["post_1d_ret"],
            post_3d_ret=arrays["post_3d_ret"],
            post_1d_ready_ns=arrays["post_1d_ready_ns"],
            post_3d_ready_ns=arrays["post_3d_ready_ns"],
            time_policy=str(meta["time_policy"]),
        )


def _extract_event_kind_names(
    src: str,
    raw_ek: Any,
    form: str,
    items: Any,
    vocab: Mapping[str, Any] | None,
) -> list[str]:
    if src == "sec":
        if isinstance(raw_ek, (list, tuple, np.ndarray)):
            found = [str(x).strip() for x in raw_ek if x is not None and str(x).strip()]
            if found:
                return list(dict.fromkeys(found))
        classified = _sec_events.classify_sec_filing(form, items, vocab)
        if classified:
            return list(dict.fromkeys(classified))
    return [form or src]


def _build_cik_asset_intervals(
    version: Any,
    asset_list: Sequence[str],
    asset_pos: Mapping[str, int],
    families: Mapping[str, Any],
) -> dict[str, list[tuple[int, date | None, date | None]]]:
    """Return verified ``cik -> [(asset_idx, effective_from, effective_to)]`` intervals."""
    intervals: dict[str, list[tuple[int, date | None, date | None]]] = {}
    covered_assets: set[int] = set()
    if "issuer_history" in families:
        ih_ev = version.family("issuer_history")
        if ih_ev is not None and not ih_ev.empty:
            for ih_row in ih_ev.to_dict("records"):
                if str(ih_row.get("status") or "") != "verified":
                    continue
                cik_raw = str(ih_row.get("cik") or "").strip()
                if not cik_raw.isdigit():
                    continue
                a_idx = asset_pos.get(str(ih_row.get("asset_id") or ""))
                if a_idx is None:
                    continue
                eff_from = _parse_optional_iso_day(ih_row.get("effective_from"))
                eff_to = _parse_optional_iso_day(ih_row.get("effective_to"))
                intervals.setdefault(cik_raw.zfill(10), []).append(
                    (a_idx, eff_from, eff_to)
                )
                covered_assets.add(a_idx)
    uni_records = _candidates.records(getattr(version, "universe", []))
    for row in uni_records:
        a_idx = asset_pos.get(str(row.get("asset_id") or ""))
        if a_idx is None or a_idx in covered_assets:
            continue
        status = row.get("issuer_mapping_status")
        if status is not None and str(status) not in {"", "verified"}:
            continue
        cik_raw = str(row.get("cik") or "").strip()
        if not cik_raw.isdigit():
            continue
        intervals.setdefault(cik_raw.zfill(10), []).append((a_idx, None, None))
    return intervals


def _read_filtered_event_observations(
    version: Any,
    columns: Sequence[str],
    *,
    include_sources: Sequence[str] | None = None,
    exclude_sources: Sequence[str] | None = None,
) -> pd.DataFrame | None:
    """Push source filtering into PyArrow dataset scanning so news rows never inflate RSS."""
    if hasattr(version, "_parts") and hasattr(version, "_client"):
        import pyarrow as pa
        import pyarrow.dataset as pads

        parts = version._parts("event_observations", None)
        if not parts:
            return pd.DataFrame()
        paths = [str(version._client._part(item)) for item in parts]
        ds = pads.dataset(paths, format="parquet")
        avail = [c for c in columns if c in ds.schema.names]
        filt = None
        if "source" in ds.schema.names:
            if include_sources is not None:
                filt = pads.field("source").isin(list(include_sources))
            elif exclude_sources is not None:
                filt = ~pads.field("source").isin(list(exclude_sources))
        scanner = ds.scanner(
            columns=avail,
            filter=filt,
            batch_size=32_768,
            batch_readahead=1,
            fragment_readahead=1,
        )
        batches: list[pa.RecordBatch] = []
        for batch in scanner.to_batches():
            if batch.num_rows > 0:
                batches.append(batch)
        if not batches:
            pa.default_memory_pool().release_unused()
            return pd.DataFrame(columns=avail)
        tbl = pa.Table.from_batches(batches)
        del batches
        df = tbl.to_pandas()
        del tbl
        pa.default_memory_pool().release_unused()
        return df

    obs = version.event_observations(columns=list(columns))
    if obs is None or obs.empty or "source" not in obs.columns:
        return obs
    if include_sources is not None:
        return obs[obs["source"].astype(str).isin(set(include_sources))]
    if exclude_sources is not None:
        return obs[~obs["source"].astype(str).isin(set(exclude_sources))]
    return obs


def build_event_store(
    version: Any,
    assets: Sequence[str],
    *,
    time_policy: str,
    cal: clocks.Calendar,
    price_store: PriceStore | None = None,
    include_news: bool = False,
    max_date: str | date | None = None,
) -> EventStore:
    """Build causal CSR ``EventStore`` with typed SEC kinds, ``event_date``, and PIT LLM facts."""
    clocks.policy(time_policy)
    asset_list = list(map(str, assets))
    asset_pos = {aid: idx for idx, aid in enumerate(asset_list)}
    manifest = getattr(version, "manifest", None)
    zones = (
        manifest.get("source_timezones", {}) if isinstance(manifest, Mapping) else {}
    )
    sec_vocab = (
        manifest.get("sec_event_kinds")
        if isinstance(manifest, Mapping)
        and isinstance(manifest.get("sec_event_kinds"), Mapping)
        else None
    )
    max_ns = _cutoff_close_ns(cal, max_date)
    kinds_map: dict[str, int] = {"event": 0}
    per_asset: list[list[tuple[int, int, int, int, float, int]]] = [
        [] for _ in asset_list
    ]

    def _kind_id(name: str) -> int:
        if name not in kinds_map:
            kinds_map[name] = len(kinds_map)
        return kinds_map[name]

    families = _candidates.families(version)
    if "event_observations" in families:
        obs_cols = [
            "source",
            "event_uid",
            "form",
            "items",
            "event_kinds",
            "filing_date",
            "event_date",
            "asset_ids",
            "asset_first_seen_at",
            "content_first_seen_at",
            "observation_recorded_at",
            "observation_sequence",
            "public_time_precision",
            "public_at",
            "public_date",
        ]
        obs = _read_filtered_event_observations(
            version,
            obs_cols,
            exclude_sources=None if include_news else sorted(_NEWS_SOURCES),
        )
        if obs is not None and not obs.empty:
            if "observation_sequence" in obs.columns:
                obs = obs.sort_values("observation_sequence", kind="mergesort")
            if "event_uid" in obs.columns:
                obs = obs.drop_duplicates(["source", "event_uid"], keep="last")
            pub_ns, invalid = clocks.public_clocks(obs, zones)
            cap_col = (
                "observation_recorded_at"
                if "observation_recorded_at" in obs.columns
                else "content_first_seen_at"
            )
            cap_ns = (
                clocks.instants(obs[cap_col].to_numpy(dtype=object))
                if cap_col in obs.columns
                else np.full(len(obs), NAT, dtype=np.int64)
            )
            avail_base = clocks.available_at(pub_ns, invalid, time_policy, (cap_ns,))
            srcs = (
                obs["source"].astype(str).tolist()
                if "source" in obs.columns
                else ["sec"] * len(obs)
            )
            forms = (
                obs["form"].fillna("").astype(str).tolist()
                if "form" in obs.columns
                else [""] * len(obs)
            )
            items_col = (
                obs["items"].tolist() if "items" in obs.columns else [""] * len(obs)
            )
            ek_col = (
                obs["event_kinds"].tolist()
                if "event_kinds" in obs.columns
                else [None] * len(obs)
            )
            ev_date_col = (
                obs["event_date"].tolist()
                if "event_date" in obs.columns
                else [None] * len(obs)
            )
            filing_date_col = (
                obs["filing_date"].tolist()
                if "filing_date" in obs.columns
                else [None] * len(obs)
            )
            links = (
                obs["asset_ids"].tolist()
                if "asset_ids" in obs.columns
                else [[]] * len(obs)
            )
            for idx_row in range(len(obs)):
                av = int(avail_base[idx_row])
                pb = int(pub_ns[idx_row])
                if av == NAT or pb == NAT:
                    continue
                if max_ns is not None and (av > max_ns or pb > max_ns):
                    continue
                src = srcs[idx_row]
                if src not in SOURCE_CONTRACTS:
                    continue
                if not include_news and src in _NEWS_SOURCES:
                    continue
                src_id = _EV_SRC_ID.get(src, 0)
                k_names = _extract_event_kind_names(
                    src,
                    ek_col[idx_row],
                    forms[idx_row],
                    items_col[idx_row],
                    sec_vocab,
                )
                ev_d = (
                    _parse_optional_iso_day(ev_date_col[idx_row])
                    or _parse_optional_iso_day(filing_date_col[idx_row])
                    or pd.Timestamp(pb, unit="ns", tz="UTC")
                    .tz_convert(clocks.NEW_YORK)
                    .date()
                )
                ev_ord = ev_d.toordinal() if ev_d is not None else 0
                row_links = links[idx_row]
                if row_links is None or isinstance(row_links, (float, int)):
                    continue
                for aid in row_links:
                    a_idx = asset_pos.get(str(aid))
                    if a_idx is not None:
                        for k_name in k_names:
                            k_id = _kind_id(k_name)
                            per_asset[a_idx].append((pb, av, src_id, k_id, 1.0, ev_ord))
            del (
                pub_ns,
                invalid,
                cap_ns,
                avail_base,
                srcs,
                forms,
                items_col,
                ek_col,
                ev_date_col,
                filing_date_col,
                links,
            )
        del obs
        import gc

        import pyarrow as pa

        gc.collect()
        pa.default_memory_pool().release_unused()

    if "extraction_facts" in families:
        facts_df = (
            version.extraction_facts()
            if hasattr(version, "extraction_facts")
            else version.family("extraction_facts")
        )
        if facts_df is not None and not facts_df.empty:
            valid = facts_df
            if "validation_status" in valid.columns:
                valid = valid[valid["validation_status"].astype(str) == "valid"]
            resolved_ver = _default_extractor_version(version)
            if "extractor_version" in valid.columns and resolved_ver is not None:
                valid = valid[valid["extractor_version"].astype(str) == resolved_ver]
            if "run_index" in valid.columns:
                valid = valid[
                    pd.to_numeric(valid["run_index"], errors="coerce").fillna(1) == 1
                ]
            if not valid.empty and "cik" in valid.columns:
                cik_intervals = _build_cik_asset_intervals(
                    version, asset_list, asset_pos, families
                )
                acc_col = (
                    "accepted_at" if "accepted_at" in valid.columns else "recorded_at"
                )
                pub_arr = clocks.instants(valid[acc_col].to_numpy(dtype=object))
                rec_arr = (
                    clocks.instants(valid["recorded_at"].to_numpy(dtype=object))
                    if "recorded_at" in valid.columns
                    else pub_arr
                )
                ciks_col = valid["cik"].astype(str).str.zfill(10).tolist()
                ft_col = (
                    valid["fact_type"].fillna("fact").astype(str).tolist()
                    if "fact_type" in valid.columns
                    else ["fact"] * len(valid)
                )
                act_col = (
                    valid["action"].fillna("").astype(str).tolist()
                    if "action" in valid.columns
                    else [""] * len(valid)
                )
                low_col = pd.to_numeric(
                    valid.get("value_low_base"), errors="coerce"
                ).to_numpy(dtype=np.float64)
                for idx_row in range(len(valid)):
                    pb = int(pub_arr[idx_row])
                    rc = int(rec_arr[idx_row]) if rec_arr[idx_row] != NAT else pb
                    av = (
                        pb
                        if time_policy == "public_reconstructed"
                        else max(pb, rc - clocks.GRACE_NS)
                    )
                    if pb == NAT or av == NAT:
                        continue
                    if max_ns is not None and (av > max_ns or pb > max_ns):
                        continue
                    pub_day = (
                        pd.Timestamp(pb, unit="ns", tz="UTC")
                        .tz_convert(clocks.NEW_YORK)
                        .date()
                    )
                    pub_ord = pub_day.toordinal()
                    k_id = _kind_id(f"llm:{ft_col[idx_row]}:{act_col[idx_row]}")
                    num_v = (
                        float(low_col[idx_row])
                        if np.isfinite(low_col[idx_row])
                        else 1.0
                    )
                    matched_assets: set[int] = set()
                    for a_idx, eff_from, eff_to in cik_intervals.get(
                        ciks_col[idx_row], ()
                    ):
                        if (eff_from is None or eff_from <= pub_day) and (
                            eff_to is None or pub_day <= eff_to
                        ):
                            matched_assets.add(a_idx)
                    for a_idx in sorted(matched_assets):
                        per_asset[a_idx].append(
                            (pb, av, _EV_SRC_ID["extraction"], k_id, num_v, pub_ord)
                        )

    offsets = np.zeros(len(asset_list) + 1, dtype=np.int64)
    flat_pub: list[int] = []
    flat_avail: list[int] = []
    flat_src: list[int] = []
    flat_kind: list[int] = []
    flat_ord: list[int] = []
    flat_val: list[float] = []
    flat_pre: list[float] = []
    flat_p1: list[float] = []
    flat_p3: list[float] = []
    flat_r1: list[int] = []
    flat_r3: list[int] = []

    for a_idx, rows in enumerate(per_asset):
        rows.sort(key=lambda r: (r[0], r[1], r[2], r[3]))
        for pb, av, src_id, k_id, val, ev_ord in rows:
            pre_r, p1_r, p3_r, r1_ns, r3_ns = _reaction_window_metrics(
                a_idx, pb, price_store, cal, max_decision_ns=max_ns
            )
            flat_pub.append(pb)
            flat_avail.append(av)
            flat_src.append(src_id)
            flat_kind.append(k_id)
            flat_ord.append(ev_ord)
            flat_val.append(val)
            flat_pre.append(pre_r)
            flat_p1.append(p1_r)
            flat_p3.append(p3_r)
            flat_r1.append(r1_ns)
            flat_r3.append(r3_ns)
        offsets[a_idx + 1] = len(flat_pub)

    inv_kinds = [name for name, _ in sorted(kinds_map.items(), key=lambda kv: kv[1])]
    return EventStore(
        assets=asset_list,
        asset_offsets=offsets,
        public_at_ns=np.asarray(flat_pub, dtype=np.int64),
        available_at_ns=np.asarray(flat_avail, dtype=np.int64),
        source_id=np.asarray(flat_src, dtype=np.uint8),
        kind_code=np.asarray(flat_kind, dtype=np.int32),
        kinds=inv_kinds,
        event_date_ordinals=np.asarray(flat_ord, dtype=np.int32),
        numeric_value=np.asarray(flat_val, dtype=np.float32),
        pre_ret_21d=np.asarray(flat_pre, dtype=np.float32),
        post_1d_ret=np.asarray(flat_p1, dtype=np.float32),
        post_3d_ret=np.asarray(flat_p3, dtype=np.float32),
        post_1d_ready_ns=np.asarray(flat_r1, dtype=np.int64),
        post_3d_ready_ns=np.asarray(flat_r3, dtype=np.int64),
        time_policy=time_policy,
    )


class MacroStore:
    """Market-wide ``[T_sessions, C_macro]`` float32 aligned to ``cal.decisions[t + 1]``."""

    def __init__(
        self,
        data: np.ndarray,
        *,
        columns: Sequence[str],
        sessions: Sequence[date],
        time_policy: str,
    ) -> None:
        self.data = data
        self.columns = tuple(columns)
        self.sessions = tuple(sessions)
        self.time_policy = time_policy

    def save(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        tmp_npy = directory / ".macro_store.tmp.npy"
        final_npy = directory / "macro_store.npy"
        np.save(tmp_npy, self.data, allow_pickle=False)
        tmp_npy.replace(final_npy)
        meta = {
            "columns": list(self.columns),
            "sessions": [d.isoformat() for d in self.sessions],
            "time_policy": self.time_policy,
        }
        tmp_json = directory / ".macro_store.meta.json.tmp"
        final_json = directory / "macro_store.meta.json"
        tmp_json.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        tmp_json.replace(final_json)

    @classmethod
    def load(cls, directory: Path) -> MacroStore:
        meta = json.loads((directory / "macro_store.meta.json").read_text("utf-8"))
        arr = np.load(directory / "macro_store.npy", allow_pickle=False)
        return cls(
            arr,
            columns=meta["columns"],
            sessions=[clocks.day(d) for d in meta["sessions"]],
            time_policy=str(meta["time_policy"]),
        )


def _crypto_latest_value(
    prep: Any,
    decision_ns: int,
    *,
    max_obs_date: date | None = None,
    min_obs_date: date | None = None,
    exact_obs_date: date | None = None,
    max_age_ref: date | None = None,
    max_age_days: int | None = None,
) -> float:
    """Strictly causal latest finite observation with ``avail_ns <= decision_ns`` and date bounds."""
    if prep is None or decision_ns == NAT or len(prep.avail_ns) == 0:
        return float("nan")
    mask = prep.avail_ns <= decision_ns
    if not mask.any():
        return float("nan")
    idxs = np.flatnonzero(mask)
    best_date: date | None = None
    best_val = float("nan")
    # Rows in _PreparedSeries are ordered by (_day, _seq, _eff_ns); iterating keeps latest seq per day.
    for idx in idxs.tolist():
        d_cur = prep.dates[idx]
        if exact_obs_date is not None and d_cur != exact_obs_date:
            continue
        if max_obs_date is not None and d_cur > max_obs_date:
            continue
        if min_obs_date is not None and d_cur < min_obs_date:
            continue
        v_cur = float(prep.values[idx])
        if not math.isfinite(v_cur) or v_cur <= 0.0:
            continue
        if best_date is None or d_cur >= best_date:
            best_date = d_cur
            best_val = v_cur
    if best_date is None:
        return float("nan")
    if (
        max_age_ref is not None
        and max_age_days is not None
        and (max_age_ref - best_date).days > max_age_days
    ):
        return float("nan")
    return best_val


def _build_crypto_macro_columns(
    prepared: Mapping[str, Any],
    sess_list: Sequence[date],
    eff_dec_ns: np.ndarray,
    ny_dates: Sequence[date],
) -> dict[str, np.ndarray]:
    """Compute causal BTC/ETH daily returns, 21d vol, and weekend/holiday gaps (< decision_at)."""
    n_sess = len(sess_list)
    cols: dict[str, np.ndarray] = {}
    for sym, fred_id, c16_id, p06_id in (
        ("btc", "CBBTCUSD", "ALPACA_BTC_CLOSE16", "ALPACA_BTC_PRE06"),
        ("eth", "CBETHUSD", "ALPACA_ETH_CLOSE16", "ALPACA_ETH_PRE06"),
    ):
        prep_fred = prepared.get(fred_id)
        prep_c16 = prepared.get(c16_id)
        prep_p06 = prepared.get(p06_id)

        p_c16 = np.full(n_sess, np.nan, dtype=np.float64)
        p_fred = np.full(n_sess, np.nan, dtype=np.float64)
        wgap = np.full(n_sess, np.nan, dtype=np.float64)

        for t_i in range(n_sess):
            d_sig = sess_list[t_i]
            d_entry = ny_dates[t_i]
            dec_t = int(eff_dec_ns[t_i])

            v_c16 = _crypto_latest_value(
                prep_c16,
                dec_t,
                max_obs_date=d_sig,
                max_age_ref=d_sig,
                max_age_days=3,
            )
            v_fred = _crypto_latest_value(
                prep_fred,
                dec_t,
                max_obs_date=d_sig,
                max_age_ref=d_sig,
                max_age_days=5,
            )
            p_c16[t_i] = v_c16
            p_fred[t_i] = v_fred

            gap_days = (d_entry - d_sig).days
            if gap_days >= 2:
                v_p06 = _crypto_latest_value(prep_p06, dec_t, exact_obs_date=d_entry)
                v_sig_c16 = _crypto_latest_value(prep_c16, dec_t, exact_obs_date=d_sig)
                if math.isfinite(v_p06) and math.isfinite(v_sig_c16):
                    wgap[t_i] = math.log(v_p06 / v_sig_c16)
                else:
                    # 2016-2020 fallback: FRED weekend/holiday close strictly after d_sig & <= decision_at
                    v_f_end = _crypto_latest_value(
                        prep_fred,
                        dec_t,
                        min_obs_date=d_sig + timedelta(days=1),
                        max_age_ref=d_entry,
                        max_age_days=3,
                    )
                    v_f_sig = _crypto_latest_value(
                        prep_fred, dec_t, exact_obs_date=d_sig
                    )
                    if math.isfinite(v_f_end) and math.isfinite(v_f_sig):
                        wgap[t_i] = math.log(v_f_end / v_f_sig)
            elif gap_days == 1 and (math.isfinite(v_c16) or math.isfinite(v_fred)):
                wgap[t_i] = 0.0

        # Same-source log returns (zero source-stitch discontinuity at 2021 boundary)
        ret_1d = np.full(n_sess, np.nan, dtype=np.float64)
        if n_sess > 1:
            ok_c16 = np.isfinite(p_c16[1:]) & np.isfinite(p_c16[:-1])
            ok_fr = (~ok_c16) & np.isfinite(p_fred[1:]) & np.isfinite(p_fred[:-1])
            ret_1d[1:][ok_c16] = np.log(p_c16[1:][ok_c16] / p_c16[:-1][ok_c16])
            ret_1d[1:][ok_fr] = np.log(p_fred[1:][ok_fr] / p_fred[:-1][ok_fr])
        cols[f"crypto_ret_1d_{sym}"] = ret_1d.astype(np.float32)
        cols[f"crypto_weekend_gap_{sym}"] = wgap.astype(np.float32)

        if sym == "btc":
            ret_21d = np.full(n_sess, np.nan, dtype=np.float64)
            if n_sess > 21:
                ok_c21 = np.isfinite(p_c16[21:]) & np.isfinite(p_c16[:-21])
                ok_f21 = (
                    (~ok_c21) & np.isfinite(p_fred[21:]) & np.isfinite(p_fred[:-21])
                )
                ret_21d[21:][ok_c21] = np.log(p_c16[21:][ok_c21] / p_c16[:-21][ok_c21])
                ret_21d[21:][ok_f21] = np.log(
                    p_fred[21:][ok_f21] / p_fred[:-21][ok_f21]
                )
            cols["crypto_ret_21d_btc"] = ret_21d.astype(np.float32)
            cols["crypto_rvol_21d_btc"] = (
                pd.Series(ret_1d)
                .rolling(21, min_periods=15)
                .std(ddof=1)
                .to_numpy(dtype=np.float32)
            )
    return cols


def build_macro_store(
    version: Any,
    sessions: Sequence[date],
    *,
    time_policy: str,
    cal: clocks.Calendar,
    price_store: PriceStore | None = None,
    max_date: str | date | None = None,
) -> MacroStore:
    """Build market-wide ``MacroStore [T_sessions, C_macro]`` with derived + raw FRED + ETF channels."""
    clocks.policy(time_policy)
    sess_list = [clocks.day(d) for d in sessions]
    if max_date is not None:
        max_d = clocks.day(max_date)
        sess_list = [d for d in sess_list if d <= max_d]
    if not sess_list:
        return MacroStore(
            np.empty((0, 0), dtype=np.float32),
            columns=(),
            sessions=(),
            time_policy=time_policy,
        )
    uni_records = _candidates.records(getattr(version, "universe", []))
    rep_asset = (
        str(uni_records[0]["asset_id"])
        if uni_records
        else "00000000-0000-4000-8000-000000000000"
    )
    n_sess = len(sess_list)
    dec_ns = cal.decisions[1 : n_sess + 1]
    if len(dec_ns) < n_sess:
        pad = np.full(n_sess - len(dec_ns), NAT, dtype=np.int64)
        dec_ns = np.concatenate([dec_ns, pad])
    valid_dec = dec_ns != NAT
    eff_dec_ns = np.where(
        valid_dec,
        dec_ns,
        clocks.wall_instants(sess_list, clocks.DECISION_TIME),
    )
    rep_samples = pd.DataFrame(
        {
            "asset_id": [rep_asset] * n_sess,
            "signal_session": sess_list,
            "decision_at": clocks.utc(eff_dec_ns),
        }
    )
    families = _candidates.families(version)
    frames: list[pd.DataFrame] = []
    if "reference_series" in families:
        frames.append(
            _reference_features(version, rep_samples, time_policy=time_policy)
        )
        raw_ref_df = (
            version.family(
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
            if hasattr(version, "family")
            else None
        )
        if raw_ref_df is not None and not raw_ref_df.empty:
            prepared = _prepare_reference_series(
                raw_ref_df, _RAW_MACRO_SERIES, time_policy
            )
            ny_dates = (
                pd.DatetimeIndex(eff_dec_ns, tz="UTC").tz_convert(clocks.NEW_YORK).date
            )
            raw_cols: dict[str, np.ndarray] = {}
            for sid in _RAW_MACRO_SERIES:
                prep = prepared.get(sid)
                arr = np.full(n_sess, np.nan, dtype=np.float32)
                if prep is not None:
                    for t_i in range(n_sess):
                        val, _, _ = _series_snapshot_at(
                            prep,
                            int(eff_dec_ns[t_i]),
                            ny_dates[t_i],
                            max_age_days=10,
                        )
                        if math.isfinite(val):
                            arr[t_i] = np.float32(val)
                raw_cols[f"raw_{sid.lower()}"] = arr
            raw_cols.update(
                _build_crypto_macro_columns(prepared, sess_list, eff_dec_ns, ny_dates)
            )
            frames.append(pd.DataFrame(raw_cols))

    present_syms = {str(r.get("symbol", "")).upper() for r in uni_records}
    if any(sym in present_syms for sym in REFERENCE_ETFS):
        frames.append(
            _market_etf_features(version, rep_samples, time_policy=time_policy)
        )

    if price_store is not None and price_store.data.shape[1] >= n_sess:
        sym_to_idx: dict[str, int] = {}
        asset_pos = {aid: idx for idx, aid in enumerate(price_store.assets)}
        for rec in uni_records:
            sym = str(rec.get("symbol") or "").strip().upper()
            aid = str(rec.get("asset_id") or "")
            if sym and aid in asset_pos and sym not in sym_to_idx:
                sym_to_idx[sym] = asset_pos[aid]
        ret_mat = price_store.channel("ret_1d")
        inv_mat = price_store.channel("bar_invalid")
        tr_mat = price_store.channel("tr_index")
        adj_mat = price_store.channel("close_adj")
        etf_cols: dict[str, np.ndarray] = {}
        for sym in _MACRO_ETF_SYMBOLS:
            a_i = sym_to_idx.get(sym)
            arr = np.full(n_sess, np.nan, dtype=np.float32)
            if a_i is not None:
                r = ret_mat[a_i, :n_sess].astype(np.float64)
                bad = np.isfinite(inv_mat[a_i, :n_sess]) & (inv_mat[a_i, :n_sess] > 0.5)
                r[bad] = np.nan
                arr = r.astype(np.float32)
            etf_cols[f"etf_ret_1d_{sym.lower()}"] = arr

        # SPY 21d realized volatility & QQQ-SPY 21d/63d spreads (strictly causal)
        spy_r = etf_cols["etf_ret_1d_spy"].astype(np.float64)
        spy_rvol = (
            pd.Series(spy_r)
            .rolling(21, min_periods=15)
            .std(ddof=1)
            .to_numpy(dtype=np.float32)
        )
        etf_cols["etf_rvol_21d_spy"] = spy_rvol

        def _cum_ret(sym_name: str, win: int) -> np.ndarray:
            out = np.full(n_sess, np.nan, dtype=np.float64)
            a_i = sym_to_idx.get(sym_name)
            if a_i is None or n_sess <= win:
                return out
            tr_s = tr_mat[a_i, :n_sess].astype(np.float64)
            adj_s = adj_mat[a_i, :n_sess].astype(np.float64)
            lvl = tr_s if np.any(np.isfinite(tr_s) & (tr_s > 0)) else adj_s
            bad = np.isfinite(inv_mat[a_i, :n_sess]) & (inv_mat[a_i, :n_sess] > 0.5)
            lvl = np.where(bad | ~(np.isfinite(lvl) & (lvl > 0)), np.nan, lvl)
            p1, p0 = lvl[win:], lvl[:-win]
            ok = np.isfinite(p1) & np.isfinite(p0) & (p0 > 0)
            out[win:][ok] = p1[ok] / p0[ok] - 1.0
            return out

        for w in (21, 63):
            etf_cols[f"etf_qqq_spy_{w}d"] = (
                _cum_ret("QQQ", w) - _cum_ret("SPY", w)
            ).astype(np.float32)
        frames.append(pd.DataFrame(etf_cols))

    if not frames:
        return MacroStore(
            np.empty((n_sess, 0), dtype=np.float32),
            columns=(),
            sessions=sess_list,
            time_policy=time_policy,
        )
    merged = pd.concat(frames, axis=1)
    seen: set[str] = set()
    num_cols: list[str] = []
    for c in merged.columns:
        if c in seen:
            continue
        seen.add(c)
        col_s = merged[c]
        if isinstance(col_s, pd.DataFrame):
            col_s = col_s.iloc[:, 0]
        if pd.api.types.is_numeric_dtype(col_s) and not pd.api.types.is_bool_dtype(
            col_s
        ):
            num_cols.append(c)
    merged_dedup = merged.loc[:, ~merged.columns.duplicated()]
    mat = (
        merged_dedup[num_cols]
        .apply(pd.to_numeric, errors="coerce")
        .to_numpy(dtype=np.float32)
        if num_cols
        else np.empty((n_sess, 0), dtype=np.float32)
    )
    return MacroStore(
        mat, columns=num_cols, sessions=sess_list, time_policy=time_policy
    )


@dataclass
class Stores:
    """Container holding all four untruncated multi-clock stores and anchor index."""

    anchors: Anchors
    prices: PriceStore
    fundamentals: FundStore
    events: EventStore
    macro: MacroStore

    def assert_cutoff(self, max_date: str | date) -> None:
        """Hard physical holdout guard verifying all 4 stores and anchors are <= ``max_date``."""
        max_d = clocks.day(max_date)
        if self.anchors.sessions and max(self.anchors.sessions) > max_d:
            raise ValueError(
                f"CUTOFF_VIOLATION: anchors.sessions max {max(self.anchors.sessions)} > {max_d}"
            )
        if not self.anchors.frame.empty:
            sig_max = max(clocks.day(d) for d in self.anchors.frame["signal_session"])
            if sig_max > max_d:
                raise ValueError(
                    f"CUTOFF_VIOLATION: anchors signal_session max {sig_max} > {max_d}"
                )
        if self.prices.sessions and max(self.prices.sessions) > max_d:
            raise ValueError(
                f"CUTOFF_VIOLATION: prices.sessions max {max(self.prices.sessions)} > {max_d}"
            )
        if self.macro.sessions and max(self.macro.sessions) > max_d:
            raise ValueError(
                f"CUTOFF_VIOLATION: macro.sessions max {max(self.macro.sessions)} > {max_d}"
            )
        max_close_ns = int(
            clocks.Calendar([max_d], infer_early_closes=True).closes[0]
            if max_d.weekday() < 5
            else clocks.wall_instants([max_d], clocks.LABEL_CLOSE_TIME)[0]
        )
        if len(self.fundamentals.snap_epoch_ns):
            if int(self.fundamentals.snap_epoch_ns.max()) > max_close_ns:
                raise ValueError(
                    "CUTOFF_VIOLATION: fundamentals.snap_epoch_ns exceeds cutoff"
                )
            for arr_name, arr in (
                ("snap_post_1d_ready_ns", self.fundamentals.snap_post_1d_ready_ns),
                ("snap_post_3d_ready_ns", self.fundamentals.snap_post_3d_ready_ns),
            ):
                fin = arr[(arr != NEVER) & (arr != NAT)]
                if len(fin) and int(fin.max()) > max_close_ns:
                    raise ValueError(
                        f"CUTOFF_VIOLATION: fundamentals.{arr_name} exceeds cutoff"
                    )
        if len(self.events.available_at_ns):
            av_fin = self.events.available_at_ns[self.events.available_at_ns != NAT]
            if len(av_fin) and int(av_fin.max()) > max_close_ns:
                raise ValueError(
                    "CUTOFF_VIOLATION: events.available_at_ns exceeds cutoff"
                )
            pb_fin = self.events.public_at_ns[self.events.public_at_ns != NAT]
            if len(pb_fin) and int(pb_fin.max()) > max_close_ns:
                raise ValueError("CUTOFF_VIOLATION: events.public_at_ns exceeds cutoff")
            for arr_name, arr in (
                ("post_1d_ready_ns", self.events.post_1d_ready_ns),
                ("post_3d_ready_ns", self.events.post_3d_ready_ns),
            ):
                fin = arr[(arr != NEVER) & (arr != NAT)]
                if len(fin) and int(fin.max()) > max_close_ns:
                    raise ValueError(
                        f"CUTOFF_VIOLATION: events.{arr_name} exceeds cutoff"
                    )

    def save(self, directory: Path) -> None:
        self.anchors.save(directory)
        self.prices.save(directory)
        self.fundamentals.save(directory)
        self.events.save(directory)
        self.macro.save(directory)

    @classmethod
    def load(cls, directory: Path, *, mmap: bool = True) -> Stores:
        return cls(
            anchors=Anchors.load(directory),
            prices=PriceStore.load(directory, mmap=mmap),
            fundamentals=FundStore.load(directory),
            events=EventStore.load(directory),
            macro=MacroStore.load(directory),
        )
