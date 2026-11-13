"""Point-in-time earnings-release document and structured LLM extraction features."""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping, Sequence
from datetime import date, timedelta
from typing import Any

import numpy as np
import pandas as pd

from . import candidates as _candidates
from . import clocks
from . import fundamentals_derived as _fundamentals_derived
from .clocks import NEW_YORK
from .constants import DECISION_TIME, FAMILY_SPECS

__all__ = [
    "GUIDANCE_ACTIONS",
    "RELEASE_COLUMNS",
    "RELEASE_EXTRACTION_STATUSES",
    "RELEASE_LIMITATION",
    "RELEASE_MAX_AGE_SESSIONS",
    "default_extractor_version",
    "release_features",
]

RELEASE_MAX_AGE_SESSIONS = 120
RELEASE_EXTRACTION_STATUSES: tuple[str, ...] = (
    "valid_facts",
    "no_facts",
    "not_extracted",
    "document_missing",
)
GUIDANCE_ACTIONS: tuple[str, ...] = (
    "raised",
    "lowered",
    "reaffirmed",
    "initiated",
    "withdrawn",
)
RELEASE_COLUMNS: tuple[str, ...] = (
    "release_extraction_status",
    "release_sessions_since",
    "release_revenue",
    "release_net_income",
    "release_eps_diluted",
    "release_eps_adjusted",
    "release_revenue_yoy",
    "release_eps_sue_rw",
    *(f"guidance_revenue_{action}" for action in GUIDANCE_ACTIONS),
    *(f"guidance_eps_{action}" for action in GUIDANCE_ACTIONS),
    "guidance_revenue_fy_mid_change",
    "buyback_authorized_365d_to_mcap",
    "dividend_change_pct",
)
RELEASE_LIMITATION = (
    "LLM facts are model outputs validated against quoted text; release availability "
    "uses SEC acceptance as an upper bound of publication."
)

_ELIGIBLE_ROLES = frozenset({"press_release", "letter"})
_GUIDANCE_RELATIONS = frozenset({"next_quarter", "current_fiscal_year"})
_BUYBACK_AUTH_ACTIONS = frozenset({"authorized", "increased"})
_DIVIDEND_CHANGE_ACTIONS = frozenset({"raised", "lowered"})
_CIK_RE = re.compile(r"^[0-9]{10}$")


def _manifest_of(version: Any) -> Mapping[str, Any]:
    manifest = getattr(version, "manifest", None)
    if isinstance(manifest, Mapping):
        return manifest
    if isinstance(version, Mapping) and isinstance(version.get("manifest"), Mapping):
        return version["manifest"]
    return {}


def default_extractor_version(version: Any) -> str | None:
    """Return ``manifest['extraction']['default_extractor_version']`` when non-empty."""
    extraction = _manifest_of(version).get("extraction")
    if not isinstance(extraction, Mapping):
        return None
    raw = extraction.get("default_extractor_version")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return None


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
    candidates: pd.DataFrame,
    *,
    extractor_version: str | None,
    missing_families: Sequence[str],
) -> pd.DataFrame:
    out = pd.DataFrame(index=candidates.index)
    out.attrs["extractor_version"] = extractor_version
    out.attrs["release_missing"] = list(dict.fromkeys(missing_families))
    return out


def _read_optional_family(
    version: Any,
    name: str,
    *,
    identities: Sequence[str] | None = None,
) -> pd.DataFrame | None:
    if name not in FAMILY_SPECS or name not in _candidates.families(version):
        return None
    reader = getattr(version, "family", None)
    if callable(reader):
        if identities is not None:
            try:
                return reader(name, symbols=list(identities))
            except (AttributeError, KeyError, TypeError, ValueError):
                return reader(name)
        return reader(name)
    if isinstance(version, Mapping) and isinstance(version.get(name), pd.DataFrame):
        return version[name]
    return None


def _pad_cik(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    stripped = value.strip()
    if not stripped.isdigit():
        return ""
    padded = stripped.zfill(10)
    return padded if _CIK_RE.fullmatch(padded) and int(padded) > 0 else ""


def _parse_utc(series: pd.Series) -> pd.Series:
    return pd.to_datetime(series, utc=True, errors="coerce")


def _sec_public_series(frame: pd.DataFrame) -> pd.Series:
    if "public_at" in frame.columns:
        parsed = _parse_utc(frame["public_at"])
        if parsed.notna().all():
            return parsed
    else:
        parsed = pd.Series(pd.NaT, index=frame.index, dtype="datetime64[ns, UTC]")
    accepted = (
        frame["accepted_at"].fillna("").astype(str)
        if "accepted_at" in frame.columns
        else pd.Series("", index=frame.index)
    )
    filing = (
        frame["filing_date"].fillna("").astype(str)
        if "filing_date" in frame.columns
        else pd.Series("", index=frame.index)
    )
    fallback_vals = []
    for idx, cur in enumerate(parsed):
        if pd.notna(cur):
            fallback_vals.append(cur)
            continue
        acc = accepted.iat[idx]
        fdate = filing.iat[idx]
        ts = clocks.sec_public_fallback(acc or None, fdate or None)
        fallback_vals.append(ts)
    return pd.Series(
        pd.to_datetime(fallback_vals, utc=True, errors="coerce"),
        index=frame.index,
    )


def _avail_series(
    public_at: pd.Series, recorded: pd.Series | None, policy: str
) -> pd.Series:
    pub_s = public_at if isinstance(public_at, pd.Series) else pd.Series(public_at)
    if policy == "public_reconstructed" or recorded is None:
        return pub_s
    rec_s = (
        _parse_utc(recorded)
        if isinstance(recorded, pd.Series)
        else pd.Series(
            _parse_utc(pd.Series(recorded, index=pub_s.index)), index=pub_s.index
        )
    )
    both = pd.concat([pub_s, rec_s], axis=1)
    return both.max(axis=1, skipna=False)


def _evidence_offset(raw_json: Any, fallback_index: Any) -> tuple[int, int]:
    idx = int(fallback_index) if pd.notna(fallback_index) else 1_000_000
    if isinstance(raw_json, str) and raw_json:
        try:
            parsed = json.loads(raw_json)
            items = parsed if isinstance(parsed, list) else parsed.get("quotes", [])
            if isinstance(items, list):
                offsets = [
                    int(item["offset"])
                    for item in items
                    if isinstance(item, Mapping)
                    and isinstance(item.get("offset"), (int, float))
                ]
                if offsets:
                    return (min(offsets), idx)
        except (ValueError, TypeError, AttributeError):
            pass
    return (1_000_000_000, idx)


def _fact_mid_base(row: Mapping[str, Any]) -> float:
    low = row.get("value_low_base")
    high = row.get("value_high_base")
    low_f = float(low) if low is not None and pd.notna(low) else math.nan
    high_f = float(high) if high is not None and pd.notna(high) else math.nan
    if math.isfinite(low_f) and math.isfinite(high_f):
        return 0.5 * (low_f + high_f)
    if math.isfinite(low_f):
        return low_f
    return high_f


def _previous_mid_from_row(row: Mapping[str, Any]) -> float:
    for low_k, high_k in (
        ("previous_value_low_base", "previous_value_high_base"),
        ("previous_low_base", "previous_high_base"),
    ):
        low = row.get(low_k)
        high = row.get(high_k)
        low_f = float(low) if low is not None and pd.notna(low) else math.nan
        high_f = float(high) if high is not None and pd.notna(high) else math.nan
        if math.isfinite(low_f) and math.isfinite(high_f):
            return 0.5 * (low_f + high_f)
        if math.isfinite(low_f):
            return low_f
        if math.isfinite(high_f):
            return high_f
    raw_json = row.get("evidence_json")
    if isinstance(raw_json, str) and raw_json:
        try:
            parsed = json.loads(raw_json)
            if isinstance(parsed, Mapping):
                prev = parsed.get("previous_mid_base")
                if isinstance(prev, (int, float)) and math.isfinite(float(prev)):
                    return float(prev)
                prev_low = parsed.get("previous_low_base")
                prev_high = parsed.get("previous_high_base")
                if isinstance(prev_low, (int, float)) and isinstance(
                    prev_high, (int, float)
                ):
                    return 0.5 * (float(prev_low) + float(prev_high))
                if isinstance(prev_low, (int, float)):
                    return float(prev_low)
        except (ValueError, TypeError):
            pass
    return math.nan


def _decision_cutoffs(calendar: Sequence[date]) -> tuple[list[date], np.ndarray]:
    sessions = [clocks.day(d) for d in calendar]
    cutoffs = np.array(
        [
            pd.Timestamp.combine(sess, DECISION_TIME)
            .tz_localize(NEW_YORK)
            .tz_convert("UTC")
            .value
            for sess in sessions
        ],
        dtype="int64",
    )
    return sessions, cutoffs


def _quarter_number(row: Mapping[str, Any]) -> int | None:
    q = row.get("quarter")
    if q is not None and pd.notna(q):
        try:
            qi = int(q)
            if 1 <= qi <= 4:
                return qi
        except (TypeError, ValueError):
            pass
    kind = str(row.get("period_kind") or "").strip().lower()
    if kind == "full_year":
        return 4
    return None


def _prior_quarter_lookup(
    version: Any, ciks: Sequence[str], policy: str
) -> dict[tuple[str, int, int, str], list[tuple[int, float, date | None]]]:
    """Build PIT-ordered ``(cik, fiscal_year, quarter, concept) -> [(known_ns, val, period_end)]``."""
    if not ciks or "fundamentals" not in _candidates.families(version):
        return {}
    try:
        ledger = _fundamentals_derived.fiscal_quarters(
            version,
            time_policy=policy,
            concepts=("revenue", "eps_diluted"),
            ciks=list(ciks),
        )
    except (AttributeError, KeyError, TypeError, ValueError):
        return {}
    if ledger is None or ledger.empty:
        return {}
    lookup: dict[tuple[str, int, int, str], list[tuple[int, float, date | None]]] = {}
    known_col = (
        "first_known_at"
        if "first_known_at" in ledger.columns
        else "available_at"
        if "available_at" in ledger.columns
        else None
    )
    val_col = (
        "first_value"
        if "first_value" in ledger.columns
        else "value"
        if "value" in ledger.columns
        else None
    )
    if known_col is None or val_col is None:
        return {}
    known_ts = _parse_utc(ledger[known_col])
    for idx, row in ledger.iterrows():
        ts = known_ts.loc[idx]
        if pd.isna(ts):
            continue
        cik = _pad_cik(str(row.get("cik", "")))
        concept = str(row.get("concept", ""))
        fy = row.get("fiscal_year")
        fq_raw = row.get("fiscal_quarter", row.get("quarter"))
        val = row.get(val_col)
        if not cik or not concept or pd.isna(fy) or pd.isna(fq_raw) or pd.isna(val):
            continue
        fq_str = str(fq_raw).strip().upper()
        if fq_str.startswith("Q") and fq_str[1:].isdigit():
            q_num = int(fq_str[1:])
        elif fq_str == "FY":
            q_num = 4
        else:
            try:
                q_num = int(float(fq_str))
            except ValueError:
                continue
        val_f = float(val)
        if not math.isfinite(val_f):
            continue
        pend_raw = row.get("period_end")
        pend = (
            clocks.day(pend_raw)
            if pend_raw is not None and pd.notna(pend_raw)
            else None
        )
        key = (cik, int(fy), q_num, concept)
        lookup.setdefault(key, []).append((int(ts.value), val_f, pend))
    for entries in lookup.values():
        entries.sort(key=lambda item: item[0])
    return lookup


def _pit_quarter_value(
    lookup: Mapping[tuple[str, int, int, str], list[tuple[int, float, date | None]]],
    cik: str,
    fiscal_year: int,
    quarter: int,
    concept: str,
    decision_ns: int,
) -> tuple[float, date | None]:
    entries = lookup.get((cik, fiscal_year, quarter, concept))
    if not entries:
        return (math.nan, None)
    chosen_val = math.nan
    chosen_end: date | None = None
    for known_ns, val, pend in entries:
        if known_ns <= decision_ns:
            chosen_val = val
            chosen_end = pend
        else:
            break
    return (chosen_val, chosen_end)


def _split_factor_lookup(
    version: Any, asset_ids: Sequence[str]
) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    if not asset_ids or "daily_returns" not in _candidates.families(version):
        return {}
    try:
        dr = version.total_returns(list(asset_ids))
    except (AttributeError, KeyError, TypeError, ValueError):
        dr = _read_optional_family(version, "daily_returns")
    if dr is None or dr.empty or "split_index" not in dr.columns:
        return {}
    out: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    dr_copy = dr[["asset_id", "date", "split_index"]].copy()
    dr_copy["asset_id"] = dr_copy["asset_id"].astype(str)
    dr_copy["date_ord"] = dr_copy["date"].map(lambda d: clocks.day(d).toordinal())
    dr_copy["split_index"] = pd.to_numeric(dr_copy["split_index"], errors="coerce")
    dr_copy = dr_copy.dropna(subset=["split_index"]).sort_values(
        ["asset_id", "date_ord"]
    )
    for aid, grp in dr_copy.groupby("asset_id", sort=False):
        out[str(aid)] = (
            grp["date_ord"].to_numpy(dtype="int64"),
            grp["split_index"].to_numpy(dtype="float64"),
        )
    return out


def _split_at(
    splits: Mapping[str, tuple[np.ndarray, np.ndarray]], asset_id: str, session: date
) -> float:
    pair = splits.get(asset_id)
    if pair is None or len(pair[0]) == 0:
        return 1.0
    ords, vals = pair
    pos = int(np.searchsorted(ords, session.toordinal(), side="right")) - 1
    if pos < 0:
        return float(vals[0]) if vals[0] > 0 else 1.0
    return float(vals[pos]) if vals[pos] > 0 else 1.0


def _raw_close_lookup(
    version: Any, asset_ids: Sequence[str]
) -> dict[tuple[str, date], float]:
    if not asset_ids:
        return {}
    prices_fn = getattr(version, "prices", None)
    if not callable(prices_fn):
        return {}
    try:
        raw = prices_fn(list(asset_ids), adjusted=False)
    except (AttributeError, KeyError, TypeError, ValueError):
        return {}
    if raw is None or raw.empty or "close" not in raw.columns:
        return {}
    out: dict[tuple[str, date], float] = {}
    for aid, dt, close in zip(
        raw["asset_id"].astype(str),
        raw["date"].map(clocks.day),
        pd.to_numeric(raw["close"], errors="coerce"),
    ):
        if pd.notna(close) and float(close) > 0:
            out[(aid, dt)] = float(close)
    return out


def release_features(
    version: Any,
    candidates: pd.DataFrame,
    *,
    time_policy: str,
    extractor_version: str | None = None,
    fundamentals: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Build point-in-time earnings-release extraction features aligned to ``candidates``.

    Only ``validation_status == 'valid'`` facts of one explicit ``extractor_version``
    (defaulting to ``manifest['extraction']['default_extractor_version']``) are read.
    When no ``extractor_version`` is active or the release/extraction families are
    absent from ``version``, returns an empty-column ``DataFrame`` indexed like
    ``candidates``.
    """
    policy = _validate_candidates(candidates, time_policy)
    resolved_version = (
        extractor_version.strip()
        if isinstance(extractor_version, str) and extractor_version.strip()
        else default_extractor_version(version)
    )
    families = _candidates.families(version)
    missing = [
        name
        for name in ("release_documents", "extraction_facts")
        if name not in families
    ]
    if resolved_version is None or "release_documents" not in families:
        return _empty_result(
            candidates,
            extractor_version=resolved_version,
            missing_families=missing,
        )
    if candidates.empty:
        out = pd.DataFrame(
            {col: pd.Series(dtype="float64") for col in RELEASE_COLUMNS},
            index=candidates.index,
        )
        out["release_extraction_status"] = pd.Categorical(
            [], categories=RELEASE_EXTRACTION_STATUSES
        )
        out.attrs["extractor_version"] = resolved_version
        out.attrs["release_missing"] = missing
        return out

    asset_ids = candidates["asset_id"].astype(str).tolist()
    signal_sessions = [clocks.day(s) for s in candidates["signal_session"].tolist()]
    decision_ts = _parse_utc(candidates["decision_at"])
    decision_ns_arr = decision_ts.map(
        lambda ts: int(ts.value) if pd.notna(ts) else -1
    ).to_numpy(dtype="int64")

    ciks_series = _fundamentals_derived.cik_at(version, asset_ids, signal_sessions)
    cand_ciks = [_pad_cik(v) for v in ciks_series.tolist()]
    unique_ciks = sorted({c for c in cand_ciks if c})
    unique_assets = sorted(set(asset_ids))

    docs_df = _read_optional_family(version, "release_documents")
    facts_df = _read_optional_family(version, "extraction_facts")
    results_df = _read_optional_family(version, "extraction_results")

    cal_raw = getattr(version, "calendar", None) or _manifest_of(version).get(
        "calendar", []
    )
    cal_sessions, cal_cutoffs = _decision_cutoffs(cal_raw)
    sess_to_idx = {sess: idx for idx, sess in enumerate(cal_sessions)}

    # Organize primary eligible document per (cik, accession).
    # Accessions with only skipped/ineligible rows still mark a release with document_missing.
    releases_by_cik: dict[str, list[dict[str, Any]]] = {}
    if docs_df is not None and not docs_df.empty and unique_ciks:
        docs = docs_df.copy()
        docs["cik"] = docs["cik"].astype(str).map(_pad_cik)
        docs = docs[docs["cik"].isin(unique_ciks)]
        if not docs.empty:
            pub_ts = _sec_public_series(docs)
            obs_col = docs["observed_at"] if "observed_at" in docs.columns else None
            avail_ts = _avail_series(pub_ts, obs_col, policy)
            docs["_public_ns"] = pub_ts.map(
                lambda ts: int(ts.value) if pd.notna(ts) else -1
            )
            docs["_avail_ns"] = avail_ts.map(
                lambda ts: int(ts.value) if pd.notna(ts) else -1
            )
            docs = docs[docs["_avail_ns"] > 0]
            if "sequence" not in docs.columns:
                docs["sequence"] = 1
            docs["sequence"] = (
                pd.to_numeric(docs["sequence"], errors="coerce").fillna(999).astype(int)
            )
            for (cik, accession), grp in docs.groupby(["cik", "accession"], sort=False):
                role_col = (
                    grp["role"].fillna("").astype(str)
                    if "role" in grp.columns
                    else pd.Series("press_release", index=grp.index)
                )
                cap_col = (
                    grp["capture_status"].fillna("captured").astype(str)
                    if "capture_status" in grp.columns
                    else pd.Series("captured", index=grp.index)
                )
                eligible = grp[role_col.isin(_ELIGIBLE_ROLES) & (cap_col == "captured")]
                avail_ns = int(grp["_avail_ns"].min())
                pub_ns = int(grp["_public_ns"].min())
                first_sess_idx = (
                    int(np.searchsorted(cal_cutoffs, avail_ns, side="left"))
                    if len(cal_cutoffs)
                    else 0
                )
                if not eligible.empty:
                    chosen = eligible.sort_values(
                        ["sequence", "document_id"], kind="stable"
                    ).iloc[0]
                    releases_by_cik.setdefault(str(cik), []).append(
                        {
                            "accession": str(accession),
                            "document_id": str(chosen["document_id"]),
                            "avail_ns": int(chosen["_avail_ns"]),
                            "public_ns": int(chosen["_public_ns"]),
                            "first_sess_idx": int(
                                np.searchsorted(
                                    cal_cutoffs, int(chosen["_avail_ns"]), side="left"
                                )
                            )
                            if len(cal_cutoffs)
                            else 0,
                            "captured": True,
                        }
                    )
                else:
                    releases_by_cik.setdefault(str(cik), []).append(
                        {
                            "accession": str(accession),
                            "document_id": "",
                            "avail_ns": avail_ns,
                            "public_ns": pub_ns,
                            "first_sess_idx": first_sess_idx,
                            "captured": False,
                        }
                    )
    for rels in releases_by_cik.values():
        rels.sort(key=lambda item: (item["avail_ns"], item["accession"]))

    # Done results lookup: document_id -> earliest done avail_ns for resolved_version, run_index=1.
    done_result_ns: dict[str, int] = {}
    if results_df is not None and not results_df.empty and unique_ciks:
        res = results_df.copy()
        if "extractor_version" in res.columns:
            res = res[res["extractor_version"].astype(str) == resolved_version]
        if "run_index" in res.columns:
            res = res[pd.to_numeric(res["run_index"], errors="coerce").fillna(1) == 1]
        if "status" in res.columns:
            res = res[res["status"].astype(str) == "done"]
        if not res.empty and "document_id" in res.columns:
            rec_ts = (
                _parse_utc(res["recorded_at"])
                if "recorded_at" in res.columns
                else pd.Series(pd.Timestamp("1970-01-01", tz="UTC"), index=res.index)
            )
            for doc_id, ts in zip(res["document_id"].astype(str), rec_ts):
                ns = (
                    0
                    if policy == "public_reconstructed" or pd.isna(ts)
                    else int(ts.value)
                )
                prev = done_result_ns.get(doc_id)
                if prev is None or ns < prev:
                    done_result_ns[doc_id] = ns

    # Valid facts lookup: document_id -> list of valid fact dicts (run_index=1, resolved_version).
    facts_by_doc: dict[str, list[dict[str, Any]]] = {}
    if facts_df is not None and not facts_df.empty and unique_ciks:
        fdf = facts_df.copy()
        fdf["cik"] = fdf["cik"].astype(str).map(_pad_cik)
        fdf = fdf[fdf["cik"].isin(unique_ciks)]
        if "extractor_version" in fdf.columns:
            fdf = fdf[fdf["extractor_version"].astype(str) == resolved_version]
        if "validation_status" in fdf.columns:
            fdf = fdf[fdf["validation_status"].astype(str) == "valid"]
        if "run_index" in fdf.columns:
            fdf = fdf[pd.to_numeric(fdf["run_index"], errors="coerce").fillna(1) == 1]
        if not fdf.empty:
            f_pub = _sec_public_series(fdf)
            f_rec = fdf["recorded_at"] if "recorded_at" in fdf.columns else None
            f_avail = _avail_series(f_pub, f_rec, policy)
            fdf["_avail_ns"] = f_avail.map(
                lambda ts: int(ts.value) if pd.notna(ts) else -1
            )
            fdf = fdf[fdf["_avail_ns"] > 0]
            for row_dict in fdf.to_dict("records"):
                row_dict["_sort_key"] = _evidence_offset(
                    row_dict.get("evidence_json"), row_dict.get("fact_index")
                )
                row_dict["_mid_base"] = _fact_mid_base(row_dict)
                doc_id = str(row_dict.get("document_id", ""))
                if doc_id:
                    facts_by_doc.setdefault(doc_id, []).append(row_dict)
    for flist in facts_by_doc.values():
        flist.sort(key=lambda item: item["_sort_key"])

    quarter_lookup = _prior_quarter_lookup(version, unique_ciks, policy)
    splits_lookup = _split_factor_lookup(version, unique_assets)
    raw_closes = _raw_close_lookup(version, unique_assets)

    mcap_arr: np.ndarray | None = None
    if fundamentals is not None and "market_cap_issuer_value" in fundamentals.columns:
        market_cap = pd.to_numeric(
            fundamentals["market_cap_issuer_value"], errors="coerce"
        )
        if "market_cap_issuer_status" in fundamentals.columns:
            unverified = fundamentals["market_cap_issuer_status"].eq("split_unverified")
            market_cap = market_cap.mask(unverified.fillna(False))
        mcap_arr = market_cap.to_numpy(dtype="float64")

    n_rows = len(candidates)
    status_out = ["document_missing"] * n_rows
    num_cols: dict[str, np.ndarray] = {
        col: np.full(n_rows, np.nan, dtype="float64")
        for col in RELEASE_COLUMNS
        if col != "release_extraction_status"
    }

    day_365_ns = int(timedelta(days=365).total_seconds() * 1_000_000_000)

    for i in range(n_rows):
        cik = cand_ciks[i]
        dec_ns = int(decision_ns_arr[i])
        if not cik or dec_ns <= 0:
            continue
        rels = releases_by_cik.get(cik)
        if not rels:
            continue
        sig_sess = signal_sessions[i]
        entry_idx = sess_to_idx.get(sig_sess, -1) + 1
        avail_rels = [r for r in rels if r["avail_ns"] <= dec_ns]
        if not avail_rels:
            continue

        latest = avail_rels[-1]
        if len(cal_sessions) and entry_idx > 0:
            sessions_since = max(0, entry_idx - latest["first_sess_idx"])
        else:
            sessions_since = int(
                max(0, (dec_ns - latest["avail_ns"]) // (86_400 * 1_000_000_000))
            )
        if sessions_since > RELEASE_MAX_AGE_SESSIONS:
            continue

        num_cols["release_sessions_since"][i] = float(sessions_since)
        if not latest["captured"] or not latest["document_id"]:
            status_out[i] = "document_missing"
            continue

        doc_id = latest["document_id"]
        vis_facts = [
            f for f in facts_by_doc.get(doc_id, ()) if int(f["_avail_ns"]) <= dec_ns
        ]
        if vis_facts:
            status_out[i] = "valid_facts"
        elif doc_id in done_result_ns and done_result_ns[doc_id] <= dec_ns:
            status_out[i] = "no_facts"
        else:
            status_out[i] = "not_extracted"

        if status_out[i] == "valid_facts":
            # Headline reported results.
            rev_fact: dict[str, Any] | None = None
            ni_fact: dict[str, Any] | None = None
            eps_gaap_fact: dict[str, Any] | None = None
            eps_adj_fact: dict[str, Any] | None = None
            for f in vis_facts:
                if str(f.get("fact_type", "")) != "result":
                    continue
                rel = str(f.get("period_relation") or "reported")
                if rel != "reported":
                    continue
                val = float(f["_mid_base"])
                if not math.isfinite(val):
                    continue
                metric = str(f.get("metric", ""))
                basis = str(f.get("basis") or "unspecified")
                sbasis = str(f.get("share_basis") or "")
                if metric == "revenue" and basis in ("gaap", "unspecified"):
                    if rev_fact is None or (
                        rev_fact.get("basis") != "gaap" and basis == "gaap"
                    ):
                        rev_fact = f
                elif metric == "net_income" and basis in ("gaap", "unspecified"):
                    if ni_fact is None or (
                        ni_fact.get("basis") != "gaap" and basis == "gaap"
                    ):
                        ni_fact = f
                elif metric == "eps" and basis == "adjusted":
                    if eps_adj_fact is None or (
                        eps_adj_fact.get("share_basis") != "diluted"
                        and sbasis == "diluted"
                    ):
                        eps_adj_fact = f
                elif (
                    metric == "eps"
                    and basis in ("gaap", "unspecified")
                    and sbasis in ("diluted", "", "None")
                    and (
                        eps_gaap_fact is None
                        or (
                            str(eps_gaap_fact.get("share_basis") or "") != "diluted"
                            and sbasis == "diluted"
                        )
                    )
                ):
                    eps_gaap_fact = f

            if rev_fact is not None:
                rev_val = float(rev_fact["_mid_base"])
                num_cols["release_revenue"][i] = rev_val
                fy = rev_fact.get("fiscal_year")
                q_num = _quarter_number(rev_fact)
                if (
                    fy is not None
                    and pd.notna(fy)
                    and q_num is not None
                    and str(rev_fact.get("period_kind") or "quarter") == "quarter"
                ):
                    prior_rev, _ = _pit_quarter_value(
                        quarter_lookup, cik, int(fy) - 1, q_num, "revenue", dec_ns
                    )
                    if math.isfinite(prior_rev) and prior_rev > 0:
                        num_cols["release_revenue_yoy"][i] = rev_val / prior_rev - 1.0

            if ni_fact is not None:
                num_cols["release_net_income"][i] = float(ni_fact["_mid_base"])

            if eps_gaap_fact is not None:
                eps_val = float(eps_gaap_fact["_mid_base"])
                num_cols["release_eps_diluted"][i] = eps_val
                fy = eps_gaap_fact.get("fiscal_year")
                q_num = _quarter_number(eps_gaap_fact)
                raw_px = raw_closes.get((asset_ids[i], sig_sess), math.nan)
                if (
                    fy is not None
                    and pd.notna(fy)
                    and q_num is not None
                    and str(eps_gaap_fact.get("period_kind") or "quarter") == "quarter"
                    and math.isfinite(raw_px)
                    and raw_px > 0
                ):
                    prior_eps, prior_end = _pit_quarter_value(
                        quarter_lookup, cik, int(fy) - 1, q_num, "eps_diluted", dec_ns
                    )
                    if math.isfinite(prior_eps):
                        sp_now = _split_at(splits_lookup, asset_ids[i], sig_sess)
                        sp_prev = (
                            _split_at(splits_lookup, asset_ids[i], prior_end)
                            if prior_end is not None
                            else sp_now
                        )
                        ratio = sp_now / sp_prev if sp_prev > 0 else 1.0
                        adj_prior_eps = prior_eps / ratio if ratio > 0 else prior_eps
                        num_cols["release_eps_sue_rw"][i] = (
                            eps_val - adj_prior_eps
                        ) / raw_px

            if eps_adj_fact is not None:
                num_cols["release_eps_adjusted"][i] = float(eps_adj_fact["_mid_base"])

            # Default guidance action flags to 0.0 when extraction has valid facts, then mark latest guidance release.
            for m_prefix in ("revenue", "eps"):
                for act in GUIDANCE_ACTIONS:
                    num_cols[f"guidance_{m_prefix}_{act}"][i] = 0.0

        # Guidance from the latest available release within 120 sessions carrying next_quarter / current_fiscal_year guidance.
        recent_rels = []
        for r in reversed(avail_rels):
            if not r["captured"] or not r["document_id"]:
                continue
            age = (
                max(0, entry_idx - r["first_sess_idx"])
                if (len(cal_sessions) and entry_idx > 0)
                else int(max(0, (dec_ns - r["avail_ns"]) // (86_400 * 1_000_000_000)))
            )
            if age <= RELEASE_MAX_AGE_SESSIONS:
                recent_rels.append(r)

        for r in recent_rels:
            r_facts = [
                f
                for f in facts_by_doc.get(r["document_id"], ())
                if int(f["_avail_ns"]) <= dec_ns
                and str(f.get("fact_type", "")) == "guidance"
                and str(f.get("period_relation", "")) in _GUIDANCE_RELATIONS
            ]
            if not r_facts:
                continue
            for m_prefix in ("revenue", "eps"):
                for act in GUIDANCE_ACTIONS:
                    if math.isnan(num_cols[f"guidance_{m_prefix}_{act}"][i]):
                        num_cols[f"guidance_{m_prefix}_{act}"][i] = 0.0
            for f in r_facts:
                metric = str(f.get("metric", ""))
                act = str(f.get("action", ""))
                if metric in ("revenue", "eps") and act in GUIDANCE_ACTIONS:
                    num_cols[f"guidance_{metric}_{act}"][i] = 1.0
            # FY revenue midpoint change from this latest guidance release.
            fy_rev = [
                f
                for f in r_facts
                if str(f.get("metric", "")) == "revenue"
                and str(f.get("period_relation", "")) == "current_fiscal_year"
                and math.isfinite(float(f["_mid_base"]))
            ]
            if fy_rev:
                cur_f = fy_rev[0]
                cur_mid = float(cur_f["_mid_base"])
                prev_mid = _previous_mid_from_row(cur_f)
                if (
                    not math.isfinite(prev_mid)
                    and cur_f.get("fiscal_year") is not None
                    and pd.notna(cur_f.get("fiscal_year"))
                ):
                    target_fy = int(cur_f["fiscal_year"])
                    target_basis = str(cur_f.get("basis") or "unspecified")
                    for earlier in reversed(avail_rels):
                        if (
                            earlier["avail_ns"] >= r["avail_ns"]
                            or not earlier["document_id"]
                        ):
                            continue
                        e_matches = [
                            ef
                            for ef in facts_by_doc.get(earlier["document_id"], ())
                            if int(ef["_avail_ns"]) <= dec_ns
                            and str(ef.get("fact_type", "")) == "guidance"
                            and str(ef.get("metric", "")) == "revenue"
                            and ef.get("fiscal_year") is not None
                            and pd.notna(ef.get("fiscal_year"))
                            and int(ef["fiscal_year"]) == target_fy
                            and str(ef.get("basis") or "unspecified") == target_basis
                            and math.isfinite(float(ef["_mid_base"]))
                        ]
                        if e_matches:
                            prev_mid = float(e_matches[0]["_mid_base"])
                            break
                if math.isfinite(prev_mid) and prev_mid != 0.0:
                    num_cols["guidance_revenue_fy_mid_change"][i] = (
                        cur_mid - prev_mid
                    ) / abs(prev_mid)
            break

        # 365-day buyback authorizations scaled by market cap.
        if (
            mcap_arr is not None
            and math.isfinite(float(mcap_arr[i]))
            and float(mcap_arr[i]) > 0
        ):
            bb_total = 0.0
            has_any_extracted_365 = False
            min_ns = dec_ns - day_365_ns
            for r in avail_rels:
                if r["avail_ns"] <= min_ns or not r["captured"] or not r["document_id"]:
                    continue
                r_doc = r["document_id"]
                r_vis = [
                    f
                    for f in facts_by_doc.get(r_doc, ())
                    if int(f["_avail_ns"]) <= dec_ns
                ]
                if r_vis or (
                    r_doc in done_result_ns and done_result_ns[r_doc] <= dec_ns
                ):
                    has_any_extracted_365 = True
                for f in r_vis:
                    if (
                        str(f.get("fact_type", "")) == "buyback"
                        and str(f.get("action", "")) in _BUYBACK_AUTH_ACTIONS
                        and str(f.get("unit") or "money") == "money"
                        and math.isfinite(float(f["_mid_base"]))
                        and float(f["_mid_base"]) > 0
                    ):
                        bb_total += float(f["_mid_base"])
            if has_any_extracted_365:
                num_cols["buyback_authorized_365d_to_mcap"][i] = bb_total / float(
                    mcap_arr[i]
                )

        # Dividend change pct from latest release within 120 sessions with raised/lowered dividend.
        for r in recent_rels:
            div_facts = [
                f
                for f in facts_by_doc.get(r["document_id"], ())
                if int(f["_avail_ns"]) <= dec_ns
                and str(f.get("fact_type", "")) == "dividend"
                and str(f.get("action", "")) in _DIVIDEND_CHANGE_ACTIONS
                and math.isfinite(float(f["_mid_base"]))
            ]
            if not div_facts:
                continue
            dfact = div_facts[0]
            cur_div = float(dfact["_mid_base"])
            prev_div = _previous_mid_from_row(dfact)
            if math.isfinite(prev_div) and prev_div > 0:
                num_cols["dividend_change_pct"][i] = cur_div / prev_div - 1.0
            break

    out_data: dict[str, Any] = {
        "release_extraction_status": pd.Categorical(
            status_out, categories=RELEASE_EXTRACTION_STATUSES
        )
    }
    for col in RELEASE_COLUMNS:
        if col != "release_extraction_status":
            out_data[col] = num_cols[col]
    out = pd.DataFrame(out_data, index=candidates.index)
    out.attrs["extractor_version"] = resolved_version
    out.attrs["release_missing"] = missing
    return out
