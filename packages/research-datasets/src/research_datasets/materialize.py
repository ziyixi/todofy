"""Declarative YAML recipe validation, incremental per-group cache, and audit gates."""

from __future__ import annotations

import gc
import hashlib
import json
import re
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from importlib import resources
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import yaml

from . import candidates as _candidates
from . import clocks
from . import fundamentals_derived as _fund
from . import labels as _labels
from .client import DatasetError
from .constants import DEFAULT_HORIZONS, KEYS
from .extra_features import risk_free_daily as _risk_free_daily
from .feature_groups import (
    FEATURE_GROUPS,
    GroupBuildContext,
    ensure_builtin_groups_loaded,
    group_columns,
)
from .panels import _return_inputs, _series
from .stores import (
    Anchors,
    EventStore,
    FundStore,
    PriceStore,
    Stores,
    build_event_store,
    build_fund_store,
    build_macro_store,
    build_price_store,
    compute_anchor_order_sha256,
)

EXCLUDED_FEATURE_TOKENS: tuple[str, ...] = (
    "size_usd",
    "size_basis",
    "rank_size",
    "rank_adv",
    "adv_usd",
    "issuer_key",
    "shares_basis",
    "band_state",
    "turnover",
    "no_cik",
    "has_cik",
    "size_imputed",
)

POINTER_COLUMNS: frozenset[str] = frozenset(
    {
        "row_id",
        "asset_idx",
        "session_idx",
        "fund_snap_id",
        "event_start_cursor",
        "event_end_cursor",
    }
)

INDICATOR_PATTERN = re.compile(
    r"(_missing|_is_missing|_was_missing|_isna|_isnull|_imputed|_indicator|_status"
    r"|_coverage|_coverage_basis|_observed)$|^(missing|isna|isnull)_"
)

FORBIDDEN_LEAKAGE_RE = re.compile(
    r"(?:^|_)(?:future|fwd|next|lead|post_event)_[a-z0-9_]*|"
    r"^(?:target_return|label_return|realized_return|y_true|future_return|forward_return)$|"
    r"^reaction_(?:1d|3d)(?:_return)?$|"
    r"^label_[a-z0-9_]+$",
    re.IGNORECASE,
)


def _load_default_recipe_yaml() -> str:
    return (
        resources.files("research_datasets")
        .joinpath("default_training_recipe.yaml")
        .read_text(encoding="utf-8")
    )


DEFAULT_TRAINING_RECIPE_YAML: str = _load_default_recipe_yaml()


def audit_features(
    columns: Sequence[str], frame: pd.DataFrame | None = None
) -> pd.DataFrame:
    """Reject universe-ranking tokens, leakage names, indicators, and cursor pointers from X."""
    hits: list[dict[str, str]] = []
    for col in columns:
        name = str(col)
        delim = f"_{name.lower()}_"
        for tok in EXCLUDED_FEATURE_TOKENS:
            if f"_{tok.lower()}_" in delim or (
                tok == "turnover" and tok in name.lower()
            ):
                hits.append(
                    {"feature": name, "rule": "excluded_universe_field", "match": tok}
                )
        if (
            name in POINTER_COLUMNS
            or name.endswith(("_idx", "_snap_id", "_cursor"))
            or name == "row_id"
        ):
            hits.append({"feature": name, "rule": "pointer_column", "match": name})
        if INDICATOR_PATTERN.search(name):
            hits.append({"feature": name, "rule": "missing_indicator", "match": name})
        if FORBIDDEN_LEAKAGE_RE.match(name):
            hits.append(
                {"feature": name, "rule": "forbidden_leakage_name", "match": name}
            )
    del frame
    return pd.DataFrame(hits, columns=["feature", "rule", "match"])


def _check_identifier_token(token: str, path: str) -> None:
    if not token:
        return
    if FORBIDDEN_LEAKAGE_RE.match(token) or INDICATOR_PATTERN.search(token):
        raise ValueError(
            f"RECIPE_FORBIDDEN_LEAKAGE_COLUMN: {path} references forbidden identifier {token!r}"
        )
    delim = f"_{token.lower()}_"
    for bad in EXCLUDED_FEATURE_TOKENS:
        if f"_{bad.lower()}_" in delim or (bad == "turnover" and bad in token.lower()):
            raise ValueError(
                f"RECIPE_FORBIDDEN_LEAKAGE_COLUMN: {path} references excluded field {token!r}"
            )
    if (
        token in POINTER_COLUMNS
        or token.endswith(("_idx", "_snap_id", "_cursor"))
        or token == "row_id"
    ):
        raise ValueError(
            f"RECIPE_FORBIDDEN_LEAKAGE_COLUMN: {path} references pointer column {token!r}"
        )


def _scan_recipe_tokens(value: Any, path: str) -> None:
    if isinstance(value, str):
        for tok in re.split(r"[\s,;/]+", value.strip()):
            _check_identifier_token(tok, path)
        return
    if isinstance(value, list):
        for idx, item in enumerate(value):
            _scan_recipe_tokens(item, f"{path}[{idx}]")
        return
    if isinstance(value, Mapping):
        for k, v in value.items():
            if not isinstance(k, str) or not k.strip():
                raise ValueError(f"RECIPE_INVALID_KEY: empty key at {path}")
            _check_identifier_token(k.strip(), f"{path}.{k}")
            _scan_recipe_tokens(v, f"{path}.{k}")


def validate_recipe(
    recipe_yaml: str | Mapping[str, Any] | None,
) -> tuple[dict[str, Any], str, str]:
    """Parse, normalize, and strictly validate a YAML training recipe."""
    ensure_builtin_groups_loaded()
    if recipe_yaml is None:
        raw_text = DEFAULT_TRAINING_RECIPE_YAML
    elif isinstance(recipe_yaml, Mapping):
        raw_text = yaml.safe_dump(dict(recipe_yaml), sort_keys=False)
    elif isinstance(recipe_yaml, str):
        raw_text = recipe_yaml.replace("\r\n", "\n").strip("\n") + "\n"
        if not raw_text.strip():
            raw_text = DEFAULT_TRAINING_RECIPE_YAML
    else:
        raise TypeError("recipe_yaml must be a YAML string, mapping, or None")

    try:
        parsed = yaml.safe_load(raw_text)
    except yaml.YAMLError as err:
        raise ValueError(f"RECIPE_YAML_SYNTAX_ERROR: {err}") from err
    if not isinstance(parsed, dict):
        raise ValueError(  # noqa: TRY004
            "RECIPE_INVALID_ROOT: recipe root must be a mapping"
        )
    schema_version = parsed.get("schema_version")
    if isinstance(schema_version, bool) or schema_version != 1:
        raise ValueError("RECIPE_INVALID_SCHEMA_VERSION: schema_version must be 1")

    _scan_recipe_tokens(parsed, "root")
    groups = parsed.get("feature_groups")
    if not isinstance(groups, dict) or not groups:
        raise ValueError(
            "RECIPE_MISSING_FEATURE_GROUPS: non-empty feature_groups required"
        )

    unknown = sorted(set(groups) - set(FEATURE_GROUPS))
    if unknown:
        raise ValueError(f"RECIPE_UNKNOWN_FEATURE_GROUP: {', '.join(unknown)}")

    enabled_any = False
    for gname, gcfg in groups.items():
        if not isinstance(gcfg, dict):
            raise ValueError(  # noqa: TRY004
                f"RECIPE_INVALID_GROUP_CONFIG: {gname!r} must be a mapping"
            )
        if "enabled" in gcfg and not isinstance(gcfg["enabled"], bool):
            raise ValueError(
                f"RECIPE_INVALID_GROUP_CONFIG: {gname!r}.enabled must be bool"
            )
        if "windows" in gcfg:
            wins = gcfg["windows"]
            if (
                not isinstance(wins, list)
                or not wins
                or any(
                    isinstance(w, bool) or not isinstance(w, int) or w <= 0 or w > 2520
                    for w in wins
                )
            ):
                raise ValueError(
                    f"RECIPE_INVALID_WINDOW: {gname!r}.windows must be ints in [1, 2520]"
                )
        if gcfg.get("enabled", True):
            enabled_any = True
    if not enabled_any:
        raise ValueError(
            "RECIPE_NO_ENABLED_GROUPS: at least one feature group must be enabled"
        )

    time_policy = str(parsed.get("time_policy", "public_reconstructed"))
    clocks.policy(time_policy)
    sampling = str(parsed.get("sampling", "weekly"))
    if sampling not in ("daily", "weekly", "monthly"):
        raise ValueError(f"RECIPE_INVALID_SAMPLING: unsupported sampling {sampling!r}")

    horizons = parsed.get("horizons_trading_days", list(DEFAULT_HORIZONS))
    if (
        not isinstance(horizons, list)
        or not horizons
        or any(
            isinstance(h, bool) or not isinstance(h, int) or h <= 0 or h > 756
            for h in horizons
        )
    ):
        raise ValueError(
            "RECIPE_INVALID_HORIZONS: horizons_trading_days must be ints in [1, 756]"
        )

    exclude_cols = parsed.get("exclude_columns") or []
    if not isinstance(exclude_cols, list) or any(
        not isinstance(c, str) for c in exclude_cols
    ):
        raise ValueError(
            "RECIPE_INVALID_EXCLUDE: exclude_columns must be a list of strings"
        )

    bridge_cols = parsed.get("bridge_columns") or []
    if not isinstance(bridge_cols, list) or any(
        not isinstance(c, str) for c in bridge_cols
    ):
        raise ValueError(
            "RECIPE_INVALID_BRIDGE: bridge_columns must be a list of strings"
        )

    sha = hashlib.sha256(raw_text.encode("utf-8")).hexdigest()
    return parsed, raw_text, sha


@dataclass
class MaterializedDataset:
    """Decoupled stores + anchors + audited pure-numeric feature matrix X + labels y."""

    dataset_id: str
    manifest_sha256: str
    recipe_yaml: str
    recipe_sha256: str
    recipe: dict[str, Any]
    anchors: Anchors
    stores: Stores | None
    X: pd.DataFrame
    y: pd.DataFrame | None
    report: dict[str, Any] = field(default_factory=dict)


def _part_path(parts_dir: Path, group_name: str, op_hash: str) -> Path:
    return parts_dir / f"{group_name}__{op_hash[:16]}.parquet"


def _write_verified_part(
    part_path: Path,
    frame: pd.DataFrame,
    declared_cols: Sequence[str],
    *,
    anchor_order_sha256: str,
    manifest_sha256: str,
    time_policy: str,
    op_hash: str,
) -> None:
    part_path.parent.mkdir(parents=True, exist_ok=True)
    arrays = {
        col: pa.array(frame[col].to_numpy(dtype=np.float32), type=pa.float32())
        for col in declared_cols
    }
    table = pa.table(arrays)
    existing_meta = dict(table.schema.metadata or {})
    existing_meta.update(
        {
            b"anchor_order_sha256": anchor_order_sha256.encode("utf-8"),
            b"manifest_sha256": manifest_sha256.encode("utf-8"),
            b"time_policy": time_policy.encode("utf-8"),
            b"operator_hash": op_hash.encode("utf-8"),
            b"declared_columns": json.dumps(list(declared_cols)).encode("utf-8"),
        }
    )
    table = table.replace_schema_metadata(existing_meta)
    tmp_path = part_path.with_suffix(".parquet.tmp")
    pq.write_table(table, tmp_path, compression="zstd")
    tmp_path.replace(part_path)


def _read_verified_part(
    part_path: Path,
    *,
    group_name: str,
    expected_rows: int,
    anchor_order_sha256: str,
    manifest_sha256: str,
    time_policy: str,
    op_hash: str,
    kept_columns: Sequence[str],
) -> pd.DataFrame:
    pf = pq.ParquetFile(part_path)
    if pf.metadata.num_rows != expected_rows:
        raise DatasetError(
            "INTEGRITY",
            f"ANCHOR_ORDER_MISMATCH: {group_name} part has {pf.metadata.num_rows} rows != anchors {expected_rows}",
        )
    meta = pf.schema_arrow.metadata or {}
    got_order = meta.get(b"anchor_order_sha256", b"").decode("utf-8")
    if got_order != anchor_order_sha256:
        raise DatasetError(
            "INTEGRITY",
            f"ANCHOR_ORDER_MISMATCH: {group_name} part anchor_order_sha256 {got_order[:12]} != {anchor_order_sha256[:12]}",
        )
    if meta.get(b"manifest_sha256", b"").decode("utf-8") != manifest_sha256:
        raise DatasetError("INTEGRITY", f"{group_name} part manifest_sha256 mismatch")
    if meta.get(b"time_policy", b"").decode("utf-8") != time_policy:
        raise DatasetError("INTEGRITY", f"{group_name} part time_policy mismatch")
    if meta.get(b"operator_hash", b"").decode("utf-8") != op_hash:
        raise DatasetError("INTEGRITY", f"{group_name} part operator_hash mismatch")
    if not kept_columns:
        return pd.DataFrame(index=pd.RangeIndex(expected_rows))
    table = pf.read(columns=list(kept_columns))
    return table.to_pandas()


def _trailing_dvol_21d(
    price_store: PriceStore,
    asset_idxs: np.ndarray,
    sess_idxs: np.ndarray,
) -> np.ndarray:
    """Trailing 21-session mean dollar volume at each ``(asset_idx, session_idx)``."""
    n = len(asset_idxs)
    out = np.full(n, -1.0, dtype=np.float64)
    if n == 0 or price_store.data.shape[1] == 0:
        return out
    close_r = price_store.channel("close_raw").astype(np.float64)
    vol_r = price_store.channel("volume_raw").astype(np.float64)
    inv_r = price_store.channel("bar_invalid").astype(np.float64)
    bad = np.isfinite(inv_r) & (inv_r > 0.5)
    ok = (
        ~bad
        & np.isfinite(close_r)
        & (close_r > 0.0)
        & np.isfinite(vol_r)
        & (vol_r >= 0.0)
    )
    dv = np.where(ok, close_r * vol_r, 0.0)
    n_a, n_s = dv.shape
    csum = np.zeros((n_a, n_s + 1), dtype=np.float64)
    ccnt = np.zeros((n_a, n_s + 1), dtype=np.int32)
    np.cumsum(dv, axis=1, out=csum[:, 1:])
    np.cumsum(ok.astype(np.int32), axis=1, out=ccnt[:, 1:])
    valid = (
        (asset_idxs >= 0) & (asset_idxs < n_a) & (sess_idxs >= 0) & (sess_idxs < n_s)
    )
    if not valid.any():
        return out
    va = asset_idxs[valid]
    vs = sess_idxs[valid]
    lo = np.maximum(0, vs - 20)
    cnt = ccnt[va, vs + 1] - ccnt[va, lo]
    tot = csum[va, vs + 1] - csum[va, lo]
    pos = cnt > 0
    vals = np.full(len(va), -1.0, dtype=np.float64)
    vals[pos] = tot[pos] / cnt[pos]
    out[valid] = vals
    return out


def _build_anchors(
    version: Any,
    *,
    symbols: str | Sequence[str] | None,
    start: str | date | None,
    end: str | date | None,
    sampling: str,
    universe: str,
    benchmark: str | None,
    time_policy: str,
    cal: clocks.Calendar,
    assets: Sequence[str],
    price_store: PriceStore,
    fund_store: FundStore,
    event_store: EventStore,
    deduplicate_issuers: bool = True,
) -> tuple[Anchors, int]:
    cands = _candidates.build_candidates(
        version,
        symbols,
        start=start,
        end=end,
        sampling=sampling,
        universe=universe,
        keep_non_members=False,
        benchmark=benchmark,
    )
    if cands.empty:
        raise ValueError("No candidate rows: no selected security is a member in range")

    asset_list = list(map(str, assets))
    asset_pos = {aid: idx for idx, aid in enumerate(asset_list)}
    day_pos = {d: idx for idx, d in enumerate(cal.days)}
    aids = cands["asset_id"].astype(str).tolist()
    sig_days = [clocks.day(d) for d in cands["signal_session"].tolist()]
    asset_idxs = np.array([asset_pos.get(a, -1) for a in aids], dtype=np.int32)
    sess_idxs = np.array([day_pos.get(d, -1) for d in sig_days], dtype=np.int32)
    ciks_s = _fund.cik_at(version, aids, sig_days).astype(str).tolist()
    is_bench_raw = (
        cands["is_benchmark"].fillna(False).to_numpy(dtype=bool)
        if "is_benchmark" in cands.columns
        else np.zeros(len(cands), dtype=bool)
    )

    dedup_dropped = 0
    if deduplicate_issuers and len(cands) > 1:
        dv21 = _trailing_dvol_21d(price_store, asset_idxs, sess_idxs)
        best_by_key: dict[tuple[date, str], tuple[float, str, int]] = {}
        keep_mask = np.ones(len(cands), dtype=bool)
        for i in range(len(cands)):
            cik = ciks_s[i]
            if not cik or cik == "nan" or is_bench_raw[i]:
                continue
            key = (sig_days[i], cik)
            score = float(dv21[i])
            aid_i = aids[i]
            prev = best_by_key.get(key)
            if prev is None:
                best_by_key[key] = (score, aid_i, i)
            else:
                prev_score, prev_aid, prev_idx = prev
                # Higher 21d dollar volume wins; deterministic asset_id tie-breaker
                if (score > prev_score) or (score == prev_score and aid_i < prev_aid):
                    keep_mask[prev_idx] = False
                    best_by_key[key] = (score, aid_i, i)
                else:
                    keep_mask[i] = False
        dedup_dropped = int((~keep_mask).sum())
        if dedup_dropped > 0:
            cands = cands.loc[keep_mask].reset_index(drop=True)
            keep_list = np.flatnonzero(keep_mask).tolist()
            aids = [aids[i] for i in keep_list]
            sig_days = [sig_days[i] for i in keep_list]
            ciks_s = [ciks_s[i] for i in keep_list]
            asset_idxs = asset_idxs[keep_mask]
            sess_idxs = sess_idxs[keep_mask]

    dec_ns = clocks.instants(cands["decision_at"].to_numpy(dtype=object))

    # PIT fund_snap_id & causal event cursors per anchor row
    n = len(cands)
    snap_ids = np.full(n, -1, dtype=np.int32)
    ev_starts = np.zeros(n, dtype=np.int64)
    ev_ends = np.zeros(n, dtype=np.int64)
    offsets = event_store.asset_offsets
    ev_avail = event_store.available_at_ns
    for i in range(n):
        d_ns = int(dec_ns[i])
        if ciks_s[i] and ciks_s[i] != "nan" and d_ns != clocks.NAT:
            snap_ids[i] = fund_store.lookup_snap_id(ciks_s[i], d_ns)
        a_i = int(asset_idxs[i])
        if 0 <= a_i < len(offsets) - 1 and d_ns != clocks.NAT:
            s0 = int(offsets[a_i])
            s1 = int(offsets[a_i + 1])
            ev_starts[i] = s0
            if s1 > s0:
                cnt = int(np.searchsorted(ev_avail[s0:s1], d_ns, side="right"))
                ev_ends[i] = s0 + cnt
            else:
                ev_ends[i] = s0

    entry_vals = (
        cands["entry_session"].tolist()
        if "entry_session" in cands.columns
        else [None] * n
    )
    in_uni = (
        cands["in_universe"].fillna(False).to_numpy(dtype=bool)
        if "in_universe" in cands.columns
        else np.ones(n, dtype=bool)
    )
    is_bench = (
        cands["is_benchmark"].fillna(False).to_numpy(dtype=bool)
        if "is_benchmark" in cands.columns
        else np.zeros(n, dtype=bool)
    )
    df = pd.DataFrame(
        {
            "row_id": np.arange(n, dtype=np.int64),
            "asset_id": pd.Series(aids, dtype=object),
            "signal_session": pd.Series(sig_days, dtype=object),
            "entry_session": pd.Series(entry_vals, dtype=object),
            "decision_at": pd.to_datetime(cands["decision_at"], utc=True),
            "in_universe": in_uni,
            "is_benchmark": is_bench,
            "asset_idx": asset_idxs,
            "session_idx": sess_idxs,
            "fund_snap_id": snap_ids,
            "event_start_cursor": ev_starts,
            "event_end_cursor": ev_ends,
        }
    )
    order_sha = compute_anchor_order_sha256(df)
    return (
        Anchors(
            frame=df,
            order_sha256=order_sha,
            assets=tuple(asset_list),
            sessions=tuple(cal.days),
            time_policy=time_policy,
            sampling=sampling,
            benchmark_id=None,
        ),
        dedup_dropped,
    )


def _compute_labels(
    version: Any,
    anchors: Anchors,
    stores: Stores,
    *,
    cal: clocks.Calendar,
    horizons: Sequence[int],
    benchmark: str,
    universe: str,
    time_policy: str,
    max_date: date | None = None,
) -> pd.DataFrame:
    af = anchors.frame
    horizon_list, single = _labels.horizons(horizons)
    policy = _labels.terminal_policy(None)
    rule = _candidates.membership_rule(
        "universe_membership" in _candidates.families(version), universe, version
    )
    bench_id = str(version.resolve(benchmark)[0]) if benchmark else ""
    asset_ids = list(dict.fromkeys(af["asset_id"].astype(str)))
    signal_pos = cal.positions(af["signal_session"])
    n_cal = len(cal)
    first = (
        cal.days[min(int(signal_pos.min()) + 1, n_cal - 1)] if len(signal_pos) else None
    )
    last = (
        cal.days[min(int(signal_pos.max()) + max(horizon_list), n_cal - 1)]
        if len(signal_pos)
        else None
    )
    if max_date is not None and last is not None:
        last = min(last, max_date)
    inputs = _return_inputs(
        version,
        [*asset_ids, *([bench_id] if bench_id else [])],
        first,
        last,
    )
    series = _series(
        inputs,
        cal.days,
        list(dict.fromkeys([*asset_ids, *([bench_id] if bench_id else [])])),
    )
    manifest_cutoff = clocks.day(version.manifest["cutoff_date"])
    eff_cutoff = (
        min(manifest_cutoff, max_date) if max_date is not None else manifest_cutoff
    )
    y_base = _labels.label_frame(
        af[[*KEYS, "decision_at"]],
        series,
        cal,
        horizon_list=horizon_list,
        single=single,
        benchmark_id=bench_id or asset_ids[0],
        cutoff=eff_cutoff,
        policy=policy,
        in_universe=af["in_universe"],
        static=rule is None,
    )
    rf_arr: np.ndarray | None = None
    if "reference_series" in _candidates.families(version):
        rf_s = _risk_free_daily(
            version, series="DTB3", time_policy=time_policy
        ).reindex(list(cal.days))
        if rf_s.isna().any():
            rf_alt = _risk_free_daily(
                version, series="DGS3MO", time_policy=time_policy
            ).reindex(list(cal.days))
            rf_s = rf_s.combine_first(rf_alt)
        rf_arr = rf_s.to_numpy(dtype=np.float64)
    return _labels.attach_risk_adjusted_labels(
        y_base,
        af,
        stores.prices,
        cal=cal,
        horizons=horizon_list,
        rf_daily=rf_arr,
        cutoff_date=eff_cutoff,
        benchmark_idx=stores.prices.benchmark_idx,
    )


def _default_cache_root(version: Any, cache_dir: str | Path | None) -> Path:
    if cache_dir is not None:
        return Path(cache_dir)
    client = getattr(version, "_client", None)
    base = getattr(client, "cache_dir", None)
    if base is not None:
        return Path(base)
    return Path.home() / ".cache" / "research-datasets"


def materialize(
    version: Any,
    recipe_yaml: str | Mapping[str, Any] | None = None,
    *,
    cache_dir: str | Path | None = None,
    symbols: str | Sequence[str] | None = None,
    start: str | date | None = None,
    end: str | date | None = None,
    max_date: str | date | None = None,
    sampling: str | None = None,
    time_policy: str | None = None,
    universe: str = "pit",
    benchmark: str = "SPY",
    deduplicate_issuers: bool = True,
    include_news_events: bool = False,
    include_stores: bool = True,
    include_labels: bool = True,
) -> MaterializedDataset:
    """Materialize untruncated Stores + incrementally cached Feature Groups from a YAML recipe."""
    t0 = time.perf_counter()
    ensure_builtin_groups_loaded()
    if recipe_yaml is None and hasattr(version, "recipe_yaml"):
        recipe_yaml = version.recipe_yaml()
    recipe, norm_yaml, r_sha = validate_recipe(recipe_yaml)
    eff_policy = str(time_policy or recipe.get("time_policy", "public_reconstructed"))
    clocks.policy(eff_policy)
    eff_sampling = str(sampling or recipe.get("sampling", "weekly"))
    horizons = tuple(
        int(h) for h in recipe.get("horizons_trading_days", DEFAULT_HORIZONS)
    )
    max_d = clocks.day(max_date) if max_date is not None else None
    eff_end: str | date | None = end
    if max_d is not None:
        eff_end = min(clocks.day(end), max_d) if end is not None else max_d

    universe_records = _candidates.records(version.universe)
    all_assets = list(
        dict.fromkeys(str(r["asset_id"]) for r in universe_records if r.get("asset_id"))
    )
    bench_ids = version.resolve(benchmark) if benchmark else []
    bench_id = str(bench_ids[0]) if bench_ids else None

    selected_assets = (
        _candidates.default_assets(version.universe, bench_ids)
        if symbols is None or symbols == "all"
        else list(dict.fromkeys(map(str, version.resolve(symbols))))
    )
    anchor_spec = json.dumps(
        {
            "dataset_id": str(version.id),
            "manifest_sha256": str(version.manifest_sha256),
            "symbols": selected_assets
            if (symbols is not None and symbols != "all")
            else "default",
            "start": str(start) if start is not None else "",
            "end": str(eff_end) if eff_end is not None else "",
            "max_date": max_d.isoformat() if max_d is not None else "",
            "sampling": eff_sampling,
            "time_policy": eff_policy,
            "universe": universe,
            "benchmark": bench_id or "",
            "deduplicate_issuers": bool(deduplicate_issuers),
            "include_news_events": bool(include_news_events),
        },
        sort_keys=True,
    )
    spec_hash = hashlib.sha256(anchor_spec.encode("utf-8")).hexdigest()[:16]
    mat_root = _default_cache_root(version, cache_dir) / f"mat-{version.id}-{spec_hash}"
    stores_dir = mat_root / "stores"
    parts_dir = mat_root / "parts"

    cal_sessions = (
        [d for d in version.calendar if clocks.day(d) <= max_d]
        if max_d is not None
        else version.calendar
    )
    cal = _candidates.calendar(version, cal_sessions)
    dedup_dropped = 0
    if (stores_dir / "anchors.meta.json").is_file() and (
        stores_dir / "price_store.meta.json"
    ).is_file():
        stores = Stores.load(stores_dir, mmap=True)
        anchors = stores.anchors
    else:
        pstore = build_price_store(
            version, all_assets, cal.days, benchmark_id=bench_id, max_date=max_d
        )
        asset_pos = {aid: idx for idx, aid in enumerate(pstore.assets)}
        # Map each CIK to its primary active asset_idx for Event-Time Cross-Binding
        primary_cik_asset: dict[str, int] = {}
        for rec in universe_records:
            cik_raw = str(rec.get("cik") or "").strip()
            cik = cik_raw.zfill(10) if cik_raw.isdigit() else ""
            aid = str(rec.get("asset_id") or "")
            if cik and aid in asset_pos and cik not in primary_cik_asset:
                primary_cik_asset[cik] = asset_pos[aid]
        if "issuer_history" in _candidates.families(version):
            ih_df = version.family("issuer_history")
            if ih_df is not None and not ih_df.empty:
                for rec in ih_df.to_dict("records"):
                    if str(rec.get("status") or "") != "verified":
                        continue
                    cik_raw = str(rec.get("cik") or "").strip()
                    cik = cik_raw.zfill(10) if cik_raw.isdigit() else ""
                    aid = str(rec.get("asset_id") or "")
                    if cik and aid in asset_pos and cik not in primary_cik_asset:
                        primary_cik_asset[cik] = asset_pos[aid]
        all_ciks = sorted(primary_cik_asset)
        fstore = build_fund_store(
            version,
            all_ciks,
            time_policy=eff_policy,
            cal=cal,
            price_store=pstore,
            primary_asset_of_cik=primary_cik_asset,
            max_date=max_d,
        )
        estore = build_event_store(
            version,
            pstore.assets,
            time_policy=eff_policy,
            cal=cal,
            price_store=pstore,
            include_news=include_news_events,
            max_date=max_d,
        )
        mstore = build_macro_store(
            version,
            cal.days,
            time_policy=eff_policy,
            cal=cal,
            price_store=pstore,
            max_date=max_d,
        )
        anchors, dedup_dropped = _build_anchors(
            version,
            symbols=symbols,
            start=start,
            end=eff_end,
            sampling=eff_sampling,
            universe=universe,
            benchmark=benchmark,
            time_policy=eff_policy,
            cal=cal,
            assets=pstore.assets,
            price_store=pstore,
            fund_store=fstore,
            event_store=estore,
            deduplicate_issuers=deduplicate_issuers,
        )
        anchors.benchmark_id = bench_id
        stores = Stores(
            anchors=anchors,
            prices=pstore,
            fundamentals=fstore,
            events=estore,
            macro=mstore,
        )
        if max_d is not None:
            stores.assert_cutoff(max_d)
        stores.save(stores_dir)
        # Re-open PriceStore memory-mapped to drop eager write buffer RSS
        del pstore, fstore, estore, mstore, anchors, stores
        gc.collect()
        stores = Stores.load(stores_dir, mmap=True)
        anchors = stores.anchors

    if max_d is not None:
        stores.assert_cutoff(max_d)

    exclude_set = {str(c) for c in (recipe.get("exclude_columns") or ())}
    ctx: GroupBuildContext | None = None
    cached_groups: list[str] = []
    recomputed_groups: list[str] = []
    part_paths: dict[str, str] = {}
    declared_by_group: dict[str, list[str]] = {}

    active_specs: list[
        tuple[str, Any, dict[str, Any], list[str], str, Path, list[str]]
    ] = []
    all_cols: list[str] = []
    for gname, gcfg in recipe["feature_groups"].items():
        if not gcfg.get("enabled", True):
            continue
        spec = FEATURE_GROUPS[gname]
        merged_params = {
            **spec.default_params,
            **{k: v for k, v in gcfg.items() if k != "enabled"},
        }
        declared = list(group_columns(gname, merged_params))
        op_hash = spec.operator_hash(merged_params)
        p_path = _part_path(parts_dir, gname, op_hash)
        kept = [c for c in declared if c not in exclude_set]
        part_paths[gname] = str(p_path)
        declared_by_group[gname] = declared
        active_specs.append(
            (gname, spec, merged_params, declared, op_hash, p_path, kept)
        )
        all_cols.extend(kept)

    n_rows = len(anchors.frame)
    # Allocate one column-contiguous (C, N).T float32 buffer to avoid pd.concat RSS spike
    mat = (
        np.empty((len(all_cols), n_rows), dtype=np.float32).T
        if all_cols
        else np.empty((n_rows, 0), dtype=np.float32)
    )
    col_offset = 0

    for idx_g, (
        gname,
        spec,
        merged_params,
        declared,
        op_hash,
        p_path,
        kept,
    ) in enumerate(active_specs):
        remaining_groups = {item[0] for item in active_specs[idx_g + 1 :]}
        if p_path.is_file():
            part_df = _read_verified_part(
                p_path,
                group_name=gname,
                expected_rows=n_rows,
                anchor_order_sha256=anchors.order_sha256,
                manifest_sha256=str(version.manifest_sha256),
                time_policy=eff_policy,
                op_hash=op_hash,
                kept_columns=kept,
            )
            cached_groups.append(gname)
            for j, c in enumerate(kept):
                mat[:, col_offset + j] = part_df[c].to_numpy(
                    dtype=np.float32, copy=False
                )
            col_offset += len(kept)
            del part_df
        else:
            if ctx is None:
                ctx = GroupBuildContext(
                    version=version,
                    stores=stores,
                    time_policy=eff_policy,
                    benchmark_id=bench_id,
                    horizons=horizons,
                )
            built = spec.builder(ctx, merged_params)
            missing_cols = [c for c in declared if c not in built.columns]
            if missing_cols:
                raise DatasetError("INTEGRITY", f"{gname} 缺少声明列：{missing_cols}")
            _write_verified_part(
                p_path,
                built,
                declared,
                anchor_order_sha256=anchors.order_sha256,
                manifest_sha256=str(version.manifest_sha256),
                time_policy=eff_policy,
                op_hash=op_hash,
            )
            for j, c in enumerate(kept):
                mat[:, col_offset + j] = built[c].to_numpy(dtype=np.float32, copy=False)
            col_offset += len(kept)
            recomputed_groups.append(gname)
            del built
            ctx.release_derived_if_unused(remaining_groups)
            gc.collect()

    if all_cols:
        X = pd.DataFrame(mat, index=anchors.frame.index, columns=all_cols, copy=False)
    else:
        X = pd.DataFrame(index=anchors.frame.index)
    del mat, ctx
    gc.collect()

    # Enforce hard physical barrier: pointer columns & forbidden tokens never enter X
    hits = audit_features(list(X.columns))
    if not hits.empty:
        raise DatasetError(
            "INTEGRITY", f"特征矩阵审计未通过：{hits.to_dict('records')}"
        )

    y_df: pd.DataFrame | None = None
    if include_labels and "daily_returns" in _candidates.families(version):
        labels_path = stores_dir / f"labels_{'_'.join(map(str, horizons))}.parquet"
        if labels_path.is_file():
            y_df = pq.read_table(labels_path).to_pandas()
        else:
            y_df = _compute_labels(
                version,
                anchors,
                stores,
                cal=cal,
                horizons=horizons,
                benchmark=benchmark,
                universe=universe,
                time_policy=eff_policy,
                max_date=max_d,
            )
            y_serializable = y_df.copy()
            for c in y_serializable.columns:
                if isinstance(y_serializable[c].dtype, pd.CategoricalDtype):
                    y_serializable[c] = y_serializable[c].astype(str)
            tmp_y = labels_path.with_suffix(".parquet.tmp")
            y_serializable.to_parquet(tmp_y, index=False, engine="pyarrow")
            tmp_y.replace(labels_path)
            del y_serializable
            gc.collect()

    report = {
        "cache_root": str(mat_root),
        "anchor_order_sha256": anchors.order_sha256,
        "cached_groups": cached_groups,
        "recomputed_groups": recomputed_groups,
        "part_paths": part_paths,
        "group_columns": declared_by_group,
        "bridge_columns": list(recipe.get("bridge_columns") or ()),
        "exclude_columns": sorted(exclude_set),
        "max_date": max_d.isoformat() if max_d is not None else None,
        "deduplicate_issuers": bool(deduplicate_issuers),
        "dedup_dropped_rows": dedup_dropped,
        "include_news_events": bool(include_news_events),
        "audit_passed": True,
        "rows": len(anchors.frame),
        "columns": len(X.columns),
        "elapsed_seconds": round(time.perf_counter() - t0, 3),
    }
    return MaterializedDataset(
        dataset_id=str(version.id),
        manifest_sha256=str(version.manifest_sha256),
        recipe_yaml=norm_yaml,
        recipe_sha256=r_sha,
        recipe=recipe,
        anchors=anchors,
        stores=stores if include_stores else None,
        X=X,
        y=y_df,
        report=report,
    )
