"""Industry classifications (SIC, division, Fama-French 12) and non-PIT metadata."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import numpy as np
import pandas as pd

from . import candidates as _candidates
from . import clocks
from .constants import KEYS
from .fundamentals_derived import cik_at

INDUSTRY_COLUMNS: tuple[str, ...] = (
    "sic",
    "sic_major_group",
    "sic_division",
    "ff12",
    "sic_pit",
    "sic_basis",
    "fiscal_year_end",
    "filer_category",
)

FF12_CODES: tuple[str, ...] = (
    "NoDur",
    "Durbl",
    "Manuf",
    "Enrgy",
    "Chems",
    "BusEq",
    "Telcm",
    "Utils",
    "Shops",
    "Hlth",
    "Money",
    "Other",
)

SIC_LIMITATION = (
    "SIC and issuer profiles reflect SEC submission snapshots, not point-in-time "
    "historical industry classifications (sic_pit=False)."
)

# Public Ken French 12-industry SIC ranges (1..11; valid 4-digit codes outside 1..11 -> "Other").
_FF12_RANGES: tuple[tuple[str, tuple[tuple[int, int], ...]], ...] = (
    (
        "NoDur",
        (
            (100, 999),
            (2000, 2399),
            (2700, 2749),
            (2770, 2799),
            (3100, 3199),
            (3940, 3989),
        ),
    ),
    (
        "Durbl",
        (
            (2500, 2519),
            (2590, 2599),
            (3630, 3659),
            (3710, 3711),
            (3714, 3714),
            (3716, 3716),
            (3750, 3751),
            (3792, 3792),
            (3900, 3939),
            (3990, 3999),
        ),
    ),
    (
        "Manuf",
        (
            (2520, 2589),
            (2600, 2699),
            (2750, 2769),
            (3000, 3099),
            (3200, 3569),
            (3580, 3629),
            (3700, 3709),
            (3712, 3713),
            (3715, 3715),
            (3717, 3749),
            (3752, 3791),
            (3793, 3799),
            (3830, 3839),
            (3860, 3899),
        ),
    ),
    ("Enrgy", ((1200, 1399), (2900, 2999))),
    ("Chems", ((2800, 2829), (2840, 2899))),
    (
        "BusEq",
        (
            (3570, 3579),
            (3660, 3692),
            (3694, 3699),
            (3810, 3829),
            (7370, 7379),
        ),
    ),
    ("Telcm", ((4800, 4899),)),
    ("Utils", ((4900, 4949),)),
    ("Shops", ((5000, 5999), (7200, 7299), (7600, 7699))),
    ("Hlth", ((2830, 2839), (3693, 3693), (3840, 3859), (8000, 8099))),
    ("Money", ((6000, 6999),)),
)

_SIC_DIVISIONS: tuple[tuple[int, int, str], ...] = (
    (100, 999, "A"),
    (1000, 1499, "B"),
    (1500, 1799, "C"),
    (2000, 3999, "D"),
    (4000, 4999, "E"),
    (5000, 5199, "F"),
    (5200, 5999, "G"),
    (6000, 6799, "H"),
    (7000, 8999, "I"),
    (9100, 9999, "J"),
)


def normalize_sic(raw: Any) -> str:
    """Normalize a raw SIC value into a 4-digit string (or ``''`` when absent/invalid)."""
    if raw is None or isinstance(raw, bool):
        return ""
    if isinstance(raw, (int, np.integer)):
        code = int(raw)
        return f"{code:04d}" if 1 <= code <= 9999 else ""
    text = str(raw).strip()
    if not text or not text.isascii() or not text.isdigit():
        return ""
    code = int(text)
    return f"{code:04d}" if 1 <= code <= 9999 else ""


def sic_to_major_group(sic: str) -> str:
    """Return the 2-digit SIC major group (or ``''`` when ``sic`` is empty)."""
    norm = normalize_sic(sic)
    return norm[:2] if norm else ""


def sic_to_division(sic: str) -> str:
    """Return the standard SIC division letter ``A``–``J`` (or ``''``)."""
    norm = normalize_sic(sic)
    if not norm:
        return ""
    code = int(norm)
    for lo, hi, letter in _SIC_DIVISIONS:
        if lo <= code <= hi:
            return letter
    return ""


def sic_to_ff12(sic: str) -> str:
    """Map a 4-digit SIC code to the public Fama-French 12 industry code."""
    norm = normalize_sic(sic)
    if not norm:
        return ""
    code = int(norm)
    for label, spans in _FF12_RANGES:
        for lo, hi in spans:
            if lo <= code <= hi:
                return label
    return "Other"


def _read_profiles_and_universe(
    version_or_material: Any,
    mapped_assets: list[str],
    mapped_ciks: set[str],
) -> tuple[pd.DataFrame, dict[str, Mapping[str, Any]], bool]:
    if isinstance(version_or_material, Mapping):
        raw_uni = version_or_material.get("universe", [])
        uni_records = (
            raw_uni.to_dict("records")
            if isinstance(raw_uni, pd.DataFrame)
            else list(raw_uni)
        )
        uni_map = {str(r["asset_id"]): r for r in uni_records if "asset_id" in r}
        has_family = "issuer_profiles" in version_or_material or "issuer_profiles" in (
            version_or_material.get("manifest", {}).get("data_families") or {}
        )
        raw_prof = version_or_material.get("issuer_profiles")
        prof_df = (
            raw_prof
            if isinstance(raw_prof, pd.DataFrame)
            else pd.DataFrame(raw_prof or [])
        )
        return prof_df, uni_map, has_family

    uni_records = _candidates.records(version_or_material.universe)
    uni_map = {str(r["asset_id"]): r for r in uni_records if "asset_id" in r}
    families = version_or_material.manifest.get("data_families") or {}
    has_family = isinstance(families, Mapping) and "issuer_profiles" in families
    if not has_family or not mapped_ciks or not mapped_assets:
        return pd.DataFrame(), uni_map, has_family
    reader = getattr(version_or_material, "issuer_profiles", None)
    if callable(reader):
        return reader(mapped_assets), uni_map, True
    return version_or_material.family("issuer_profiles", mapped_assets), uni_map, True


def industry(
    version_or_material: Any,
    samples: pd.DataFrame,
    *,
    time_policy: str,
) -> pd.DataFrame:
    """Attach SIC, division, Fama-French 12, and non-PIT flags onto ``samples``."""
    clocks.policy(time_policy)
    if not set(KEYS).issubset(samples.columns):
        raise ValueError("Samples require candidate KEYS (asset_id, signal_session)")

    basis = (
        "observed_before_decision"
        if time_policy == "observed_content"
        else "current_backfilled"
    )
    out = samples[KEYS].copy()
    n = len(samples)
    if n == 0:
        out["sic"] = pd.Series(dtype="object", index=samples.index)
        out["sic_major_group"] = pd.Series(dtype="object", index=samples.index)
        out["sic_division"] = pd.Series(dtype="object", index=samples.index)
        out["ff12"] = pd.Series(dtype="object", index=samples.index)
        out["sic_pit"] = pd.Series(dtype="bool", index=samples.index)
        out["sic_basis"] = pd.Series(dtype="object", index=samples.index)
        out["fiscal_year_end"] = pd.Series(dtype="object", index=samples.index)
        out["filer_category"] = pd.Series(dtype="object", index=samples.index)
        out.attrs.update(
            parameters={"time_policy": time_policy},
            limitations=[SIC_LIMITATION],
        )
        return out

    decision_ns = np.full(n, clocks.NAT, dtype=np.int64)
    if time_policy == "observed_content":
        if "decision_at" in samples.columns:
            decision_ns = clocks.instants(samples["decision_at"].to_numpy(dtype=object))
        elif not isinstance(version_or_material, Mapping) and hasattr(
            version_or_material, "calendar"
        ):
            ensured = _candidates.ensure_samples(version_or_material, samples)
            decision_ns = clocks.instants(ensured["decision_at"].to_numpy(dtype=object))
        else:
            raise ValueError(
                "observed_content industry lookup requires decision_at in samples"
            )

    asset_list = samples["asset_id"].astype(str).tolist()
    session_list = [clocks.day(v) for v in samples["signal_session"].tolist()]
    sample_ciks = cik_at(version_or_material, asset_list, session_list).tolist()
    mapped_ciks = {c for c in sample_ciks if c}
    mapped_assets = list(
        dict.fromkeys(aid for aid, c in zip(asset_list, sample_ciks) if c)
    )

    prof_df, uni_map, has_family = _read_profiles_and_universe(
        version_or_material, mapped_assets, mapped_ciks
    )

    # Index profiles per CIK sorted by (observed_ns, observation_sequence)
    by_cik: dict[str, list[tuple[int, int, str, str, str]]] = {}
    if not prof_df.empty and "cik" in prof_df.columns:
        obs_ns_arr = (
            clocks.instants(prof_df["observed_at"].to_numpy(dtype=object))
            if "observed_at" in prof_df.columns
            else np.zeros(len(prof_df), dtype=np.int64)
        )
        records = prof_df.to_dict("records")
        for idx, rec in enumerate(records):
            cik_raw = str(rec.get("cik") or "").strip()
            if not cik_raw or not cik_raw.isdigit():
                continue
            cik = cik_raw.zfill(10)
            if cik not in mapped_ciks:
                continue
            seq_raw = rec.get("observation_sequence", idx)
            seq = (
                int(seq_raw)
                if isinstance(seq_raw, (int, np.integer))
                and not isinstance(seq_raw, bool)
                else idx
            )
            sic_val = normalize_sic(rec.get("sic"))
            fye_val = str(rec.get("fiscal_year_end") or "").strip()
            cat_val = str(rec.get("filer_category") or "").strip()
            by_cik.setdefault(cik, []).append(
                (int(obs_ns_arr[idx]), seq, sic_val, fye_val, cat_val)
            )
        for entries in by_cik.values():
            entries.sort(key=lambda item: (item[0], item[1]))

    sics: list[str] = []
    majors: list[str] = []
    divisions: list[str] = []
    ff12s: list[str] = []
    fyes: list[str] = []
    cats: list[str] = []

    for i in range(n):
        cik = sample_ciks[i]
        aid = asset_list[i]
        chosen: tuple[str, str, str] | None = None
        entries = by_cik.get(cik, []) if cik else []
        if entries:
            if time_policy == "observed_content":
                d_ns = int(decision_ns[i])
                if d_ns != clocks.NAT:
                    visible = [
                        e
                        for e in entries
                        if e[0] != clocks.NAT and (e[0] - clocks.GRACE_NS) <= d_ns
                    ]
                    if visible:
                        _, _, sv, fv, cv = visible[-1]
                        chosen = (sv, fv, cv)
            else:
                _, _, sv, fv, cv = entries[-1]
                chosen = (sv, fv, cv)
        elif not has_family and time_policy == "public_reconstructed":
            uni_row = uni_map.get(aid, {})
            sv = normalize_sic(uni_row.get("sic"))
            fv = str(uni_row.get("fiscal_year_end") or "").strip()
            cv = str(uni_row.get("filer_category") or "").strip()
            if sv or fv or cv:
                chosen = (sv, fv, cv)

        if chosen is None:
            sics.append("")
            majors.append("")
            divisions.append("")
            ff12s.append("")
            fyes.append("")
            cats.append("")
        else:
            sv, fv, cv = chosen
            sics.append(sv)
            majors.append(sic_to_major_group(sv))
            divisions.append(sic_to_division(sv))
            ff12s.append(sic_to_ff12(sv))
            fyes.append(fv)
            cats.append(cv)

    out["sic"] = pd.Series(sics, index=samples.index, dtype="object")
    out["sic_major_group"] = pd.Series(majors, index=samples.index, dtype="object")
    out["sic_division"] = pd.Series(divisions, index=samples.index, dtype="object")
    out["ff12"] = pd.Series(ff12s, index=samples.index, dtype="object")
    out["sic_pit"] = pd.Series(False, index=samples.index, dtype="bool")
    out["sic_basis"] = pd.Series(basis, index=samples.index, dtype="object")
    out["fiscal_year_end"] = pd.Series(fyes, index=samples.index, dtype="object")
    out["filer_category"] = pd.Series(cats, index=samples.index, dtype="object")
    out.attrs.update(
        parameters={"time_policy": time_policy, "sic_basis": basis},
        limitations=[SIC_LIMITATION],
    )
    return out
