"""Typed SEC filing events, earnings announcement timing, EAR, and SUE features.

Every feature builder in this module is strictly point-in-time at ``decision_at``
(inclusive ``available_at <= decision_at``) and vectorized per security over sorted
availability clocks using ``numpy.searchsorted``. Ex-post fields such as
``is_primary_final`` and ``period_end`` matched from a later periodic report are
never read by feature builders; ``label_announcement_flags`` is reserved for label
diagnostics only.
"""

from __future__ import annotations

import calendar as _py_calendar
import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, time, timedelta
from types import MappingProxyType
from typing import Any

import numpy as np
import pandas as pd

from . import clocks as _clocks
from . import labels as _labels
from .clocks import GRACE_NS, NAT, NEVER, NEW_YORK
from .concepts import STALE_AFTER_DAYS
from .constants import DEFAULT_HORIZONS, EARNINGS_FEATURES, KEYS, SEC_SOURCES
from .events import EventSpec

_DAY_NS = 86_400_000_000_000
_YEAR_365_NS = 365 * _DAY_NS
_COUNTABLE_COVERAGE = frozenset({"checked", "empty", "read_complete"})

EARNINGS_KINDS: tuple[str, ...] = ("8k_item_2_02", "periodic_report")
NEXT_BASES: tuple[str, ...] = ("finnhub_calendar", "prior_year_lag")
SUE_BASES: tuple[str, ...] = (
    "reported",
    "ytd_diff",
    "fy_minus_ytd",
    "fy_minus_ytd_approx",
    "composite",
)

_DEFAULT_ITEMS: Mapping[str, str] = MappingProxyType(
    {
        "1.01": "material_agreement",
        "1.02": "agreement_termination",
        "1.03": "bankruptcy",
        "1.05": "cybersecurity_incident",
        "2.01": "acquisition_or_disposition_completed",
        "2.02": "results_release",
        "2.03": "debt_obligation",
        "2.04": "debt_acceleration",
        "2.05": "exit_costs",
        "2.06": "impairment",
        "3.01": "listing_deficiency",
        "3.02": "unregistered_equity_sale",
        "3.03": "holder_rights_modified",
        "4.01": "auditor_change",
        "4.02": "non_reliance",
        "5.01": "control_change",
        "5.02": "officer_director_change",
        "5.03": "charter_bylaw_or_fiscal_year_change",
        "5.07": "shareholder_vote",
        "7.01": "regulation_fd",
        "8.01": "other_event",
    }
)

_DEFAULT_FORMS: Mapping[str, str] = MappingProxyType(
    {
        "10-K": "annual_report",
        "10-KT": "annual_report",
        "20-F": "annual_report",
        "40-F": "annual_report",
        "10-Q": "quarterly_report",
        "10-QT": "quarterly_report",
        "6-K": "foreign_current_report",
        "NT 10-K": "late_filing_notice",
        "NT 10-Q": "late_filing_notice",
        "NT 20-F": "late_filing_notice",
        "S-3": "shelf_registration",
        "S-3ASR": "shelf_registration",
        "S-4": "merger_registration",
        "424B1": "prospectus_supplement",
        "424B3": "prospectus_supplement",
        "424B4": "prospectus_supplement",
        "424B5": "prospectus_supplement",
        "424B7": "prospectus_supplement",
        "SC 13D": "activist_stake",
        "SCHEDULE 13D": "activist_stake",
        "25": "exchange_delisting_notice",
        "25-NSE": "exchange_delisting_notice",
        "15-12B": "registration_termination",
        "15-12G": "registration_termination",
        "15-15D": "registration_termination",
        "15F-12B": "registration_termination",
        "15F-12G": "registration_termination",
        "15F-15D": "registration_termination",
        "DEFM14A": "merger_proxy",
        "PREM14A": "merger_proxy",
        "SC TO-T": "third_party_tender_offer",
        "SC 14D9": "tender_offer_response",
        "SC TO-I": "issuer_tender_offer",
    }
)


def _build_default_kinds() -> tuple[str, ...]:
    ordered: list[str] = []
    for kind in _DEFAULT_ITEMS.values():
        if kind not in ordered:
            ordered.append(kind)
    ordered.append("current_report_amendment")
    base_form_kinds: list[str] = []
    for kind in _DEFAULT_FORMS.values():
        if kind not in base_form_kinds:
            base_form_kinds.append(kind)
    for kind in base_form_kinds:
        if kind not in ordered:
            ordered.append(kind)
    for kind in base_form_kinds:
        amend = f"{kind}_amendment"
        if amend not in ordered:
            ordered.append(amend)
    return tuple(ordered)


DEFAULT_SEC_EVENT_VOCABULARY: Mapping[str, Any] = MappingProxyType(
    {
        "version": "sec-kinds-v1",
        "kinds": _build_default_kinds(),
        "items": _DEFAULT_ITEMS,
        "forms": _DEFAULT_FORMS,
    }
)


def sec_public_clock(
    public_at: Any,
    filing_date: Any = None,
    *,
    holiday_fallback: bool = False,
) -> pd.Timestamp | None:
    """Idempotent SEC public instant: ``max(acceptance, 06:00 New York on filing_date)``."""
    accepted = _clocks.clock(public_at)
    if accepted is None:
        return None
    filed: date | None = None
    if isinstance(filing_date, date) and not isinstance(filing_date, pd.Timestamp):
        filed = filing_date
    elif isinstance(filing_date, str) and filing_date.strip():
        try:
            filed = _clocks.day_str(filing_date.strip())
        except ValueError:
            filed = None
    if filed is not None:
        return _clocks.sec_public(accepted, filed)
    if holiday_fallback:
        return _clocks.sec_public_fallback(accepted, None)
    return accepted


def _extract_vocabulary(
    version_or_manifest: Any, *, fallback: bool = False
) -> dict[str, Any] | None:
    manifest = getattr(version_or_manifest, "manifest", version_or_manifest)
    raw = (
        manifest.get("sec_event_kinds")
        if isinstance(manifest, Mapping) and "sec_event_kinds" in manifest
        else (
            manifest
            if isinstance(manifest, Mapping)
            and any(k in manifest for k in ("kinds", "items", "forms"))
            else None
        )
    )
    if not isinstance(raw, Mapping) or not raw:
        return dict(DEFAULT_SEC_EVENT_VOCABULARY) if fallback else None

    if "kinds" in raw or "items" in raw or "forms" in raw:
        items = {str(k): str(v) for k, v in (raw.get("items") or {}).items()}
        forms = {str(k): str(v) for k, v in (raw.get("forms") or {}).items()}
        if isinstance(raw.get("kinds"), Sequence) and not isinstance(
            raw.get("kinds"), str
        ):
            kinds = [str(k) for k in raw["kinds"] if str(k)]
        else:
            kinds = []
            for v in items.values():
                if v not in kinds:
                    kinds.append(v)
            if items and "current_report_amendment" not in kinds:
                kinds.append("current_report_amendment")
            for v in forms.values():
                if v not in kinds:
                    kinds.append(v)
                amend = f"{v}_amendment"
                if amend not in kinds:
                    kinds.append(amend)
        return {"items": items, "forms": forms, "kinds": list(dict.fromkeys(kinds))}

    # Support compact kind-keyed mapping {kind: {"items": [...], "forms": [...]}}
    items_map: dict[str, str] = {}
    forms_map: dict[str, str] = {}
    kinds_list: list[str] = []
    for kind, spec in raw.items():
        kind_s = str(kind)
        if not kind_s:
            continue
        kinds_list.append(kind_s)
        if isinstance(spec, Mapping):
            for it in spec.get("items") or ():
                items_map[str(it).strip()] = kind_s
            for fm in spec.get("forms") or ():
                forms_map[str(fm).strip()] = kind_s
    return {
        "items": items_map,
        "forms": forms_map,
        "kinds": list(dict.fromkeys(kinds_list)),
    }


def classify_sec_filing(
    form: Any,
    items: Any = "",
    vocabulary: Mapping[str, Any] | None = None,
) -> list[str]:
    """Classify one SEC filing into typed event kinds.

    ``8-K/A`` maps exclusively to ``current_report_amendment`` (ignoring repeated item
    codes). ``8-K`` maps comma-separated item numbers; other forms map to their base
    kind or ``<kind>_amendment`` when suffixed with ``/A``.
    """
    if form is None or (not isinstance(form, str) and pd.isna(form)):
        return []
    form_s = str(form).strip()
    if not form_s:
        return []

    parsed = (
        _extract_vocabulary(vocabulary, fallback=True)
        if vocabulary is not None
        else dict(DEFAULT_SEC_EVENT_VOCABULARY)
    )
    assert parsed is not None
    item_map: Mapping[str, str] = parsed["items"]
    form_map: Mapping[str, str] = parsed["forms"]
    use_prefix_defaults = vocabulary is None or (
        "items" in vocabulary or "forms" in vocabulary or "kinds" in vocabulary
    )

    if form_s == "8-K/A":
        return ["current_report_amendment"]
    if form_s == "8-K":
        if items is None or (not isinstance(items, str) and pd.isna(items)):
            return []
        found: list[str] = []
        for token in str(items).split(","):
            code = token.strip()
            mapped = item_map.get(code)
            if mapped and mapped not in found:
                found.append(mapped)
        return found

    amended = form_s.endswith("/A")
    base = form_s[:-2].strip() if amended else form_s
    base_kind = form_map.get(base)
    if base_kind is None and use_prefix_defaults:
        if base.startswith("NT "):
            base_kind = "late_filing_notice"
        elif base.startswith(("15-", "15F-")):
            base_kind = "registration_termination"
    if base_kind is None:
        return []
    return [f"{base_kind}_amendment" if amended else base_kind]


def sec_event_specs(
    version_or_manifest: Any,
    *,
    prefix: str = "sec_kind_",
    fallback: bool = False,
) -> tuple[EventSpec, ...]:
    """Build typed ``EventSpec`` definitions from a manifest's ``sec_event_kinds`` vocabulary."""
    vocab = _extract_vocabulary(version_or_manifest, fallback=fallback)
    if vocab is None:
        return ()
    return tuple(
        EventSpec(f"{prefix}{kind}", "sec", kinds_any=frozenset({kind}))
        for kind in vocab["kinds"]
    )


def _ensure_calendar(calendar: _clocks.Calendar | Sequence[Any]) -> _clocks.Calendar:
    return (
        calendar
        if isinstance(calendar, _clocks.Calendar)
        else _clocks.Calendar(calendar)
    )


def _sample_coverage_ok(samples: pd.DataFrame) -> np.ndarray:
    for col in ("sec_history_coverage", "sec_coverage"):
        if col in samples.columns:
            vals = samples[col].astype(object).fillna("").astype(str).to_numpy()
            return np.isin(vals, list(_COUNTABLE_COVERAGE))
    return np.ones(len(samples), dtype=bool)


def _sample_decisions_and_positions(
    samples: pd.DataFrame, cal: _clocks.Calendar
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    if not set(KEYS).issubset(samples.columns):
        raise ValueError(f"samples requires columns {KEYS}")
    sig_pos = cal.positions(samples["signal_session"])
    if "decision_at" in samples.columns:
        dec_ns = _clocks.instants(samples["decision_at"])
    else:
        dec_ns = cal.decisions[np.minimum(sig_pos + 1, len(cal.decisions) - 1)].copy()
    valid = dec_ns != NAT
    ref_ord = np.zeros(len(samples), dtype=np.int64)
    if valid.any():
        ref_ord[valid] = _clocks.local_ordinals(dec_ns[valid], NEW_YORK)
    return sig_pos, dec_ns, ref_ord


def _clock_lookup(
    clocks_frame: pd.DataFrame | None,
) -> tuple[dict[tuple[str, str], int], dict[str, int]]:
    by_pair: dict[tuple[str, str], int] = {}
    by_uid: dict[str, int] = {}
    if (
        clocks_frame is None
        or clocks_frame.empty
        or "event_uid" not in clocks_frame.columns
    ):
        return by_pair, by_uid
    clock_col = (
        "available_at"
        if "available_at" in clocks_frame.columns
        else ("public_at" if "public_at" in clocks_frame.columns else None)
    )
    if clock_col is None:
        return by_pair, by_uid
    ns_arr = _clocks.instants(clocks_frame[clock_col].to_numpy(dtype=object))
    uids = clocks_frame["event_uid"].astype(str).to_numpy(dtype=object)
    if "asset_id" in clocks_frame.columns:
        assets = clocks_frame["asset_id"].astype(str).to_numpy(dtype=object)
        for a, u, ns in zip(assets, uids, ns_arr.tolist()):
            if ns != NAT:
                prev = by_pair.get((a, u))
                by_pair[(a, u)] = ns if prev is None else min(prev, ns)
    for u, ns in zip(uids, ns_arr.tolist()):
        if ns != NAT:
            prev = by_uid.get(u)
            by_uid[u] = ns if prev is None else min(prev, ns)
    return by_pair, by_uid


def _extract_row_kinds(
    frame: pd.DataFrame,
    chain: np.ndarray,
    vocabulary: Mapping[str, Any] | None,
) -> list[tuple[str, ...]]:
    has_ek = "event_kinds" in frame.columns
    has_form = "form" in frame.columns
    ek_cells = (
        frame["event_kinds"].to_numpy(dtype=object)
        if has_ek
        else np.full(len(frame), None, dtype=object)
    )
    form_cells = (
        frame["form"].to_numpy(dtype=object)
        if has_form
        else np.full(len(frame), None, dtype=object)
    )
    item_cells = (
        frame["items"].to_numpy(dtype=object)
        if "items" in frame.columns
        else np.full(len(frame), "", dtype=object)
    )
    out: list[tuple[str, ...]] = []
    last_chain = -1
    cur_form: Any = None
    cur_items: Any = ""
    cur_ek: tuple[str, ...] | None = None
    for ch, ek, fm, it in zip(chain.tolist(), ek_cells, form_cells, item_cells):
        if ch != last_chain:
            last_chain = ch
            cur_form, cur_items, cur_ek = None, "", None
        if isinstance(fm, str) and fm != "":
            cur_form = fm
        if isinstance(it, str) and it != "":
            cur_items = it
        if isinstance(ek, (list, tuple, np.ndarray)):
            cur_ek = tuple(str(x) for x in ek if x is not None and str(x) != "")
        if cur_ek is not None:
            out.append(cur_ek)
        elif cur_form is not None:
            out.append(tuple(classify_sec_filing(cur_form, cur_items, vocabulary)))
        else:
            out.append(())
    return out


def _sec_event_intervals(
    observations: pd.DataFrame,
    selected_assets: set[str],
    wanted_kinds: set[str],
    *,
    time_policy: str,
    zones: Mapping[str, str],
    clocks_frame: pd.DataFrame | None,
    vocabulary: Mapping[str, Any] | None,
) -> dict[tuple[str, str], tuple[np.ndarray, list[tuple[int, int, int]]]]:
    """Return per ``(asset_id, kind)`` -> ``(permanent_sorted_clocks, transient_intervals)``.

    Permanent events remain visible for all ``cutoff >= clock_ns``; transient intervals
    ``(event_clock_ns, vis_low_ns, vis_high_ns)`` handle ``observed_content`` versions
    where a link or kind is added after publication or later removed.
    """
    if (
        observations is None
        or observations.empty
        or not selected_assets
        or not wanted_kinds
    ):
        return {}

    frame = observations
    if "source" in frame.columns:
        frame = frame[frame["source"].astype(str) == "sec"]
    if frame.empty or "event_uid" not in frame.columns:
        return {}

    frame = frame.copy()
    if "source" not in frame.columns:
        frame["source"] = "sec"
    if "public_time_precision" not in frame.columns:
        frame["public_time_precision"] = np.where(
            frame["public_at"].notna() & (frame["public_at"].astype(str) != "")
            if "public_at" in frame.columns
            else False,
            "second",
            "unknown",
        )
    seq = (
        pd.to_numeric(frame["observation_sequence"], errors="coerce")
        .fillna(1)
        .to_numpy(dtype=np.int64)
        if "observation_sequence" in frame.columns
        else np.ones(len(frame), dtype=np.int64)
    )
    uid_arr = frame["event_uid"].astype(str).to_numpy(dtype=object)
    uid_code, _ = pd.factorize(pd.Series(uid_arr, dtype=object), sort=True)
    order = np.lexsort((seq, uid_code))
    frame = frame.iloc[order].reset_index(drop=True)
    seq = seq[order]
    uid_code = uid_code[order]
    uid_arr = uid_arr[order]
    chain = np.cumsum(np.r_[True, uid_code[1:] != uid_code[:-1]]) - 1
    starts = np.flatnonzero(np.r_[True, chain[1:] != chain[:-1]])
    latest = np.r_[starts[1:], len(frame)] - 1

    public_ns, invalid = _clocks.public_clocks(frame, zones)
    row_kinds = _extract_row_kinds(frame, chain, vocabulary)
    by_pair_clock, by_uid_clock = _clock_lookup(clocks_frame)

    links_col = (
        frame["asset_ids"].to_numpy(dtype=object)
        if "asset_ids" in frame.columns
        else np.full(len(frame), None, dtype=object)
    )

    perm_lists: dict[tuple[str, str], list[int]] = {}
    trans_lists: dict[tuple[str, str], list[tuple[int, int, int]]] = {}

    if time_policy == "public_reconstructed":
        first_pub = np.minimum.reduceat(
            np.where(public_ns == NAT, NEVER, public_ns), starts
        )
        for ch_idx, last_row in enumerate(latest.tolist()):
            kinds_here = [k for k in row_kinds[last_row] if k in wanted_kinds]
            if not kinds_here:
                continue
            raw_assets = links_col[last_row]
            if not isinstance(raw_assets, (list, tuple, np.ndarray)):
                continue
            uid = str(uid_arr[last_row])
            base_clock = by_uid_clock.get(uid, int(first_pub[ch_idx]))
            for raw_a in dict.fromkeys(str(x) for x in raw_assets if x is not None):
                if raw_a not in selected_assets:
                    continue
                ev_clock = by_pair_clock.get((raw_a, uid), base_clock)
                if ev_clock == NAT or ev_clock == NEVER:
                    continue
                for k in kinds_here:
                    perm_lists.setdefault((raw_a, k), []).append(int(ev_clock))
    else:
        captures: list[np.ndarray] = []
        for cap_name in ("content_first_seen_at", "observation_recorded_at"):
            if cap_name in frame.columns:
                captures.append(
                    _clocks.instants(frame[cap_name].to_numpy(dtype=object))
                )
        avail_ns = (
            _clocks.available_at(public_ns, invalid, "observed_content", captures)
            if captures
            else public_ns.copy()
        )
        first_seen_col = (
            frame["asset_first_seen_at"].to_numpy(dtype=object)
            if "asset_first_seen_at" in frame.columns
            else np.full(len(frame), None, dtype=object)
        )
        for ch_idx, s_row in enumerate(starts.tolist()):
            e_row = int(latest[ch_idx]) + 1
            uid = str(uid_arr[s_row])
            # Build monotone sequence segments [seg_low, seg_high)
            timed_rows = [r for r in range(s_row, e_row) if int(avail_ns[r]) != NAT]
            if not timed_rows:
                continue
            timed_rows.sort(key=lambda r: (int(avail_ns[r]), int(seq[r])))
            segments: list[tuple[int, int]] = []
            max_seq = -1
            for r in timed_rows:
                if int(seq[r]) > max_seq:
                    max_seq = int(seq[r])
                    segments.append((r, int(avail_ns[r])))
            # Earliest association clock per asset across the chain
            first_assoc_by_asset: dict[str, int] = {}
            seg_bounds: list[tuple[int, int, int]] = []
            for seg_i, (r, low_ns) in enumerate(segments):
                high_ns = segments[seg_i + 1][1] if seg_i + 1 < len(segments) else NEVER
                if low_ns >= high_ns:
                    continue
                seg_bounds.append((r, low_ns, high_ns))
                raw_assets = links_col[r]
                if not isinstance(raw_assets, (list, tuple, np.ndarray)):
                    continue
                fs_map = _clocks.mapping(first_seen_col[r])
                for raw_a in dict.fromkeys(str(x) for x in raw_assets if x is not None):
                    if raw_a not in selected_assets:
                        continue
                    pair_override = by_pair_clock.get((raw_a, uid))
                    if pair_override is not None:
                        assoc = pair_override
                    else:
                        fs_ts = _clocks.clock(fs_map.get(raw_a)) if fs_map else None
                        assoc = (
                            max(low_ns, int(fs_ts.as_unit("ns").value) - GRACE_NS)
                            if fs_ts is not None
                            else low_ns
                        )
                    prev = first_assoc_by_asset.get(raw_a)
                    first_assoc_by_asset[raw_a] = (
                        assoc if prev is None else min(prev, assoc)
                    )

            # Merge contiguous visibility spans per (asset, kind)
            active_spans: dict[tuple[str, str], list[list[int]]] = {}
            for r, low_ns, high_ns in seg_bounds:
                kinds_here = [k for k in row_kinds[r] if k in wanted_kinds]
                if not kinds_here:
                    continue
                raw_assets = links_col[r]
                if not isinstance(raw_assets, (list, tuple, np.ndarray)):
                    continue
                fs_map = _clocks.mapping(first_seen_col[r])
                for raw_a in dict.fromkeys(str(x) for x in raw_assets if x is not None):
                    if raw_a not in selected_assets:
                        continue
                    pair_override = by_pair_clock.get((raw_a, uid))
                    if pair_override is not None:
                        eff_low = max(low_ns, pair_override)
                    elif first_seen_col[r] is not None:
                        fs_ts = _clocks.clock(fs_map.get(raw_a))
                        if fs_ts is None:
                            continue
                        eff_low = max(low_ns, int(fs_ts.as_unit("ns").value) - GRACE_NS)
                    else:
                        eff_low = low_ns
                    if eff_low >= high_ns:
                        continue
                    for k in kinds_here:
                        spans = active_spans.setdefault((raw_a, k), [])
                        if spans and spans[-1][1] == eff_low:
                            spans[-1][1] = high_ns
                        elif spans and spans[-1][1] >= eff_low:
                            spans[-1][1] = max(spans[-1][1], high_ns)
                        else:
                            spans.append([eff_low, high_ns])

            for (a_id, k_name), spans in active_spans.items():
                ev_clock = first_assoc_by_asset[a_id]
                if len(spans) == 1 and spans[0][0] == ev_clock and spans[0][1] == NEVER:
                    perm_lists.setdefault((a_id, k_name), []).append(ev_clock)
                else:
                    for s_low, s_high in spans:
                        trans_lists.setdefault((a_id, k_name), []).append(
                            (ev_clock, s_low, s_high)
                        )

    compiled: dict[tuple[str, str], tuple[np.ndarray, list[tuple[int, int, int]]]] = {}
    all_keys = set(perm_lists) | set(trans_lists)
    for key in all_keys:
        arr = np.array(sorted(perm_lists.get(key, ())), dtype=np.int64)
        compiled[key] = (arr, trans_lists.get(key, []))
    return compiled


def typed_event_features(
    observations: pd.DataFrame,
    samples: pd.DataFrame,
    *,
    kinds: Sequence[str],
    calendar: _clocks.Calendar | Sequence[Any],
    windows: Sequence[int] = (63,),
    clocks: pd.DataFrame | None = None,
    time_policy: str = "public_reconstructed",
    zones: Mapping[str, str] | None = None,
    vocabulary: Mapping[str, Any] | None = None,
    bulk_kinds: Sequence[str] = ("prospectus_supplement", "activist_stake"),
    bulk_threshold: int = 24,
    days_cap: int = 730,
) -> pd.DataFrame:
    """Vectorized SEC typed-event counts, days-since, and bulk-filer flags per sample."""
    _clocks.policy(time_policy)
    cal = _ensure_calendar(calendar)
    kind_list = list(dict.fromkeys(str(k) for k in kinds if str(k)))
    win_list = [int(w) for w in dict.fromkeys(windows)]
    if any(w <= 0 for w in win_list):
        raise ValueError("windows must contain positive session counts")
    bulk_set = frozenset(str(k) for k in bulk_kinds)

    sig_pos, dec_ns, _ = _sample_decisions_and_positions(samples, cal)
    cov_ok = _sample_coverage_ok(samples) & (dec_ns != NAT)
    n = len(samples)
    assets_col = samples["asset_id"].astype(str).to_numpy(dtype=object)
    selected_assets = set(assets_col.tolist())

    intervals = _sec_event_intervals(
        observations,
        selected_assets,
        set(kind_list),
        time_policy=time_policy,
        zones=zones or {},
        clocks_frame=clocks,
        vocabulary=vocabulary,
    )

    # Precompute window lower bounds (cutoff - W sessions) per sample row
    low_bounds: dict[int, np.ndarray] = {}
    win_valid: dict[int, np.ndarray] = {}
    for w in win_list:
        idx_low = sig_pos + 1 - w
        valid_w = cov_ok & (idx_low >= 0) & (idx_low < len(cal.decisions))
        bound = np.where(
            valid_w,
            cal.decisions[np.clip(idx_low, 0, len(cal.decisions) - 1)],
            NAT,
        )
        valid_w &= bound != NAT
        low_bounds[w] = bound
        win_valid[w] = valid_w

    # Group sample indices by asset_id once
    asset_groups: dict[str, np.ndarray] = {}
    codes, uniques = pd.factorize(pd.Series(assets_col, dtype=object), sort=False)
    for code, asset_name in enumerate(uniques):
        asset_groups[str(asset_name)] = np.flatnonzero(codes == code)

    out_cols: dict[str, Any] = {
        "asset_id": samples["asset_id"].to_numpy(),
        "signal_session": samples["signal_session"].to_numpy(),
    }

    for kind in kind_list:
        counts_by_w = {w: np.full(n, np.nan, dtype=np.float64) for w in win_list}
        days_since = np.full(n, np.nan, dtype=np.float64)
        is_bulk = np.zeros(n, dtype=bool) if kind in bulk_set else None

        for asset_id, rows_idx in asset_groups.items():
            ok_mask = cov_ok[rows_idx]
            if not ok_mask.any():
                continue
            active_idx = rows_idx[ok_mask]
            c_ns = dec_ns[active_idx]
            entry = intervals.get((asset_id, kind))
            perm = entry[0] if entry is not None else np.empty(0, dtype=np.int64)
            trans = entry[1] if entry is not None else []

            # Count in each session window (lower, c_ns]
            for w in win_list:
                w_ok = win_valid[w][active_idx]
                if not w_ok.any():
                    continue
                w_rows = active_idx[w_ok]
                hi = dec_ns[w_rows]
                lo = low_bounds[w][w_rows]
                cnt = (
                    np.searchsorted(perm, hi, "right")
                    - np.searchsorted(perm, lo, "right")
                ).astype(np.float64)
                for ev_c, v_lo, v_hi in trans:
                    vis = (v_lo <= hi) & (hi < v_hi) & (lo < ev_c) & (ev_c <= hi)
                    cnt += vis.astype(np.float64)
                counts_by_w[w][w_rows] = cnt

            # Latest event clock <= c_ns for days_since
            last_ev = np.full(len(active_idx), NAT, dtype=np.int64)
            if perm.size:
                pos = np.searchsorted(perm, c_ns, "right") - 1
                has_perm = pos >= 0
                last_ev[has_perm] = perm[np.maximum(pos, 0)][has_perm]
            for ev_c, v_lo, v_hi in trans:
                vis = (v_lo <= c_ns) & (c_ns < v_hi) & (ev_c <= c_ns)
                if vis.any():
                    last_ev[vis] = np.maximum(last_ev[vis], ev_c)
            found = last_ev != NAT
            if found.any():
                delta_days = (c_ns[found] - last_ev[found]) / float(_DAY_NS)
                delta_days = np.where(delta_days <= days_cap, delta_days, np.nan)
                days_since[active_idx[found]] = delta_days

            # Bulk 365-day guard
            if is_bulk is not None:
                lo_365 = c_ns - _YEAR_365_NS
                cnt_365 = np.searchsorted(perm, c_ns, "right") - np.searchsorted(
                    perm, lo_365, "right"
                )
                for ev_c, v_lo, v_hi in trans:
                    vis = (
                        (v_lo <= c_ns)
                        & (c_ns < v_hi)
                        & (lo_365 < ev_c)
                        & (ev_c <= c_ns)
                    )
                    cnt_365 = cnt_365 + vis.astype(np.int64)
                flagged = cnt_365 > bulk_threshold
                if flagged.any():
                    flagged_rows = active_idx[flagged]
                    is_bulk[flagged_rows] = True
                    for w in win_list:
                        counts_by_w[w][flagged_rows] = np.nan

        for w in win_list:
            out_cols[f"sec_kind_{kind}_count_{w}s"] = counts_by_w[w]
        out_cols[f"sec_kind_{kind}_days_since"] = days_since
        if is_bulk is not None:
            out_cols[f"sec_kind_{kind}_bulk"] = pd.arrays.BooleanArray(is_bulk, ~cov_ok)

    return pd.DataFrame(out_cols)


# ---------------------------------------------------------------------------
# Earnings announcement timing, EAR, Finnhub calendar, and SUE
# ---------------------------------------------------------------------------


def _next_estimated_period_end(period_end: date) -> date:
    """Step forward one quarter: calendar month-end +3 months, else +91 days."""
    is_month_end = (period_end + timedelta(days=1)).day == 1
    if is_month_end:
        total_months = (period_end.year * 12 + (period_end.month - 1)) + 3
        ny, nm = divmod(total_months, 12)
        nm += 1
        last_day = _py_calendar.monthrange(ny, nm)[1]
        return date(ny, nm, last_day)
    return period_end + timedelta(days=91)


def _return_levels_matrix(
    cal: _clocks.Calendar,
    assets: Sequence[str],
    adjusted: pd.DataFrame | None,
    daily_returns: pd.DataFrame | None,
) -> tuple[np.ndarray, dict[str, int]]:
    """Build sessions x assets close-level matrix preferring ``daily_returns.tr_index``."""
    asset_list = list(dict.fromkeys(str(a) for a in assets))
    pos_map = {a: idx for idx, a in enumerate(asset_list)}
    day_map = {d.isoformat(): idx for idx, d in enumerate(cal.days)}
    mat = np.full((len(cal.days), len(asset_list)), np.nan, dtype=np.float64)

    def _fill_from(df: pd.DataFrame, val_col: str, skip_terminal: bool) -> set[str]:
        filled: set[str] = set()
        if (
            df is None
            or df.empty
            or not {"asset_id", "date", val_col}.issubset(df.columns)
        ):
            return filled
        sub = df
        if skip_terminal and "row_kind" in sub.columns:
            sub = sub[sub["row_kind"].astype(str) != "terminal"]
        if sub.empty:
            return filled
        a_col = sub["asset_id"].astype(str).to_numpy(dtype=object)
        d_raw = sub["date"]
        d_keys = (
            d_raw.dt.strftime("%Y-%m-%d").to_numpy(dtype=object)
            if pd.api.types.is_datetime64_any_dtype(d_raw.dtype)
            else np.array([_clocks.day(x).isoformat() for x in d_raw], dtype=object)
        )
        vals = pd.to_numeric(sub[val_col], errors="coerce").to_numpy(dtype=np.float64)
        for a_str, d_str, v in zip(a_col, d_keys, vals.tolist()):
            c_idx = pos_map.get(str(a_str))
            r_idx = day_map.get(str(d_str))
            if c_idx is not None and r_idx is not None and np.isfinite(v) and v > 0:
                mat[r_idx, c_idx] = v
                filled.add(str(a_str))
        return filled

    tr_assets = (
        _fill_from(daily_returns, "tr_index", skip_terminal=True)
        if daily_returns is not None
        else set()
    )
    if adjusted is not None and len(tr_assets) < len(asset_list):
        rem = (
            adjusted[~adjusted["asset_id"].astype(str).isin(tr_assets)]
            if "asset_id" in adjusted.columns
            else adjusted
        )
        _fill_from(rem, "close", skip_terminal=False)
    return mat, pos_map


@dataclass(frozen=True)
class _CandRow:
    ann_id: str
    pub_ns: int
    avail_ns: int
    pub_ord: int
    r0_pos: int
    kind: str
    period_est: str
    period_ord: int
    rk_ns: int  # reaction_known_at ns (NEVER when pending/missing)
    ear_ready_ns: int  # max(rk_ns, close[r+1]) when EAR window valid, else NEVER
    vol_ratio: float
    ear_val: float


@dataclass(frozen=True)
class _AnnStep:
    clock_ns: int
    pub_ord: int
    r0_pos: int
    kind: str
    cands_count: float
    vol_ratio: float
    ear: float
    ear_pending: bool
    ear_prev: float
    p_star: str
    p_star_ord: int
    prior_lag_next_ord: int  # 0 when unavailable


def _select_asof_primary(cands: Sequence[_CandRow], cutoff_ns: int) -> _CandRow:
    """Select primary among candidates of one period at ``cutoff_ns``.

    Among candidates with ``rk_ns <= cutoff_ns`` and finite ``volume_ratio_reaction``,
    pick the maximum ratio (ties broken by earliest ``(pub_ns, ann_id)``); otherwise
    pick the earliest candidate by ``(pub_ns, ann_id)``.
    """
    best_known: _CandRow | None = None
    for row in cands:
        if (
            row.rk_ns <= cutoff_ns
            and np.isfinite(row.vol_ratio)
            and (
                best_known is None
                or row.vol_ratio > best_known.vol_ratio
                or (
                    row.vol_ratio == best_known.vol_ratio
                    and (row.pub_ns, row.ann_id)
                    < (best_known.pub_ns, best_known.ann_id)
                )
            )
        ):
            best_known = row
    if best_known is not None:
        return best_known
    return min(cands, key=lambda r: (r.pub_ns, r.ann_id))


def _build_asset_ann_steps(rows: Sequence[_CandRow]) -> list[_AnnStep]:
    if not rows:
        return []
    ordered = sorted(rows, key=lambda r: (r.avail_ns, r.pub_ns, r.ann_id))
    transitions: set[int] = set()
    for r in ordered:
        transitions.add(r.avail_ns)
        if r.rk_ns != NEVER and r.rk_ns >= r.avail_ns:
            transitions.add(r.rk_ns)
        if r.ear_ready_ns != NEVER and r.ear_ready_ns >= r.avail_ns:
            transitions.add(r.ear_ready_ns)

    steps: list[_AnnStep] = []
    for t_ns in sorted(transitions):
        known = [r for r in ordered if r.avail_ns <= t_ns]
        if not known:
            continue
        latest_row = max(known, key=lambda r: (r.pub_ns, r.ann_id))
        p_star = latest_row.period_est
        p_star_ord = latest_row.period_ord
        cands = [r for r in known if r.period_est == p_star]
        primary = _select_asof_primary(cands, t_ns)

        vol_ratio = primary.vol_ratio if primary.rk_ns <= t_ns else float("nan")
        ear = primary.ear_val if primary.ear_ready_ns <= t_ns else float("nan")
        ear_pending = primary.rk_ns > t_ns

        # Group all known candidates by estimated period for ear_prev and lag history
        by_period: dict[int, list[_CandRow]] = {}
        for r in known:
            if r.period_ord > 0:
                by_period.setdefault(r.period_ord, []).append(r)
        sorted_p_ords = sorted(by_period)

        ear_prev = float("nan")
        prior_ords = [po for po in sorted_p_ords if po < p_star_ord]
        if prior_ords:
            prev_primary = _select_asof_primary(by_period[prior_ords[-1]], t_ns)
            if prev_primary.ear_ready_ns <= t_ns:
                ear_prev = prev_primary.ear_val

        next_ord = 0
        if p_star_ord > 0:
            p_star_date = date.fromordinal(p_star_ord)
            p_next_date = _next_estimated_period_end(p_star_date)
            target_prev_ord = (p_next_date - timedelta(days=365)).toordinal()
            lags_by_ord: list[tuple[int, int]] = []
            for po in sorted_p_ords:
                prim_i = _select_asof_primary(by_period[po], t_ns)
                lags_by_ord.append((po, prim_i.pub_ord - po))
            same_q_matches = [
                (abs(po - target_prev_ord), lag)
                for po, lag in lags_by_ord
                if abs(po - target_prev_ord) <= 20
            ]
            if same_q_matches:
                same_q_matches.sort(key=lambda item: item[0])
                chosen_lag = float(same_q_matches[0][1])
            elif lags_by_ord:
                recent_lags = [lag for _, lag in lags_by_ord[-4:]]
                chosen_lag = float(np.median(recent_lags))
            else:
                chosen_lag = float("nan")
            if np.isfinite(chosen_lag):
                est_date = p_next_date + timedelta(days=math.floor(chosen_lag + 0.5))
                next_ord = est_date.toordinal()

        steps.append(
            _AnnStep(
                clock_ns=t_ns,
                pub_ord=primary.pub_ord,
                r0_pos=primary.r0_pos,
                kind=primary.kind,
                cands_count=float(len(cands)),
                vol_ratio=vol_ratio,
                ear=ear,
                ear_pending=ear_pending,
                ear_prev=ear_prev,
                p_star=p_star,
                p_star_ord=p_star_ord,
                prior_lag_next_ord=next_ord,
            )
        )
    return steps


def earnings_calendar_asof(
    event_observations: pd.DataFrame | None,
    earnings_observations: pd.DataFrame | None,
    asof: Any,
    *,
    include_unlinked: bool = False,
) -> pd.DataFrame:
    """Latest Finnhub earnings calendar row per ``(asset_id, fiscal_year, fiscal_quarter)``
    knowable at or before ``asof``, respecting link removals in ``event_observations``."""
    asof_ts = _clocks.clock(asof)
    if asof_ts is None:
        raise ValueError("asof must be an offset-bearing timestamp")
    asof_ns = int(asof_ts.as_unit("ns").value)

    base_cols = [
        "asset_id",
        "event_uid",
        "symbol",
        "event_date",
        "fiscal_year",
        "fiscal_quarter",
        "hour",
        "eps_estimate",
        "eps_actual",
        "revenue_estimate",
        "revenue_actual",
        "observed_at",
        "still_linked",
    ]
    if earnings_observations is None or earnings_observations.empty:
        return pd.DataFrame(columns=base_cols)
    if "observed_at" not in earnings_observations.columns:
        return pd.DataFrame(columns=base_cols)

    earn = earnings_observations.copy()
    obs_ns = _clocks.instants(earn["observed_at"].to_numpy(dtype=object))
    keep_earn = (obs_ns != NAT) & (obs_ns <= asof_ns)
    if not keep_earn.any():
        return pd.DataFrame(columns=base_cols)
    earn = earn.loc[keep_earn].copy()
    earn["_obs_ns"] = obs_ns[keep_earn]
    earn["_seq"] = (
        pd.to_numeric(earn["observation_sequence"], errors="coerce")
        .fillna(1)
        .to_numpy(dtype=np.int64)
        if "observation_sequence" in earn.columns
        else np.ones(len(earn), dtype=np.int64)
    )
    if "event_date" not in earn.columns and "report_date" in earn.columns:
        earn["event_date"] = earn["report_date"]
    if "fiscal_year" not in earn.columns and "year" in earn.columns:
        earn["fiscal_year"] = earn["year"]
    if "fiscal_quarter" not in earn.columns and "quarter" in earn.columns:
        earn["fiscal_quarter"] = earn["quarter"]

    if "event_uid" not in earn.columns:
        return pd.DataFrame(columns=base_cols)

    earn["event_uid"] = earn["event_uid"].astype(str)
    earn = earn[earn["event_uid"] != ""]
    if earn.empty:
        return pd.DataFrame(columns=base_cols)

    # Resolve linked assets per finnhub_earnings uid from event_observations <= asof
    linked_by_uid: dict[str, set[str]] = {}
    seen_uids: set[str] = set()
    if (
        event_observations is not None
        and not event_observations.empty
        and "event_uid" in event_observations.columns
    ):
        ev = event_observations
        if "source" in ev.columns:
            mask_src = (ev["source"].astype(str) == "finnhub_earnings") | (
                ev["event_uid"].astype(str).str.startswith("finnhub_earnings:")
            )
            ev = ev[mask_src]
        else:
            ev = ev[ev["event_uid"].astype(str).str.startswith("finnhub_earnings:")]
        if not ev.empty:
            rec_col = (
                "observation_recorded_at"
                if "observation_recorded_at" in ev.columns
                else (
                    "observed_at"
                    if "observed_at" in ev.columns
                    else "content_first_seen_at"
                )
            )
            rec_ns = (
                _clocks.instants(ev[rec_col].to_numpy(dtype=object))
                if rec_col in ev.columns
                else np.full(len(ev), NAT, dtype=np.int64)
            )
            valid_ev = (rec_ns != NAT) & (rec_ns <= asof_ns)
            if valid_ev.any():
                ev_sub = ev.loc[valid_ev].copy()
                ev_sub["_rec_ns"] = rec_ns[valid_ev]
                ev_sub["_seq"] = (
                    pd.to_numeric(ev_sub["observation_sequence"], errors="coerce")
                    .fillna(1)
                    .to_numpy(dtype=np.int64)
                    if "observation_sequence" in ev_sub.columns
                    else np.ones(len(ev_sub), dtype=np.int64)
                )
                ev_sub = ev_sub.sort_values(
                    ["event_uid", "_seq", "_rec_ns"], kind="mergesort"
                ).drop_duplicates("event_uid", keep="last")
                assets_cells = (
                    ev_sub["asset_ids"].to_numpy(dtype=object)
                    if "asset_ids" in ev_sub.columns
                    else np.full(len(ev_sub), None, dtype=object)
                )
                for uid_val, cell in zip(
                    ev_sub["event_uid"].astype(str).tolist(), assets_cells
                ):
                    seen_uids.add(uid_val)
                    if isinstance(cell, (list, tuple, np.ndarray)):
                        linked_by_uid[uid_val] = {
                            str(x) for x in cell if x is not None and str(x) != ""
                        }
                    else:
                        linked_by_uid[uid_val] = set()
    else:
        return pd.DataFrame(columns=base_cols)

    # Deduplicate earnings_observations to latest per (event_uid, asset_id) or event_uid
    has_asset_col = "asset_id" in earn.columns
    if has_asset_col:
        earn["asset_id"] = earn["asset_id"].astype(str)
        earn = earn.sort_values(
            ["event_uid", "asset_id", "_seq", "_obs_ns"], kind="mergesort"
        ).drop_duplicates(["event_uid", "asset_id"], keep="last")
        rows_out: list[dict[str, Any]] = []
        for rec in earn.to_dict("records"):
            uid_s = str(rec["event_uid"])
            if uid_s not in seen_uids:
                continue
            aid = str(rec["asset_id"])
            is_linked = aid in linked_by_uid.get(uid_s, set())
            if not is_linked and not include_unlinked:
                continue
            rec["still_linked"] = is_linked
            rows_out.append(rec)
    else:
        earn = earn.sort_values(
            ["event_uid", "_seq", "_obs_ns"], kind="mergesort"
        ).drop_duplicates("event_uid", keep="last")
        rows_out = []
        for rec in earn.to_dict("records"):
            uid_s = str(rec["event_uid"])
            for aid in sorted(linked_by_uid.get(uid_s, set())):
                copied = dict(rec)
                copied["asset_id"] = aid
                copied["still_linked"] = True
                rows_out.append(copied)

    if not rows_out:
        return pd.DataFrame(columns=base_cols)

    joined = pd.DataFrame(rows_out)
    # Keep latest row per (asset_id, fiscal_year, fiscal_quarter) when period present, else per (asset_id, event_uid)
    fy = (
        pd.to_numeric(joined["fiscal_year"], errors="coerce")
        if "fiscal_year" in joined.columns
        else pd.Series(np.nan, index=joined.index)
    )
    fq = (
        pd.to_numeric(joined["fiscal_quarter"], errors="coerce")
        if "fiscal_quarter" in joined.columns
        else pd.Series(np.nan, index=joined.index)
    )
    joined["_period_key"] = [
        f"{int(y)}Q{int(q)}" if np.isfinite(y) and np.isfinite(q) else f"uid:{u}"
        for y, q, u in zip(
            fy.to_numpy(), fq.to_numpy(), joined["event_uid"].astype(str)
        )
    ]
    joined = joined.sort_values(
        ["asset_id", "_period_key", "still_linked", "_obs_ns", "_seq", "event_uid"],
        kind="mergesort",
    ).drop_duplicates(["asset_id", "_period_key"], keep="last")
    joined = joined.drop(columns=["_obs_ns", "_seq", "_period_key"]).reset_index(
        drop=True
    )
    return joined


def _calendar_next_ordinals_per_sample(
    samples: pd.DataFrame,
    dec_ns: np.ndarray,
    ref_ord: np.ndarray,
    p_star_ord: np.ndarray,
    prim_pub_ord: np.ndarray,
    *,
    calendar_rows: pd.DataFrame | None,
    event_observations: pd.DataFrame | None,
    earnings_observations: pd.DataFrame | None,
) -> np.ndarray:
    """Resolve Finnhub next-event ordinal per sample row (0 when no linked future period)."""
    n = len(samples)
    out = np.zeros(n, dtype=np.int64)

    if (calendar_rows is None or calendar_rows.empty) and (
        event_observations is None
        or event_observations.empty
        or earnings_observations is None
        or earnings_observations.empty
    ):
        return out

    assets_col = samples["asset_id"].astype(str).to_numpy(dtype=object)
    valid_samples = np.flatnonzero(dec_ns != NAT)
    if not valid_samples.size:
        return out

    if event_observations is not None and earnings_observations is not None:
        # Evaluate at each distinct sample decision_at timestamp
        unique_cutoffs = np.unique(dec_ns[valid_samples])
        for c_val in unique_cutoffs.tolist():
            cal_df = earnings_calendar_asof(
                event_observations,
                earnings_observations,
                pd.Timestamp(int(c_val), tz="UTC"),
            )
            if cal_df.empty or "event_date" not in cal_df.columns:
                continue
            by_asset: dict[str, list[int]] = {}
            for aid, ev_date in zip(
                cal_df["asset_id"].astype(str), cal_df["event_date"]
            ):
                if isinstance(ev_date, str) and ev_date:
                    try:
                        by_asset.setdefault(aid, []).append(
                            _clocks.day_str(ev_date).toordinal()
                        )
                    except ValueError:
                        continue
                elif isinstance(ev_date, date):
                    by_asset.setdefault(aid, []).append(ev_date.toordinal())
            if not by_asset:
                continue
            for ev_list in by_asset.values():
                ev_list.sort()
            at_c = np.flatnonzero(dec_ns == c_val)
            for idx in at_c.tolist():
                cands = by_asset.get(str(assets_col[idx]))
                if not cands:
                    continue
                floor_ord = max(
                    int(ref_ord[idx]),
                    int(p_star_ord[idx]) + 1 if p_star_ord[idx] > 0 else 0,
                    int(prim_pub_ord[idx]) + 14 if prim_pub_ord[idx] > 0 else 0,
                )
                pos = int(np.searchsorted(cands, floor_ord, "left"))
                if pos < len(cands):
                    out[idx] = cands[pos]
        return out

    assert calendar_rows is not None
    df = calendar_rows
    if "still_linked" in df.columns:
        df = df[df["still_linked"].fillna(False).astype(bool)]
    if df.empty or "asset_id" not in df.columns:
        return out
    date_col = (
        "event_date"
        if "event_date" in df.columns
        else ("report_date" if "report_date" in df.columns else None)
    )
    if date_col is None:
        return out
    obs_ns = (
        _clocks.instants(df["observed_at"].to_numpy(dtype=object))
        if "observed_at" in df.columns
        else np.full(len(df), NAT + 1, dtype=np.int64)
    )
    rec_ns = (
        _clocks.instants(df["observation_recorded_at"].to_numpy(dtype=object))
        if "observation_recorded_at" in df.columns
        else np.full(len(df), NAT + 1, dtype=np.int64)
    )
    row_avail = np.maximum(obs_ns, rec_ns)
    by_asset_rows: dict[str, list[tuple[int, int]]] = {}
    for aid, d_val, av in zip(
        df["asset_id"].astype(str), df[date_col], row_avail.tolist()
    ):
        if av == NAT:
            continue
        try:
            ev_ord = _clocks.day(d_val).toordinal()
        except (TypeError, ValueError):
            continue
        by_asset_rows.setdefault(aid, []).append((av, ev_ord))

    for idx in valid_samples.tolist():
        entries = by_asset_rows.get(str(assets_col[idx]))
        if not entries:
            continue
        c_val = int(dec_ns[idx])
        floor_ord = max(
            int(ref_ord[idx]),
            int(p_star_ord[idx]) + 1 if p_star_ord[idx] > 0 else 0,
            int(prim_pub_ord[idx]) + 14 if prim_pub_ord[idx] > 0 else 0,
        )
        valid_ords = [
            ev_ord for av, ev_ord in entries if av <= c_val and ev_ord >= floor_ord
        ]
        if valid_ords:
            out[idx] = min(valid_ords)
    return out


def earnings_features(
    announcements: pd.DataFrame,
    samples: pd.DataFrame,
    *,
    calendar: _clocks.Calendar | Sequence[Any],
    adjusted: pd.DataFrame | None = None,
    benchmark_id: str | None = None,
    daily_returns: pd.DataFrame | None = None,
    time_policy: str = "public_reconstructed",
    calendar_rows: pd.DataFrame | None = None,
    event_observations: pd.DataFrame | None = None,
    earnings_observations: pd.DataFrame | None = None,
    horizons: int | Iterable[int] = DEFAULT_HORIZONS,
) -> pd.DataFrame:
    """Point-in-time earnings timing, abnormal volume, EAR, and next-announcement features."""
    _clocks.policy(time_policy)
    cal = _ensure_calendar(calendar)
    horizon_list, _ = _labels.horizons(horizons)

    sig_pos, dec_ns, ref_ord = _sample_decisions_and_positions(samples, cal)
    cov_ok = _sample_coverage_ok(samples) & (dec_ns != NAT)
    n = len(samples)
    assets_col = samples["asset_id"].astype(str).to_numpy(dtype=object)
    selected_assets = list(dict.fromkeys(assets_col.tolist()))

    # Price matrix for EAR
    price_assets = [
        *selected_assets,
        *([str(benchmark_id)] if benchmark_id is not None else []),
    ]
    levels, level_pos = _return_levels_matrix(
        cal, price_assets, adjusted, daily_returns
    )
    bench_col = level_pos.get(str(benchmark_id)) if benchmark_id is not None else None
    cal_day_index = {d.isoformat(): idx for idx, d in enumerate(cal.days)}

    # Parse candidate announcement rows per asset
    cands_by_asset: dict[str, list[_CandRow]] = {}
    if (
        announcements is not None
        and not announcements.empty
        and "asset_id" in announcements.columns
        and "public_at" in announcements.columns
    ):
        ann = announcements[
            announcements["asset_id"].astype(str).isin(set(selected_assets))
        ]
        if "role" in ann.columns:
            ann = ann[ann["role"].astype(str) == "results_candidate"]
        if not ann.empty:
            ann = ann.reset_index(drop=True)
            pub_raw = ann["public_at"].to_numpy(dtype=object)
            fdate_raw = (
                ann["filing_date"].to_numpy(dtype=object)
                if "filing_date" in ann.columns
                else np.full(len(ann), None, dtype=object)
            )
            pub_ns = np.fromiter(
                (
                    int(ts.as_unit("ns").value)
                    if (ts := sec_public_clock(p, f)) is not None
                    else NAT
                    for p, f in zip(pub_raw, fdate_raw)
                ),
                dtype=np.int64,
                count=len(ann),
            )
            if (
                time_policy == "observed_content"
                and "observed_available_at" in ann.columns
            ):
                obs_ns = _clocks.instants(
                    ann["observed_available_at"].to_numpy(dtype=object)
                )
                avail_ns = _clocks.available_at(
                    pub_ns, pub_ns == NAT, "observed_content", (obs_ns,)
                )
            else:
                avail_ns = pub_ns.copy()

            rk_raw = (
                _clocks.instants(ann["reaction_known_at"].to_numpy(dtype=object))
                if "reaction_known_at" in ann.columns
                else np.full(len(ann), NAT, dtype=np.int64)
            )
            rk_ns = np.where(rk_raw == NAT, NEVER, rk_raw)
            vol_ratios = (
                pd.to_numeric(ann["volume_ratio_reaction"], errors="coerce").to_numpy(
                    dtype=np.float64
                )
                if "volume_ratio_reaction" in ann.columns
                else np.full(len(ann), np.nan, dtype=np.float64)
            )
            ann_ids = (
                ann["announcement_id"].astype(str).to_numpy(dtype=object)
                if "announcement_id" in ann.columns
                else (
                    ann["announcement_uid"].astype(str).to_numpy(dtype=object)
                    if "announcement_uid" in ann.columns
                    else np.array([f"ann-{i}" for i in range(len(ann))], dtype=object)
                )
            )
            kinds_col = (
                ann["kind"].fillna("8k_item_2_02").astype(str).to_numpy(dtype=object)
                if "kind" in ann.columns
                else np.full(len(ann), "8k_item_2_02", dtype=object)
            )
            p_est_col = (
                ann["period_end_estimated"]
                .fillna("")
                .astype(str)
                .to_numpy(dtype=object)
                if "period_end_estimated" in ann.columns
                else np.full(len(ann), "", dtype=object)
            )
            r_sess_col = (
                ann["reaction_session"].fillna("").astype(str).to_numpy(dtype=object)
                if "reaction_session" in ann.columns
                else np.full(len(ann), "", dtype=object)
            )
            r0_sess_col = (
                ann["reaction_session_initial"]
                .fillna("")
                .astype(str)
                .to_numpy(dtype=object)
                if "reaction_session_initial" in ann.columns
                else np.full(len(ann), "", dtype=object)
            )
            valid_pub = pub_ns != NAT
            pub_ords = np.zeros(len(ann), dtype=np.int64)
            if valid_pub.any():
                pub_ords[valid_pub] = _clocks.local_ordinals(
                    pub_ns[valid_pub], NEW_YORK
                )

            a_ids = ann["asset_id"].astype(str).to_numpy(dtype=object)
            for i in range(len(ann)):
                if avail_ns[i] == NAT or pub_ns[i] == NAT:
                    continue
                aid = str(a_ids[i])
                p_est_s = str(p_est_col[i]).strip()
                try:
                    p_ord = _clocks.day_str(p_est_s).toordinal() if p_est_s else 0
                except ValueError:
                    p_ord = 0
                r0_s = str(r0_sess_col[i]).strip()
                if r0_s in cal_day_index:
                    r0_idx = cal_day_index[r0_s]
                else:
                    r0_idx = int(np.searchsorted(cal.closes, int(pub_ns[i]), "right"))

                r_s = str(r_sess_col[i]).strip()
                r_idx = cal_day_index.get(r_s, -1)
                ear_val = float("nan")
                ear_ready = NEVER
                if int(rk_ns[i]) != NEVER and r_idx >= 2 and r_idx + 1 < len(cal.days):
                    ear_ready = max(int(rk_ns[i]), int(cal.closes[r_idx + 1]))
                    a_col = level_pos.get(aid)
                    if a_col is not None:
                        c_end = levels[r_idx + 1, a_col]
                        c_pre = levels[r_idx - 2, a_col]
                        if np.isfinite(c_end) and np.isfinite(c_pre) and c_pre > 0:
                            if bench_col is not None:
                                b_end = levels[r_idx + 1, bench_col]
                                b_pre = levels[r_idx - 2, bench_col]
                                if (
                                    np.isfinite(b_end)
                                    and np.isfinite(b_pre)
                                    and b_pre > 0
                                ):
                                    ear_val = float((c_end / c_pre) - (b_end / b_pre))
                            else:
                                ear_val = float(c_end / c_pre - 1.0)

                cands_by_asset.setdefault(aid, []).append(
                    _CandRow(
                        ann_id=str(ann_ids[i]),
                        pub_ns=int(pub_ns[i]),
                        avail_ns=int(avail_ns[i]),
                        pub_ord=int(pub_ords[i]),
                        r0_pos=r0_idx,
                        kind=str(kinds_col[i]),
                        period_est=p_est_s,
                        period_ord=p_ord,
                        rk_ns=int(rk_ns[i]),
                        ear_ready_ns=ear_ready,
                        vol_ratio=float(vol_ratios[i]),
                        ear_val=ear_val,
                    )
                )

    days_since = np.full(n, np.nan, dtype=np.float64)
    sessions_since = np.full(n, np.nan, dtype=np.float64)
    last_kind = np.full(n, None, dtype=object)
    cands_in_period = np.full(n, np.nan, dtype=np.float64)
    vol_ratio_out = np.full(n, np.nan, dtype=np.float64)
    ear_out = np.full(n, np.nan, dtype=np.float64)
    ear_pending_out = np.zeros(n, dtype=bool)
    ear_prev_out = np.full(n, np.nan, dtype=np.float64)
    prior_lag_next_ord = np.zeros(n, dtype=np.int64)
    p_star_ords = np.zeros(n, dtype=np.int64)
    prim_pub_ords = np.zeros(n, dtype=np.int64)
    p_star_strings = np.full(n, None, dtype=object)

    codes, uniques = pd.factorize(pd.Series(assets_col, dtype=object), sort=False)
    for code, asset_name in enumerate(uniques):
        aid = str(asset_name)
        rows_idx = np.flatnonzero(codes == code)
        ok_idx = rows_idx[cov_ok[rows_idx]]
        if not ok_idx.size:
            continue
        steps = _build_asset_ann_steps(cands_by_asset.get(aid, ()))
        if not steps:
            continue
        step_clocks = np.fromiter(
            (s.clock_ns for s in steps), dtype=np.int64, count=len(steps)
        )
        pos = np.searchsorted(step_clocks, dec_ns[ok_idx], "right") - 1
        matched = pos >= 0
        if not matched.any():
            continue
        m_rows = ok_idx[matched]
        m_pos = pos[matched]

        s_pub_ord = np.fromiter(
            (s.pub_ord for s in steps), dtype=np.int64, count=len(steps)
        )[m_pos]
        s_r0_pos = np.fromiter(
            (s.r0_pos for s in steps), dtype=np.int64, count=len(steps)
        )[m_pos]
        s_kind = np.array([s.kind for s in steps], dtype=object)[m_pos]
        s_cnt = np.fromiter(
            (s.cands_count for s in steps), dtype=np.float64, count=len(steps)
        )[m_pos]
        s_vol = np.fromiter(
            (s.vol_ratio for s in steps), dtype=np.float64, count=len(steps)
        )[m_pos]
        s_ear = np.fromiter((s.ear for s in steps), dtype=np.float64, count=len(steps))[
            m_pos
        ]
        s_pend = np.fromiter(
            (s.ear_pending for s in steps), dtype=bool, count=len(steps)
        )[m_pos]
        s_prev = np.fromiter(
            (s.ear_prev for s in steps), dtype=np.float64, count=len(steps)
        )[m_pos]
        s_next_ord = np.fromiter(
            (s.prior_lag_next_ord for s in steps), dtype=np.int64, count=len(steps)
        )[m_pos]
        s_p_ord = np.fromiter(
            (s.p_star_ord for s in steps), dtype=np.int64, count=len(steps)
        )[m_pos]
        s_p_str = np.array([s.p_star or None for s in steps], dtype=object)[m_pos]

        days_since[m_rows] = np.maximum(0, ref_ord[m_rows] - s_pub_ord).astype(
            np.float64
        )
        dec_pos = sig_pos[m_rows] + 1
        sessions_since[m_rows] = np.maximum(0, dec_pos - s_r0_pos).astype(np.float64)
        last_kind[m_rows] = s_kind
        cands_in_period[m_rows] = s_cnt
        vol_ratio_out[m_rows] = s_vol
        ear_out[m_rows] = s_ear
        ear_pending_out[m_rows] = s_pend
        ear_prev_out[m_rows] = s_prev
        prior_lag_next_ord[m_rows] = s_next_ord
        p_star_ords[m_rows] = s_p_ord
        prim_pub_ords[m_rows] = s_pub_ord
        p_star_strings[m_rows] = s_p_str

    # Combine Finnhub calendar next-date with prior_year_lag fallback
    cal_next_ord = _calendar_next_ordinals_per_sample(
        samples,
        dec_ns,
        ref_ord,
        p_star_ords,
        prim_pub_ords,
        calendar_rows=calendar_rows,
        event_observations=event_observations,
        earnings_observations=earnings_observations,
    )
    use_cal = cov_ok & (cal_next_ord > 0)
    use_lag = cov_ok & ~use_cal & (prior_lag_next_ord > 0)
    chosen_next_ord = np.where(
        use_cal, cal_next_ord, np.where(use_lag, prior_lag_next_ord, 0)
    )
    has_next = chosen_next_ord > 0

    days_until_next = np.where(
        has_next, (chosen_next_ord - ref_ord).astype(np.float64), np.nan
    )
    next_basis = np.full(n, None, dtype=object)
    next_basis[use_cal] = "finnhub_calendar"
    next_basis[use_lag] = "prior_year_lag"
    next_overdue = has_next & (chosen_next_ord < ref_ord)

    cal_ordinals = np.fromiter(
        (d.toordinal() for d in cal.days), dtype=np.int64, count=len(cal.days)
    )
    within_cols: dict[str, np.ndarray] = {}
    for h in horizon_list:
        exit_pos = sig_pos + h
        # Inside frozen calendar use exact exit session ordinal; past calendar end approximate ~7/5 calendar days
        in_cal = exit_pos < len(cal_ordinals)
        clipped = np.minimum(exit_pos, len(cal_ordinals) - 1)
        extra_sessions = np.maximum(0, exit_pos - (len(cal_ordinals) - 1))
        extra_days = (extra_sessions * 7 + 4) // 5
        horizon_end_ord = np.where(
            in_cal, cal_ordinals[clipped], cal_ordinals[-1] + extra_days
        )
        within_cols[f"earn_next_within_{h}s"] = pd.arrays.BooleanArray(
            has_next
            & (chosen_next_ord >= ref_ord)
            & (chosen_next_ord <= horizon_end_ord),
            ~cov_ok,
        )

    out = pd.DataFrame(
        {
            "asset_id": samples["asset_id"].to_numpy(),
            "signal_session": samples["signal_session"].to_numpy(),
            "earn_days_since": days_since,
            "earn_sessions_since": sessions_since,
            "earn_last_kind": pd.Categorical(
                last_kind, categories=list(EARNINGS_KINDS)
            ),
            "earn_candidates_in_period": cands_in_period,
            "earn_volume_ratio": vol_ratio_out,
            "earn_ear": ear_out,
            "earn_ear_pending": pd.arrays.BooleanArray(ear_pending_out, ~cov_ok),
            "earn_ear_prev": ear_prev_out,
            "earn_days_until_next_est": days_until_next,
            "earn_next_basis": pd.Categorical(next_basis, categories=list(NEXT_BASES)),
            "earn_next_overdue": pd.arrays.BooleanArray(next_overdue, ~cov_ok),
            **within_cols,
        }
    )
    out.attrs["primary_period_end"] = p_star_strings
    return out


# ---------------------------------------------------------------------------
# Standardized unexpected earnings (SUE) on fiscal_quarters
# ---------------------------------------------------------------------------


def _normalize_cik_str(value: Any) -> str:
    if value is None or (not isinstance(value, str) and pd.isna(value)):
        return ""
    s = str(value).strip()
    if not s:
        return ""
    return s.zfill(10) if s.isdigit() and int(s) > 0 else ""


def _resolve_sample_ciks(
    samples: pd.DataFrame,
    asset_ciks: Mapping[str, Any] | pd.DataFrame | pd.Series,
) -> list[str]:
    n = len(samples)
    assets = samples["asset_id"].astype(str).tolist()
    sig_days = [_clocks.day(x) for x in samples["signal_session"]]

    if isinstance(asset_ciks, pd.Series):
        if len(asset_ciks) == n and asset_ciks.index.equals(samples.index):
            return [_normalize_cik_str(v) for v in asset_ciks.tolist()]
        mapping = {str(k): _normalize_cik_str(v) for k, v in asset_ciks.items()}
        return [mapping.get(a, "") for a in assets]

    if isinstance(asset_ciks, Mapping):
        mapping = {str(k): _normalize_cik_str(v) for k, v in asset_ciks.items()}
        return [mapping.get(a, "") for a in assets]

    if isinstance(asset_ciks, pd.DataFrame):
        if (
            asset_ciks.empty
            or "asset_id" not in asset_ciks.columns
            or "cik" not in asset_ciks.columns
        ):
            return [""] * n
        df = asset_ciks
        if "status" in df.columns:
            df = df[df["status"].astype(str) == "verified"]
        if "issuer_mapping_status" in df.columns:
            df = df[df["issuer_mapping_status"].astype(str) == "verified"]
        if {"valid_from", "valid_to"}.issubset(df.columns):
            intervals: dict[str, list[tuple[date, date, str]]] = {}
            for rec in df.to_dict("records"):
                cik_s = _normalize_cik_str(rec.get("cik"))
                if not cik_s:
                    continue
                vf_raw = str(rec.get("valid_from") or "").strip()
                vt_raw = str(rec.get("valid_to") or "").strip()
                vf = _clocks.day_str(vf_raw) if vf_raw else date.min
                vt = _clocks.day_str(vt_raw) if vt_raw else date.max
                intervals.setdefault(str(rec["asset_id"]), []).append((vf, vt, cik_s))
            resolved: list[str] = []
            for a, d in zip(assets, sig_days):
                hit = ""
                for vf, vt, cik_s in intervals.get(a, ()):
                    if vf <= d <= vt:
                        hit = cik_s
                resolved.append(hit)
            return resolved
        if "signal_session" in df.columns:
            pair_map = {
                (str(a), _clocks.day(s)): _normalize_cik_str(c)
                for a, s, c in zip(df["asset_id"], df["signal_session"], df["cik"])
            }
            return [pair_map.get((a, d), "") for a, d in zip(assets, sig_days)]
        static_map = {
            str(a): _normalize_cik_str(c) for a, c in zip(df["asset_id"], df["cik"])
        }
        return [static_map.get(a, "") for a in assets]

    raise TypeError("asset_ciks must be a Mapping, Series, or DataFrame")


@dataclass(frozen=True)
class _QuarterPoint:
    period_end: date
    period_ord: int
    avail_ns: int
    avail_ny_ord: int
    delta: float
    basis: str
    approximate: bool


@dataclass(frozen=True)
class _SueStep:
    clock_ns: int
    sue_eps: float
    sue_eps_price: float
    sue_revenue: float
    period_end_str: str | None
    period_ord: int
    basis: str | None
    approximate: bool


def _raw_prices_by_asset(
    raw: pd.DataFrame | None, selected_assets: set[str]
) -> dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """Per asset -> sorted ``(close_ns, day_ordinal, close_price)``."""
    out: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]] = {}
    if (
        raw is None
        or raw.empty
        or not {"asset_id", "date", "close"}.issubset(raw.columns)
    ):
        return out
    sub = raw[raw["asset_id"].astype(str).isin(selected_assets)].copy()
    if sub.empty:
        return out
    sub["asset_id"] = sub["asset_id"].astype(str)
    sub["_close"] = pd.to_numeric(sub["close"], errors="coerce")
    sub = sub[np.isfinite(sub["_close"]) & (sub["_close"] > 0)]
    if sub.empty:
        return out
    sub["_day"] = [
        x.date() if isinstance(x, pd.Timestamp) else _clocks.day(x) for x in sub["date"]
    ]
    sub = sub.sort_values(["asset_id", "_day"], kind="mergesort").drop_duplicates(
        ["asset_id", "_day"], keep="last"
    )
    for aid, grp in sub.groupby("asset_id", sort=False):
        days_list = grp["_day"].tolist()
        close_ns = _clocks.wall_instants(days_list, time(16, 0))
        ords = np.fromiter(
            (d.toordinal() for d in days_list), dtype=np.int64, count=len(days_list)
        )
        prices = grp["_close"].to_numpy(dtype=np.float64)
        out[str(aid)] = (close_ns, ords, prices)
    return out


def _price_before_filing(
    bars: tuple[np.ndarray, np.ndarray, np.ndarray] | None,
    avail_ns: int,
    avail_ny_ord: int,
) -> float:
    if bars is None:
        return float("nan")
    close_ns, ords, prices = bars
    pos = int(np.searchsorted(close_ns, avail_ns, "left")) - 1
    if pos < 0:
        return float("nan")
    if avail_ny_ord - int(ords[pos]) > 14:
        return float("nan")
    return float(prices[pos])


def _build_sue_steps(
    eps_diluted_pts: Sequence[_QuarterPoint],
    eps_basic_pts: Sequence[_QuarterPoint],
    rev_pts: Sequence[_QuarterPoint],
    bars: tuple[np.ndarray, np.ndarray, np.ndarray] | None,
) -> list[_SueStep]:
    transitions = sorted(
        {pt.avail_ns for pt in eps_diluted_pts}
        | {pt.avail_ns for pt in eps_basic_pts}
        | {pt.avail_ns for pt in rev_pts}
    )
    if not transitions:
        return []

    def _with_scaled(pts: Sequence[_QuarterPoint]) -> list[tuple[_QuarterPoint, float]]:
        return [
            (
                pt,
                pt.delta / p
                if np.isfinite(pt.delta)
                and np.isfinite(
                    p := _price_before_filing(bars, pt.avail_ns, pt.avail_ny_ord)
                )
                and p > 0
                else float("nan"),
            )
            for pt in pts
        ]

    dil_scaled = _with_scaled(eps_diluted_pts)
    bas_scaled = _with_scaled(eps_basic_pts)

    steps: list[_SueStep] = []
    for t_ns in transitions:
        vis_dil = [(pt, sc) for pt, sc in dil_scaled if pt.avail_ns <= t_ns]
        vis_eps = (
            vis_dil
            if vis_dil
            else [(pt, sc) for pt, sc in bas_scaled if pt.avail_ns <= t_ns]
        )
        vis_rev = [pt for pt in rev_pts if pt.avail_ns <= t_ns]

        sue_eps = float("nan")
        sue_eps_price = float("nan")
        eps_anchor: _QuarterPoint | None = None
        if vis_eps:
            vis_eps.sort(key=lambda item: (item[0].period_ord, item[0].avail_ns))
            eps_anchor, cur_sc = vis_eps[-1]
            sue_eps_price = cur_sc
            if np.isfinite(cur_sc):
                prior_window = [
                    sc
                    for pt, sc in vis_eps[:-1]
                    if pt.period_ord < eps_anchor.period_ord
                ][-8:]
                valid_priors = [sc for sc in prior_window if np.isfinite(sc)]
                if len(valid_priors) >= 6:
                    disp = float(
                        np.std(np.array(valid_priors, dtype=np.float64), ddof=1)
                    )
                    if np.isfinite(disp) and disp > 0:
                        sue_eps = cur_sc / disp

        sue_rev = float("nan")
        rev_anchor: _QuarterPoint | None = None
        if vis_rev:
            vis_rev.sort(key=lambda pt: (pt.period_ord, pt.avail_ns))
            rev_anchor = vis_rev[-1]
            cur_d = rev_anchor.delta
            if np.isfinite(cur_d):
                prior_rev_window = [
                    pt.delta
                    for pt in vis_rev[:-1]
                    if pt.period_ord < rev_anchor.period_ord
                ][-8:]
                valid_rev_priors = [d for d in prior_rev_window if np.isfinite(d)]
                if len(valid_rev_priors) >= 6:
                    disp_r = float(
                        np.std(np.array(valid_rev_priors, dtype=np.float64), ddof=1)
                    )
                    if np.isfinite(disp_r) and disp_r > 0:
                        sue_rev = cur_d / disp_r

        anchor = eps_anchor if eps_anchor is not None else rev_anchor
        steps.append(
            _SueStep(
                clock_ns=t_ns,
                sue_eps=sue_eps,
                sue_eps_price=sue_eps_price,
                sue_revenue=sue_rev,
                period_end_str=anchor.period_end.isoformat()
                if anchor is not None
                else None,
                period_ord=anchor.period_ord if anchor is not None else 0,
                basis=eps_anchor.basis if eps_anchor is not None else None,
                approximate=bool(eps_anchor.approximate)
                if eps_anchor is not None
                else False,
            )
        )
    return steps


def sue_features(
    quarterly: pd.DataFrame,
    samples: pd.DataFrame,
    *,
    raw: pd.DataFrame,
    asset_ciks: Mapping[str, Any] | pd.DataFrame | pd.Series,
    primary_period_end: pd.Series | Sequence[Any] | None = None,
) -> pd.DataFrame:
    """Seasonal-random-walk SUE features from ``fiscal_quarters`` and raw closes.

    Strictly point-in-time: reads only ``available_at_first <= decision_at``,
    ``value_first``, and same-filing ``prior_year_value_first`` (never ``value_latest``).
    """
    if not set(KEYS + ["decision_at"]).issubset(samples.columns):
        raise ValueError("samples requires asset_id, signal_session, and decision_at")
    n = len(samples)
    dec_ns = _clocks.instants(samples["decision_at"])
    cov_ok = _sample_coverage_ok(samples) & (dec_ns != NAT)
    sig_ords = np.fromiter(
        (_clocks.day(x).toordinal() for x in samples["signal_session"]),
        dtype=np.int64,
        count=n,
    )
    sample_ciks = _resolve_sample_ciks(samples, asset_ciks)
    assets_col = samples["asset_id"].astype(str).to_numpy(dtype=object)

    # Parse quarterly ledger points by (cik, concept) using ONLY *_first columns
    pts_by_cik_concept: dict[tuple[str, str], list[_QuarterPoint]] = {}
    needed_ciks = {c for c in sample_ciks if c}
    if (
        quarterly is not None
        and not quarterly.empty
        and needed_ciks
        and {
            "cik",
            "concept",
            "period_end",
            "value_first",
            "prior_year_value_first",
            "available_at_first",
        }.issubset(quarterly.columns)
    ):
        q_df = quarterly.copy()
        q_df["_cik"] = [_normalize_cik_str(c) for c in q_df["cik"]]
        q_df = q_df[
            q_df["_cik"].isin(needed_ciks)
            & q_df["concept"].astype(str).isin({"eps_diluted", "eps_basic", "revenue"})
        ]
        if "status_first" in q_df.columns:
            q_df = q_df[q_df["status_first"].astype(str).isin({"ok", "approximate"})]
        if not q_df.empty:
            q_df = q_df.reset_index(drop=True)
            avail_arr = _clocks.instants(
                q_df["available_at_first"].to_numpy(dtype=object)
            )
            valid_av = avail_arr != NAT
            avail_ny = np.zeros(len(q_df), dtype=np.int64)
            if valid_av.any():
                avail_ny[valid_av] = _clocks.local_ordinals(
                    avail_arr[valid_av], NEW_YORK
                )
            v_first = pd.to_numeric(q_df["value_first"], errors="coerce").to_numpy(
                dtype=np.float64
            )
            v_prior = pd.to_numeric(
                q_df["prior_year_value_first"], errors="coerce"
            ).to_numpy(dtype=np.float64)
            basis_col = (
                q_df["basis_first"]
                .fillna("reported")
                .astype(str)
                .to_numpy(dtype=object)
                if "basis_first" in q_df.columns
                else np.full(len(q_df), "reported", dtype=object)
            )
            status_col = (
                q_df["status_first"].fillna("ok").astype(str).to_numpy(dtype=object)
                if "status_first" in q_df.columns
                else np.full(len(q_df), "ok", dtype=object)
            )
            for i in range(len(q_df)):
                if not valid_av[i]:
                    continue
                pe = _clocks.day(q_df["period_end"].iloc[i])
                delta = (
                    float(v_first[i] - v_prior[i])
                    if np.isfinite(v_first[i]) and np.isfinite(v_prior[i])
                    else float("nan")
                )
                b_str = str(basis_col[i])
                s_str = str(status_col[i])
                approx = s_str == "approximate" or b_str == "fy_minus_ytd_approx"
                key = (str(q_df["_cik"].iloc[i]), str(q_df["concept"].iloc[i]))
                pts_by_cik_concept.setdefault(key, []).append(
                    _QuarterPoint(
                        period_end=pe,
                        period_ord=pe.toordinal(),
                        avail_ns=int(avail_arr[i]),
                        avail_ny_ord=int(avail_ny[i]),
                        delta=delta,
                        basis=b_str,
                        approximate=approx,
                    )
                )

    raw_bars = _raw_prices_by_asset(raw, set(assets_col.tolist()))

    sue_eps_out = np.full(n, np.nan, dtype=np.float64)
    sue_eps_price_out = np.full(n, np.nan, dtype=np.float64)
    sue_rev_out = np.full(n, np.nan, dtype=np.float64)
    period_end_out = np.full(n, None, dtype=object)
    period_ord_out = np.zeros(n, dtype=np.int64)
    age_days_out = np.full(n, np.nan, dtype=np.float64)
    basis_out = np.full(n, None, dtype=object)
    approx_out = np.zeros(n, dtype=bool)

    pair_keys = pd.MultiIndex.from_arrays(
        [assets_col, np.array(sample_ciks, dtype=object)]
    )
    codes, uniques = pd.factorize(pair_keys, sort=False)
    for code, (aid_raw, cik_raw) in enumerate(uniques):
        aid = str(aid_raw)
        cik = str(cik_raw)
        if not cik:
            continue
        rows_idx = np.flatnonzero(codes == code)
        ok_idx = rows_idx[cov_ok[rows_idx]]
        if not ok_idx.size:
            continue
        steps = _build_sue_steps(
            pts_by_cik_concept.get((cik, "eps_diluted"), ()),
            pts_by_cik_concept.get((cik, "eps_basic"), ()),
            pts_by_cik_concept.get((cik, "revenue"), ()),
            raw_bars.get(aid),
        )
        if not steps:
            continue
        step_clocks = np.fromiter(
            (s.clock_ns for s in steps), dtype=np.int64, count=len(steps)
        )
        pos = np.searchsorted(step_clocks, dec_ns[ok_idx], "right") - 1
        matched = pos >= 0
        if not matched.any():
            continue
        m_rows = ok_idx[matched]
        m_pos = pos[matched]

        sue_eps_out[m_rows] = np.fromiter(
            (s.sue_eps for s in steps), dtype=np.float64, count=len(steps)
        )[m_pos]
        sue_eps_price_out[m_rows] = np.fromiter(
            (s.sue_eps_price for s in steps), dtype=np.float64, count=len(steps)
        )[m_pos]
        sue_rev_out[m_rows] = np.fromiter(
            (s.sue_revenue for s in steps), dtype=np.float64, count=len(steps)
        )[m_pos]
        p_strs = np.array([s.period_end_str for s in steps], dtype=object)[m_pos]
        p_ords = np.fromiter(
            (s.period_ord for s in steps), dtype=np.int64, count=len(steps)
        )[m_pos]
        period_end_out[m_rows] = p_strs
        period_ord_out[m_rows] = p_ords
        has_p = p_ords > 0
        if has_p.any():
            age_days_out[m_rows[has_p]] = (
                sig_ords[m_rows[has_p]] - p_ords[has_p]
            ).astype(np.float64)
        basis_out[m_rows] = np.array([s.basis for s in steps], dtype=object)[m_pos]
        approx_out[m_rows] = np.fromiter(
            (s.approximate for s in steps), dtype=bool, count=len(steps)
        )[m_pos]

    # Stale flag: SUE period older than as-of primary announcement period (or > quarterly stale age)
    stale_out = np.zeros(n, dtype=bool)
    has_sue_period = period_ord_out > 0
    if primary_period_end is not None:
        prim_arr = np.asarray(list(primary_period_end), dtype=object)
        prim_ords = np.zeros(n, dtype=np.int64)
        for i, val in enumerate(prim_arr):
            if val is not None and (isinstance(val, (str, date)) and str(val).strip()):
                try:
                    prim_ords[i] = _clocks.day(val).toordinal()
                except ValueError:
                    prim_ords[i] = 0
        has_prim = prim_ords > 0
        stale_out[has_sue_period & has_prim] = (
            period_ord_out[has_sue_period & has_prim]
            < prim_ords[has_sue_period & has_prim] - 10
        )
        fallback_mask = has_sue_period & ~has_prim
        stale_out[fallback_mask] = age_days_out[fallback_mask] > STALE_AFTER_DAYS["q"]
    else:
        stale_out[has_sue_period] = age_days_out[has_sue_period] > STALE_AFTER_DAYS["q"]

    return pd.DataFrame(
        {
            "asset_id": samples["asset_id"].to_numpy(),
            "signal_session": samples["signal_session"].to_numpy(),
            "earn_sue_eps": sue_eps_out,
            "earn_sue_eps_price": sue_eps_price_out,
            "earn_sue_revenue": sue_rev_out,
            "earn_sue_period_end": pd.array(period_end_out, dtype="string"),
            "earn_sue_age_days": age_days_out,
            "earn_sue_basis": pd.Categorical(basis_out, categories=list(SUE_BASES)),
            "earn_sue_approximate": pd.arrays.BooleanArray(approx_out, ~cov_ok),
            "earn_sue_stale": pd.arrays.BooleanArray(stale_out, ~cov_ok),
        }
    )


# ---------------------------------------------------------------------------
# Ex-post label diagnostics (labels ONLY; never added to feature matrices)
# ---------------------------------------------------------------------------


def label_announcement_flags(
    announcements: pd.DataFrame | None,
    samples: pd.DataFrame,
    *,
    calendar: _clocks.Calendar | Sequence[Any],
    horizons: int | Iterable[int] = DEFAULT_HORIZONS,
) -> pd.DataFrame:
    """Ex-post diagnostic flags marking forward-label windows that span an earnings reaction.

    For label stratification and analysis only — never include in feature inputs.
    """
    if not set(KEYS).issubset(samples.columns):
        raise ValueError(f"samples requires columns {KEYS}")
    cal = _ensure_calendar(calendar)
    horizon_list, _ = _labels.horizons(horizons)
    sig_pos = cal.positions(samples["signal_session"])
    n = len(samples)
    assets_col = samples["asset_id"].astype(str).to_numpy(dtype=object)
    day_map = {d.isoformat(): idx for idx, d in enumerate(cal.days)}

    cand_pos_by_asset: dict[str, np.ndarray] = {}
    prim_pos_by_asset: dict[str, np.ndarray] = {}
    if (
        announcements is not None
        and not announcements.empty
        and "asset_id" in announcements.columns
    ):
        ann = announcements
        if "role" in ann.columns:
            ann = ann[ann["role"].astype(str) == "results_candidate"]
        if not ann.empty:
            r_col = (
                ann["reaction_session"].fillna("").astype(str).to_numpy(dtype=object)
                if "reaction_session" in ann.columns
                else np.full(len(ann), "", dtype=object)
            )
            r0_col = (
                ann["reaction_session_initial"]
                .fillna("")
                .astype(str)
                .to_numpy(dtype=object)
                if "reaction_session_initial" in ann.columns
                else np.full(len(ann), "", dtype=object)
            )
            prim_col = (
                ann["is_primary_final"].fillna(False).to_numpy(dtype=bool)
                if "is_primary_final" in ann.columns
                else np.ones(len(ann), dtype=bool)
            )
            cand_lists: dict[str, list[int]] = {}
            prim_lists: dict[str, list[int]] = {}
            for aid, r_s, r0_s, is_p in zip(
                ann["asset_id"].astype(str), r_col, r0_col, prim_col.tolist()
            ):
                chosen = str(r_s).strip() or str(r0_s).strip()
                if not chosen:
                    continue
                try:
                    iso = _clocks.day(chosen).isoformat()
                except ValueError:
                    continue
                pos = day_map.get(iso)
                if pos is None:
                    continue
                cand_lists.setdefault(aid, []).append(pos)
                if is_p:
                    prim_lists.setdefault(aid, []).append(pos)
            for aid, vals in cand_lists.items():
                cand_pos_by_asset[aid] = np.array(sorted(set(vals)), dtype=np.int64)
            for aid, vals in prim_lists.items():
                prim_pos_by_asset[aid] = np.array(sorted(set(vals)), dtype=np.int64)

    out_cols: dict[str, Any] = {
        "asset_id": samples["asset_id"].to_numpy(),
        "signal_session": samples["signal_session"].to_numpy(),
    }
    has_earn = {h: np.zeros(n, dtype=bool) for h in horizon_list}
    prim_earn = {h: np.zeros(n, dtype=bool) for h in horizon_list}

    codes, uniques = pd.factorize(pd.Series(assets_col, dtype=object), sort=False)
    for code, asset_name in enumerate(uniques):
        aid = str(asset_name)
        rows_idx = np.flatnonzero(codes == code)
        s_pos = sig_pos[rows_idx]
        c_arr = cand_pos_by_asset.get(aid)
        p_arr = prim_pos_by_asset.get(aid)
        if c_arr is not None and c_arr.size:
            lo = np.searchsorted(c_arr, s_pos, "right")
            for h in horizon_list:
                hi = np.searchsorted(c_arr, s_pos + h, "right")
                has_earn[h][rows_idx] = hi > lo
        if p_arr is not None and p_arr.size:
            lo_p = np.searchsorted(p_arr, s_pos, "right")
            for h in horizon_list:
                hi_p = np.searchsorted(p_arr, s_pos + h, "right")
                prim_earn[h][rows_idx] = hi_p > lo_p

    for h in horizon_list:
        out_cols[f"label_has_earnings_{h}d"] = has_earn[h]
        out_cols[f"label_primary_earnings_{h}d"] = prim_earn[h]

    return pd.DataFrame(out_cols)


__all__ = [
    "DEFAULT_SEC_EVENT_VOCABULARY",
    "EARNINGS_FEATURES",
    "EARNINGS_KINDS",
    "NEXT_BASES",
    "SEC_SOURCES",
    "SUE_BASES",
    "classify_sec_filing",
    "earnings_calendar_asof",
    "earnings_features",
    "label_announcement_flags",
    "sec_event_specs",
    "sec_public_clock",
    "sue_features",
    "typed_event_features",
]
