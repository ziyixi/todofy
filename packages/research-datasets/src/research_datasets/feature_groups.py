"""Plugin feature-group registry and shared build context."""

from __future__ import annotations

import gc
import hashlib
import inspect
import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from . import candidates as _candidates
from . import fundamentals_derived as _fund
from . import sec_events as _sec_events
from .constants import KEYS
from .price_reader import projected_prices as _project_prices
from .release_features import default_extractor_version as _default_extractor_version
from .stores import Stores
from .valuation import valuation as _valuation_fn


@dataclass(frozen=True)
class FeatureGroupSpec:
    """Registered declarative feature group."""

    name: str
    builder: Callable[[GroupBuildContext, Mapping[str, Any]], pd.DataFrame]
    columns: tuple[str, ...] = ()
    dynamic_columns_fn: Callable[[Mapping[str, Any]], tuple[str, ...]] | None = None
    default_params: Mapping[str, Any] = field(default_factory=dict)
    description: str = ""

    def resolve_columns(self, params: Mapping[str, Any]) -> tuple[str, ...]:
        merged = {**self.default_params, **params}
        if self.dynamic_columns_fn is not None:
            return tuple(self.dynamic_columns_fn(merged))
        return self.columns

    def operator_hash(self, params: Mapping[str, Any]) -> str:
        """Stable hash over group source, version marker, and active config."""
        try:
            src = inspect.getsource(self.builder)
        except OSError:
            src = self.builder.__name__
        payload = json.dumps(
            {
                "name": self.name,
                "params": dict(sorted(params.items())),
                "cols": list(self.resolve_columns(params)),
                "src": hashlib.sha256(src.encode("utf-8")).hexdigest()[:16],
            },
            sort_keys=True,
            default=str,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


FEATURE_GROUPS: dict[str, FeatureGroupSpec] = {}


def register_feature_group(
    name: str,
    *,
    columns: Sequence[str] = (),
    dynamic_columns_fn: Callable[[Mapping[str, Any]], tuple[str, ...]] | None = None,
    default_params: Mapping[str, Any] | None = None,
    description: str = "",
) -> Callable[
    [Callable[[GroupBuildContext, Mapping[str, Any]], pd.DataFrame]],
    Callable[[GroupBuildContext, Mapping[str, Any]], pd.DataFrame],
]:
    """Register a standalone feature group builder into ``FEATURE_GROUPS``."""

    def _decorator(
        fn: Callable[[GroupBuildContext, Mapping[str, Any]], pd.DataFrame],
    ) -> Callable[[GroupBuildContext, Mapping[str, Any]], pd.DataFrame]:
        FEATURE_GROUPS[name] = FeatureGroupSpec(
            name=name,
            builder=fn,
            columns=tuple(columns),
            dynamic_columns_fn=dynamic_columns_fn,
            default_params=dict(default_params or {}),
            description=description,
        )
        return fn

    return _decorator


def ensure_builtin_groups_loaded() -> None:
    """Import built-in group modules so ``FEATURE_GROUPS`` is fully populated."""
    from . import groups as _groups  # noqa: F401


def group_columns(
    name: str, params: Mapping[str, Any] | None = None
) -> tuple[str, ...]:
    """Return declared output columns for registered group ``name``."""
    ensure_builtin_groups_loaded()
    spec = FEATURE_GROUPS[name]
    return spec.resolve_columns(params or {})


class GroupBuildContext:
    """Lazily cached shared inputs across feature groups for one materialize run."""

    def __init__(
        self,
        *,
        version: Any,
        stores: Stores,
        time_policy: str,
        benchmark_id: str | None = None,
        horizons: tuple[int, ...] = (5, 21, 63, 126),
    ) -> None:
        self.version = version
        self.stores = stores
        self.time_policy = time_policy
        self.benchmark_id = benchmark_id
        self.horizons = tuple(horizons)
        self.families = _candidates.families(version)
        self.calendar = (
            _candidates.calendar(version, stores.prices.sessions)
            if stores.prices.sessions
            else _candidates.calendar(version, version.calendar)
        )
        self._samples_cache: pd.DataFrame | None = None
        self._cik_cache: pd.Series | None = None
        self._shares_cache: pd.Series | None = None
        self._mcap_cache: pd.Series | None = None
        self._derived_cache: dict[tuple[Any, ...], pd.DataFrame] = {}
        self._batches_cache: dict[
            tuple[int, int], list[tuple[list[str], np.ndarray]]
        ] = {}

    @property
    def samples(self) -> pd.DataFrame:
        if self._samples_cache is None:
            af = self.stores.anchors.frame
            self._samples_cache = af[[*KEYS, "decision_at"]].copy()
        return self._samples_cache

    def asset_batches(
        self, *, batch_size: int = 1500, chunk_threshold: int = 1_500_000
    ) -> list[tuple[list[str], np.ndarray]]:
        """Group sample row positions into asset batches on large daily panels."""
        key = (int(batch_size), int(chunk_threshold))
        if key not in self._batches_cache:
            samples = self.samples
            aids = samples["asset_id"].astype(str).tolist()
            by_asset: dict[str, list[int]] = {}
            for idx, aid in enumerate(aids):
                by_asset.setdefault(aid, []).append(idx)
            unique_assets = list(by_asset)
            if len(samples) <= chunk_threshold or len(unique_assets) <= batch_size:
                self._batches_cache[key] = [
                    (unique_assets, np.arange(len(samples), dtype=np.int64))
                ]
            else:
                batches: list[tuple[list[str], np.ndarray]] = []
                for i in range(0, len(unique_assets), batch_size):
                    sub_assets = unique_assets[i : i + batch_size]
                    pos = np.concatenate(
                        [np.asarray(by_asset[a], dtype=np.int64) for a in sub_assets]
                    )
                    pos.sort()
                    batches.append((sub_assets, pos))
                self._batches_cache[key] = batches
        return self._batches_cache[key]

    @property
    def ciks(self) -> pd.Series:
        if self._cik_cache is None:
            af = self.stores.anchors.frame
            self._cik_cache = _fund.cik_at(
                self.version,
                af["asset_id"].astype(str).tolist(),
                af["signal_session"].tolist(),
            )
        return self._cik_cache

    def derived_fundamentals(self, *, stale_days: int = 180) -> pd.DataFrame:
        key = (int(stale_days),)
        if key not in self._derived_cache:
            stale_map = {
                "q": int(stale_days),
                "i": int(stale_days),
                "ttm": int(stale_days),
                "fy": max(460, int(stale_days)),
            }
            samples = self.samples
            # Run normalize_facts + fundamental_states in a single pass up to 3.5M rows
            # to avoid re-parsing millions of raw facts multiple times.
            batches = self.asset_batches(batch_size=3000, chunk_threshold=3_500_000)
            if len(batches) > 1 and "fundamentals" in self.families:
                chunks: list[pd.DataFrame] = []
                for _sub_assets, pos in batches:
                    sub_d = _fund.derived_fundamentals(
                        self.version,
                        samples.iloc[pos],
                        time_policy=self.time_policy,
                        stale_after_days=stale_map,
                        provenance=False,
                    )
                    chunks.append(sub_d)
                df = pd.concat(chunks, axis=0).reindex(samples.index)
                del chunks
            else:
                df = _fund.derived_fundamentals(
                    self.version,
                    samples,
                    time_policy=self.time_policy,
                    stale_after_days=stale_map,
                    provenance=False,
                )
            self._derived_cache[key] = df
            if "shares_outstanding_i_value" in df.columns:
                self._shares_cache = pd.to_numeric(
                    df["shares_outstanding_i_value"], errors="coerce"
                ).astype(np.float32)
        return self._derived_cache[key]

    def set_mcap_cache(self, values: np.ndarray) -> None:
        if self._mcap_cache is None:
            self._mcap_cache = pd.Series(
                np.asarray(values, dtype=np.float32),
                index=self.samples.index,
            )

    def release_derived_if_unused(self, remaining_groups: set[str]) -> None:
        """Drop large derived DataFrame once no remaining group reads it directly."""
        if not self._derived_cache:
            return
        direct_users = {"fundamentals_pit", "fundamental_quality", "valuation_dynamic"}
        if remaining_groups & direct_users:
            return
        mcap_users = {
            "insider_flow",
            "short_interest",
            "llm_release_guidance",
            "extraction_signals",
        }
        if remaining_groups & mcap_users:
            self.shares_and_mcap()
        self._derived_cache.clear()
        gc.collect()

    def shares_and_mcap(self) -> pd.DataFrame | None:
        if self._mcap_cache is None and "fundamentals" in self.families:
            derived = self.derived_fundamentals()
            if (
                "shares_outstanding_i_value" in derived.columns
                and self._shares_cache is None
            ):
                self._shares_cache = pd.to_numeric(
                    derived["shares_outstanding_i_value"], errors="coerce"
                ).astype(np.float32)
            samples = self.samples
            mcap_arr = np.full(len(samples), np.nan, dtype=np.float32)
            for _sub_assets, pos in self.asset_batches():
                val = _valuation_fn(
                    self.version,
                    samples.iloc[pos],
                    derived.iloc[pos],
                    time_policy=self.time_policy,
                    provenance=False,
                )
                if "market_cap_issuer_value" in val.columns:
                    mcap_arr[pos] = pd.to_numeric(
                        val["market_cap_issuer_value"], errors="coerce"
                    ).to_numpy(dtype=np.float32)
                del val
            self._mcap_cache = pd.Series(mcap_arr, index=samples.index)
        cols: dict[str, Any] = {}
        if self._shares_cache is not None:
            cols["shares_outstanding_value"] = self._shares_cache.to_numpy(
                dtype=np.float32, copy=False
            )
        if self._mcap_cache is not None:
            cols["market_cap_issuer_value"] = self._mcap_cache.to_numpy(
                dtype=np.float32, copy=False
            )
        return pd.DataFrame(cols, index=self.samples.index) if cols else None

    def release_extractor_version(self) -> str | None:
        return _default_extractor_version(self.version)

    def sec_vocab(self) -> tuple[_sec_events.EventSpec, ...]:
        if (
            "event_observations" in self.families
            and isinstance(self.version.manifest.get("sec_event_kinds"), Mapping)
            and self.version.manifest.get("sec_event_kinds")
        ):
            return _sec_events.sec_event_specs(self.version)
        return ()

    def price_frame_close(
        self, asset_ids: Sequence[str], *, adjusted: bool
    ) -> pd.DataFrame:
        return _project_prices(
            self.version,
            list(dict.fromkeys(asset_ids)),
            adjusted=adjusted,
            fields=("close",),
        )
