"""Untruncated multi-clock sequence and array stores for materialized datasets."""

from __future__ import annotations

import hashlib
import json
import math
from bisect import bisect_right
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from . import candidates as _candidates
from . import clocks
from . import fundamentals_derived as _fund
from .clocks import NAT, NEVER
from .constants import REFERENCE_ETFS, SOURCE_CONTRACTS
from .extra_features import (
    market_etf_features as _market_etf_features,
)
from .extra_features import (
    reference_features as _reference_features,
)
from .price_reader import projected_prices as _project_prices

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
_FUND_DURATION_CONCEPTS = (
    "revenue",
    "gross_profit",
    "operating_income",
    "net_income",
    "operating_cash_flow",
    "capex",
    "diluted_eps",
    "ebitda",
    "fcf",
)
_FUND_INSTANT_CONCEPTS = (
    "cash",
    "total_assets",
    "total_liabilities",
    "equity",
    "total_debt",
    "shares_outstanding",
)
_FUND_NORMALIZE_CONCEPTS = frozenset(
    set(_FUND_DURATION_CONCEPTS)
    | set(_FUND_INSTANT_CONCEPTS)
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
    }
)

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
        batch_size=65_536,
    )
    for batch in scanner.to_batches():
        if batch.num_rows == 0:
            continue
        _fill_price_channels(
            tensor, batch.to_pandas(), asset_pos, day_pos, fields=fields
        )
    return True


def build_price_store(
    version: Any,
    assets: Sequence[str],
    sessions: Sequence[date],
    *,
    benchmark_id: str | None = None,
) -> PriceStore:
    """Build compact ``float32 [N_assets, T_sessions, C_price]`` store without wide pivots."""
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

    if "daily_returns" in _candidates.families(version):
        wanted_dr = ["asset_id", "date", "row_kind", "tr_index", "split_index", "flags"]
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
                dr_df = version.family("daily_returns", asset_list, columns=wanted_dr)
            except (DatasetError, KeyError, ValueError):
                dr_df = version.family(
                    "daily_returns",
                    asset_list,
                    columns=["asset_id", "date", "row_kind", "tr_index"],
                )
        if dr_df is not None and not dr_df.empty:
            if "row_kind" in dr_df.columns:
                dr_df = dr_df[dr_df["row_kind"].astype(str).isin({"first", "session"})]
            dr_fields = {"tr_index": 8}
            if "split_index" in dr_df.columns:
                dr_fields["split_index"] = 13
            _fill_price_channels(tensor, dr_df, asset_pos, day_pos, fields=dr_fields)
            work_dr = dr_df[["asset_id", "date"]].copy()
            if "flags" in dr_df.columns:
                work_dr["_tr_suspect"] = (
                    dr_df["flags"].map(_has_adjustment_suspect).astype(np.float32)
                )
            else:
                work_dr["_tr_suspect"] = np.float32(0.0)
            _fill_price_channels(
                tensor, work_dr, asset_pos, day_pos, fields={"_tr_suspect": 12}
            )
        del dr_df

    # Derive causal daily total return + intraday/overnight decomposition.
    # Never mix dollar `close_adj` with `tr_index` inside one asset.
    tr_lvl = tensor[:, :, 8].astype(np.float64)
    adj_close = tensor[:, :, 7].astype(np.float64)
    has_tr = np.any(np.isfinite(tr_lvl) & (tr_lvl > 0), axis=1, keepdims=True)
    base_lvl = np.where(has_tr, tr_lvl, adj_close)
    tr_suspect = tensor[:, :, 12].astype(np.float64)
    suspect_mask = np.isfinite(tr_suspect) & (tr_suspect > 0.5)
    ret_1d = np.full((n_assets, n_sessions), np.nan, dtype=np.float64)
    valid_prev = (base_lvl[:, :-1] > 0) & np.isfinite(base_lvl[:, :-1])
    valid_curr = (base_lvl[:, 1:] > 0) & np.isfinite(base_lvl[:, 1:])
    ok_ret = valid_prev & valid_curr & ~suspect_mask[:, 1:]
    ret_1d[:, 1:][ok_ret] = base_lvl[:, 1:][ok_ret] / base_lvl[:, :-1][ok_ret] - 1.0
    tensor[:, :, 9] = ret_1d.astype(np.float32)

    open_raw = tensor[:, :, 0].astype(np.float64)
    close_raw = tensor[:, :, 3].astype(np.float64)
    ok_intra = (
        np.isfinite(open_raw)
        & (open_raw > 0)
        & np.isfinite(close_raw)
        & (close_raw > 0)
    )
    intraday = np.full((n_assets, n_sessions), np.nan, dtype=np.float64)
    intraday[ok_intra] = close_raw[ok_intra] / open_raw[ok_intra] - 1.0
    tensor[:, :, 11] = intraday.astype(np.float32)

    ok_over = np.isfinite(ret_1d) & ok_intra & ((1.0 + intraday) > 0)
    overnight = np.full((n_assets, n_sessions), np.nan, dtype=np.float64)
    overnight[ok_over] = (1.0 + ret_1d[ok_over]) / (1.0 + intraday[ok_over]) - 1.0
    tensor[:, :, 10] = overnight.astype(np.float32)

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


def _reaction_window_metrics(
    asset_idx: int,
    public_ns: int,
    price_store: PriceStore | None,
    cal: clocks.Calendar,
) -> tuple[float, float, float, int, int]:
    """Return ``(pre_ret_21d, post_1d_ret, post_3d_ret, ready_1d_ns, ready_3d_ns)``."""
    if price_store is None or asset_idx < 0 or public_ns == NAT or not len(cal.days):
        return (float("nan"), float("nan"), float("nan"), NEVER, NEVER)
    close_adj = price_store.channel("close_adj")[asset_idx]
    tr_lvl = price_store.channel("tr_index")[asset_idx]
    has_tr = bool(np.any(np.isfinite(tr_lvl) & (tr_lvl > 0)))
    lvl = tr_lvl if has_tr else close_adj
    r0_idx = int(np.searchsorted(cal.closes, int(public_ns), side="right"))
    pre_idx = r0_idx - 1
    while pre_idx >= 0 and not (np.isfinite(lvl[pre_idx]) and lvl[pre_idx] > 0):
        pre_idx -= 1
    pre_ret = float("nan")
    if pre_idx >= 21:
        p0 = float(lvl[pre_idx - 21])
        p1 = float(lvl[pre_idx])
        if np.isfinite(p0) and p0 > 0 and np.isfinite(p1) and p1 > 0:
            pre_ret = p1 / p0 - 1.0

    def _post(k: int) -> tuple[float, int]:
        idx = r0_idx + k
        while idx < len(cal.days) and not (np.isfinite(lvl[idx]) and lvl[idx] > 0):
            idx += 1
        if idx >= len(cal.days):
            return float("nan"), NEVER
        ready_ns = int(cal.closes[idx])
        if pre_idx < 0 or not (np.isfinite(lvl[pre_idx]) and lvl[pre_idx] > 0):
            return float("nan"), ready_ns
        return float(lvl[idx]) / float(lvl[pre_idx]) - 1.0, ready_ns

    p1_ret, r1_ns = _post(1)
    p3_ret, r3_ns = _post(3)
    return pre_ret, p1_ret, p3_ret, r1_ns, r3_ns


def _best_concept_value(versions: list[_fund.FactVersion]) -> float:
    if not versions:
        return float("nan")
    max_order = max(v.order_key for v in versions)
    at_order = [v for v in versions if v.order_key == max_order]
    best_rank = min(v.tag_rank for v in at_order)
    cands = [v for v in at_order if v.tag_rank == best_rank]
    currencies = {v.currency for v in cands}
    if len(currencies) > 1:
        chosen = "USD" if "USD" in currencies else min(currencies)
        cands = [v for v in cands if v.currency == chosen]
    vals = {v.decimal_value for v in cands}
    if len(vals) != 1:
        return float("nan")
    val = next(iter(vals))
    if val is None:
        return float("nan")
    num = float(val)
    return num if math.isfinite(num) else float("nan")


def build_fund_store(
    version: Any,
    ciks: Sequence[str],
    *,
    time_policy: str,
    cal: clocks.Calendar,
    price_store: PriceStore | None = None,
    primary_asset_of_cik: Mapping[str, int] | None = None,
) -> FundStore:
    """Build restatement-proof PIT CSR ``FundStore`` storing all visible historical quarters."""
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

    manifest, frames = _fund._iter_fact_frames(version, unique_ciks)
    zones = (
        manifest.get("source_timezones", {}) if isinstance(manifest, Mapping) else {}
    )
    by_cik: dict[str, list[_fund.FactVersion]] = {}
    totals = {
        "dropped_unknown_clock_versions": 0,
        "dropped_invalid_clock_versions": 0,
        "dropped_unmapped_tags": 0,
        "dropped_unit_mismatch": 0,
    }
    for chunk in frames:
        if chunk is None or chunk.empty:
            continue
        versions, stats = _fund.normalize_facts(
            chunk,
            time_policy=time_policy,
            source_timezones=zones,
            concepts=_FUND_NORMALIZE_CONCEPTS,
        )
        for k, cnt in stats.items():
            totals[k] = totals.get(k, 0) + cnt
        for v in versions:
            by_cik.setdefault(v.cik, []).append(v)

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

    for c_idx, cik in enumerate(unique_ciks):
        cik_starts[c_idx] = len(snap_epoch_ns)
        versions = by_cik.pop(cik, [])
        versions.sort(key=lambda v: (v.available_ns, v.observation_sequence))
        active: dict[str, _fund.FactVersion] = {}
        primary_aid = (primary_asset_of_cik or {}).get(cik, -1)

        idx = 0
        total_v = len(versions)
        while idx < total_v:
            start_idx = idx
            epoch_ns = int(versions[idx].available_ns)
            end_idx = idx + 1
            while end_idx < total_v and int(versions[end_idx].available_ns) == epoch_ns:
                end_idx += 1
            snap_pub_ns = max(
                (
                    int(v.public_ns)
                    for v in versions[start_idx:end_idx]
                    if v.public_ns != NAT
                ),
                default=epoch_ns,
            )
            for v in versions[start_idx:end_idx]:
                if v.is_retracted:
                    active.pop(v.fact_id, None)
                else:
                    active[v.fact_id] = v
            idx = end_idx

            # Group current active facts by quarter/instant period_end without truncating history
            dur_by_pe: dict[date, dict[str, list[_fund.FactVersion]]] = {}
            inst_by_pe: dict[date, dict[str, list[_fund.FactVersion]]] = {}
            for v in active.values():
                if v.period_start is None:
                    inst_by_pe.setdefault(v.period_end, {}).setdefault(
                        v.concept, []
                    ).append(v)
                else:
                    span = (v.period_end - v.period_start).days + 1
                    if 70 <= span <= 115:
                        dur_by_pe.setdefault(v.period_end, {}).setdefault(
                            v.concept, []
                        ).append(v)

            all_pes = sorted(set(dur_by_pe) | set(inst_by_pe))
            if not all_pes:
                continue
            mat = np.full((len(all_pes), len(FUND_CHANNELS)), np.nan, dtype=np.float32)
            for row_i, pe in enumerate(all_pes):
                d_map = dur_by_pe.get(pe, {})
                i_map = inst_by_pe.get(pe, {})
                row_versions: list[_fund.FactVersion] = []
                for c_name in _FUND_DURATION_CONCEPTS:
                    vs = d_map.get(c_name, [])
                    if not vs and c_name == "revenue":
                        vs = d_map.get("revenue_total", []) or d_map.get(
                            "revenue_contracts", []
                        )
                    elif not vs and c_name == "net_income":
                        vs = d_map.get("net_income_parent", [])
                        if not vs:
                            ni_tot = _best_concept_value(
                                d_map.get("net_income_total", [])
                            )
                            ni_nci = _best_concept_value(
                                d_map.get("net_income_nci", [])
                            )
                            if math.isfinite(ni_tot) and math.isfinite(ni_nci):
                                mat[row_i, _FUND_INDEX[c_name]] = np.float32(
                                    ni_tot - ni_nci
                                )
                                row_versions.extend(d_map.get("net_income_total", []))
                                row_versions.extend(d_map.get("net_income_nci", []))
                                continue
                            vs = d_map.get("net_income_common", []) or d_map.get(
                                "net_income_total", []
                            )
                    if vs:
                        mat[row_i, _FUND_INDEX[c_name]] = np.float32(
                            _best_concept_value(vs)
                        )
                        row_versions.extend(vs)
                # Derived duration fallbacks (gross_profit / fcf / ebitda)
                if np.isnan(mat[row_i, _FUND_INDEX["gross_profit"]]):
                    rev_v = mat[row_i, _FUND_INDEX["revenue"]]
                    cor_v = _best_concept_value(d_map.get("cost_of_revenue", []))
                    if np.isfinite(rev_v) and math.isfinite(cor_v):
                        mat[row_i, _FUND_INDEX["gross_profit"]] = np.float32(
                            rev_v - cor_v
                        )
                        row_versions.extend(d_map.get("cost_of_revenue", []))
                if np.isnan(mat[row_i, _FUND_INDEX["fcf"]]):
                    ocf = mat[row_i, _FUND_INDEX["operating_cash_flow"]]
                    capex = mat[row_i, _FUND_INDEX["capex"]]
                    if np.isfinite(ocf) and np.isfinite(capex):
                        mat[row_i, _FUND_INDEX["fcf"]] = np.float32(ocf - capex)
                if np.isnan(mat[row_i, _FUND_INDEX["ebitda"]]):
                    oi = mat[row_i, _FUND_INDEX["operating_income"]]
                    da = _best_concept_value(d_map.get("d_and_a", []))
                    if np.isfinite(oi) and math.isfinite(da):
                        mat[row_i, _FUND_INDEX["ebitda"]] = np.float32(oi + da)

                for c_name in _FUND_INSTANT_CONCEPTS:
                    vs = i_map.get(c_name, [])
                    if not vs and c_name == "cash":
                        vs = i_map.get("cash_incl_restricted", [])
                    elif not vs and c_name == "equity":
                        vs = i_map.get("equity_parent", [])
                        if not vs:
                            eq_tot = _best_concept_value(i_map.get("equity_total", []))
                            mi_v = _best_concept_value(
                                i_map.get("minority_interest", [])
                            )
                            if math.isfinite(eq_tot) and math.isfinite(mi_v):
                                mat[row_i, _FUND_INDEX[c_name]] = np.float32(
                                    eq_tot - mi_v
                                )
                                row_versions.extend(i_map.get("equity_total", []))
                                row_versions.extend(i_map.get("minority_interest", []))
                                continue
                            vs = i_map.get("equity_total", [])
                    if vs:
                        mat[row_i, _FUND_INDEX[c_name]] = np.float32(
                            _best_concept_value(vs)
                        )
                        row_versions.extend(vs)
                if np.isnan(mat[row_i, _FUND_INDEX["total_liabilities"]]):
                    le_v = _best_concept_value(i_map.get("liabilities_and_equity", []))
                    if not math.isfinite(le_v):
                        ta_v = mat[row_i, _FUND_INDEX["total_assets"]]
                        le_v = float(ta_v) if np.isfinite(ta_v) else float("nan")
                    eq_tot_v = _best_concept_value(i_map.get("equity_total", []))
                    if not math.isfinite(eq_tot_v):
                        ep_v = _best_concept_value(i_map.get("equity_parent", []))
                        mi_v = _best_concept_value(i_map.get("minority_interest", []))
                        if math.isfinite(ep_v) and math.isfinite(mi_v):
                            eq_tot_v = ep_v + mi_v
                        elif math.isfinite(ep_v):
                            eq_tot_v = ep_v
                    if math.isfinite(le_v) and math.isfinite(eq_tot_v):
                        mat[row_i, _FUND_INDEX["total_liabilities"]] = np.float32(
                            le_v - eq_tot_v
                        )
                        row_versions.extend(i_map.get("liabilities_and_equity", []))
                if np.isnan(mat[row_i, _FUND_INDEX["total_debt"]]):
                    dc = _best_concept_value(i_map.get("debt_current", [])) or 0.0
                    ltc = _best_concept_value(i_map.get("long_term_debt_current", []))
                    stb = _best_concept_value(i_map.get("short_term_borrowings", []))
                    ltnc = _best_concept_value(
                        i_map.get("long_term_debt_noncurrent", [])
                    )
                    ltd = _best_concept_value(i_map.get("long_term_debt", []))
                    parts_debt = [
                        x
                        for x in (dc, ltc, stb, ltnc, ltd)
                        if math.isfinite(x) and x != 0.0
                    ]
                    if parts_debt:
                        mat[row_i, _FUND_INDEX["total_debt"]] = np.float32(
                            (dc if math.isfinite(dc) else 0.0)
                            + (
                                ltnc
                                if math.isfinite(ltnc)
                                else (ltd if math.isfinite(ltd) else 0.0)
                            )
                        )
                pe_ord = pe.toordinal()
                pe_pub = max((v.available_ns for v in row_versions), default=epoch_ns)
                q_pe_ords.append(pe_ord)
                q_pub_ns.append(int(pe_pub))

            pre_r, p1_r, p3_r, r1_ns, r3_ns = _reaction_window_metrics(
                primary_aid, snap_pub_ns, price_store, cal
            )
            snap_cik_idx.append(c_idx)
            snap_epoch_ns.append(epoch_ns)
            q_values_chunks.append(mat)
            snap_offsets.append(snap_offsets[-1] + len(all_pes))
            snap_pre_ret.append(pre_r)
            snap_p1_ret.append(p1_r)
            snap_p3_ret.append(p3_r)
            snap_p1_ns.append(r1_ns)
            snap_p3_ns.append(r3_ns)

        cik_ends[c_idx] = len(snap_epoch_ns)

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
        return cls(
            assets=meta["assets"],
            asset_offsets=arrays["asset_offsets"],
            public_at_ns=arrays["public_at_ns"],
            available_at_ns=arrays["available_at_ns"],
            source_id=arrays["source_id"],
            kind_code=arrays["kind_code"],
            kinds=meta["kinds"],
            numeric_value=arrays["numeric_value"],
            pre_ret_21d=arrays["pre_ret_21d"],
            post_1d_ret=arrays["post_1d_ret"],
            post_3d_ret=arrays["post_3d_ret"],
            post_1d_ready_ns=arrays["post_1d_ready_ns"],
            post_3d_ready_ns=arrays["post_3d_ready_ns"],
            time_policy=str(meta["time_policy"]),
        )


def build_event_store(
    version: Any,
    assets: Sequence[str],
    *,
    time_policy: str,
    cal: clocks.Calendar,
    price_store: PriceStore | None = None,
) -> EventStore:
    """Build causal CSR ``EventStore`` from ``event_observations`` and optional earnings/LLM facts."""
    clocks.policy(time_policy)
    asset_list = list(map(str, assets))
    asset_pos = {aid: idx for idx, aid in enumerate(asset_list)}
    zones = (
        version.manifest.get("source_timezones", {})
        if isinstance(getattr(version, "manifest", None), Mapping)
        else {}
    )
    kinds_map: dict[str, int] = {"event": 0}
    per_asset: list[list[tuple[int, int, int, int, float]]] = [[] for _ in asset_list]

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
            "filing_date",
            "asset_ids",
            "asset_first_seen_at",
            "content_first_seen_at",
            "observation_recorded_at",
            "observation_sequence",
            "public_time_precision",
            "public_at",
            "public_date",
        ]
        obs = version.event_observations(columns=obs_cols)
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
                src = srcs[idx_row]
                if src not in SOURCE_CONTRACTS:
                    continue
                src_id = _EV_SRC_ID.get(src, 0)
                k_name = forms[idx_row] or src
                k_id = _kind_id(k_name)
                row_links = links[idx_row]
                if row_links is None or isinstance(row_links, (float, int)):
                    continue
                for aid in row_links:
                    a_idx = asset_pos.get(str(aid))
                    if a_idx is not None:
                        per_asset[a_idx].append((pb, av, src_id, k_id, 1.0))

    if "extraction_facts" in families and hasattr(version, "extraction_facts"):
        facts_df = version.extraction_facts()
        if facts_df is not None and not facts_df.empty:
            valid = facts_df
            if "validation_status" in valid.columns:
                valid = valid[valid["validation_status"].astype(str) == "valid"]
            if not valid.empty and "cik" in valid.columns:
                ciks_s = _fund.cik_at(
                    version, asset_list, [cal.days[-1]] * len(asset_list)
                )
                cik_to_assets: dict[str, list[int]] = {}
                for a_idx, cik_v in enumerate(ciks_s.tolist()):
                    if cik_v:
                        cik_to_assets.setdefault(str(cik_v), []).append(a_idx)
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
                            if a_idx is not None:
                                bucket = cik_to_assets.setdefault(cik_raw.zfill(10), [])
                                if a_idx not in bucket:
                                    bucket.append(a_idx)
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
                    k_id = _kind_id(f"llm:{ft_col[idx_row]}:{act_col[idx_row]}")
                    num_v = (
                        float(low_col[idx_row])
                        if np.isfinite(low_col[idx_row])
                        else 1.0
                    )
                    for a_idx in cik_to_assets.get(ciks_col[idx_row], ()):
                        per_asset[a_idx].append(
                            (pb, av, _EV_SRC_ID["extraction"], k_id, num_v)
                        )

    offsets = np.zeros(len(asset_list) + 1, dtype=np.int64)
    flat_pub: list[int] = []
    flat_avail: list[int] = []
    flat_src: list[int] = []
    flat_kind: list[int] = []
    flat_val: list[float] = []
    flat_pre: list[float] = []
    flat_p1: list[float] = []
    flat_p3: list[float] = []
    flat_r1: list[int] = []
    flat_r3: list[int] = []

    for a_idx, rows in enumerate(per_asset):
        rows.sort(key=lambda r: (r[0], r[1], r[2], r[3]))
        for pb, av, src_id, k_id, val in rows:
            pre_r, p1_r, p3_r, r1_ns, r3_ns = _reaction_window_metrics(
                a_idx, pb, price_store, cal
            )
            flat_pub.append(pb)
            flat_avail.append(av)
            flat_src.append(src_id)
            flat_kind.append(k_id)
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


def build_macro_store(
    version: Any,
    sessions: Sequence[date],
    *,
    time_policy: str,
    cal: clocks.Calendar,
) -> MacroStore:
    """Build market-wide ``MacroStore [T_sessions, C_macro]`` at causal decision instants."""
    clocks.policy(time_policy)
    if not sessions:
        return MacroStore(
            np.empty((0, 0), dtype=np.float32),
            columns=(),
            sessions=(),
            time_policy=time_policy,
        )
    # Build one synthetic representative row per session and evaluate reference + market_etf once!
    uni_records = _candidates.records(getattr(version, "universe", []))
    rep_asset = (
        str(uni_records[0]["asset_id"])
        if uni_records
        else "00000000-0000-4000-8000-000000000000"
    )
    dec_ns = cal.decisions[1 : len(sessions) + 1]
    valid_dec = dec_ns != NAT
    # Where final decision is NAT (frozen last session without next_session), fall back to end-of-day wall
    eff_dec_ns = np.where(
        valid_dec,
        dec_ns,
        clocks.wall_instants(sessions, clocks.DECISION_TIME),
    )
    rep_samples = pd.DataFrame(
        {
            "asset_id": [rep_asset] * len(sessions),
            "signal_session": list(sessions),
            "decision_at": clocks.utc(eff_dec_ns),
        }
    )
    families = _candidates.families(version)
    frames: list[pd.DataFrame] = []
    if "reference_series" in families:
        frames.append(
            _reference_features(version, rep_samples, time_policy=time_policy)
        )
    present_syms = {str(r.get("symbol", "")).upper() for r in uni_records}
    if any(sym in present_syms for sym in REFERENCE_ETFS):
        frames.append(
            _market_etf_features(version, rep_samples, time_policy=time_policy)
        )
    if not frames:
        return MacroStore(
            np.empty((len(sessions), 0), dtype=np.float32),
            columns=(),
            sessions=sessions,
            time_policy=time_policy,
        )
    merged = pd.concat(frames, axis=1)
    num_cols = [
        c
        for c in merged.columns
        if pd.api.types.is_numeric_dtype(merged[c])
        and not pd.api.types.is_bool_dtype(merged[c])
    ]
    mat = (
        merged[num_cols]
        .apply(pd.to_numeric, errors="coerce")
        .to_numpy(dtype=np.float32)
        if num_cols
        else np.empty((len(sessions), 0), dtype=np.float32)
    )
    return MacroStore(mat, columns=num_cols, sessions=sessions, time_policy=time_policy)


@dataclass
class Stores:
    """Container holding all four untruncated multi-clock stores and anchor index."""

    anchors: Anchors
    prices: PriceStore
    fundamentals: FundStore
    events: EventStore
    macro: MacroStore

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
