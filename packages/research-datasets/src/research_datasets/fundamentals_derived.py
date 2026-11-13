"""Point-in-time derived financial statement states, trailing figures, and factors."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from . import asof, clocks
from .concepts import (
    ALL_CONCEPTS,
    BARE_TAG_TO_CONCEPT,
    COMPOSITES,
    CONCEPT_TAGS,
    CONCEPTS,
    DEFAULT_VIEWS,
    DERIVATION_VERSION,
    FUNDAMENTAL_STATUSES,
    PERIODIC_ANNUAL_FORMS,
    PERIODIC_QUARTER_FORMS,
    STALE_AFTER_DAYS,
    SYNTHETIC_METRIC_TO_CONCEPT,
    TAG_RANKS,
    CompositeSpec,
    Concept,
    parse_view_name,
    required_base_concepts,
    views_for_concept,
)
from .constants import KEYS

STATE_COLUMNS: tuple[str, ...] = (
    "cik",
    "view",
    "available_at",
    "value",
    "raw_value",
    "status",
    "period_start",
    "period_end",
    "basis",
    "accessions",
    "tag",
    "currency",
    "reference_date",
)

FISCAL_QUARTER_COLUMNS: tuple[str, ...] = (
    "cik",
    "concept",
    "fiscal_year_start",
    "fiscal_year_end",
    "fiscal_quarter",
    "period_start",
    "period_end",
    "value_first",
    "available_at_first",
    "basis_first",
    "status_first",
    "accession_first",
    "prior_year_value_first",
    "prior_year_period_end_first",
    "reference_date_first",
    "value_latest",
    "available_at_latest",
    "currency",
)

FACTOR_NAMES: tuple[str, ...] = (
    "gross_margin_ttm",
    "operating_margin_ttm",
    "net_margin_ttm",
    "fcf_margin_ttm",
    "roe_ttm",
    "roa_ttm",
    "gross_profitability",
    "asset_growth_1y",
    "accruals_ttm",
    "debt_to_assets",
    "current_ratio",
)

_ALL_SUFFIXES = frozenset(
    {"q", "ttm", "fy", "i", "q_yoy", "ttm_yoy", "fy_yoy", "i_yoy"}
)


def _prev_year_date(d: date) -> date:
    try:
        return d.replace(year=d.year - 1)
    except ValueError:
        return d.replace(year=d.year - 1, day=28)


def _inclusive_days(start: date, end: date) -> int:
    return (end - start).days + 1


def _parse_iso_date(value: Any) -> date | None:
    if isinstance(value, date) and not isinstance(value, pd.Timestamp):
        return value
    if isinstance(value, pd.Timestamp):
        return None if pd.isna(value) else value.date()
    if not isinstance(value, str) or len(value) < 10:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def _valid_cik(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if (
        not stripped
        or not stripped.isascii()
        or not stripped.isdigit()
        or len(stripped) > 10
    ):
        return None
    padded = stripped.zfill(10)
    return padded if int(padded) > 0 else None


def _join_accessions(*parts: str) -> str:
    seen: list[str] = []
    for part in parts:
        if not part:
            continue
        for item in part.split(","):
            token = item.strip()
            if token and token not in seen:
                seen.append(token)
    return ",".join(seen)


def _format_decimal(value: Decimal) -> str:
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in {"", "-0"} else text


@dataclass(frozen=True)
class FactVersion:
    """Normalized observation version of one XBRL fact ready for state replay."""

    cik: str
    fact_id: str
    concept: str
    taxonomy: str
    tag: str
    tag_rank: int
    unit: str
    currency: str
    period_start: date | None
    period_end: date
    period_kind_hint: str
    form_base: str
    accession: str
    filed_date: date | None
    reference_date: date
    observation_sequence: int
    is_retracted: bool
    decimal_value: Decimal | None
    raw_value: str | None
    public_ns: int
    available_ns: int
    order_key: int


@dataclass(frozen=True)
class PeriodValue:
    """Evaluated value (or explicit error status) for one concept and period."""

    status: str  # "ok" | "approximate" | "ambiguous" | "invalid_value" | "period_unavailable"
    decimal_value: Decimal | None
    raw_value: str | None
    available_ns: int
    period_start: date | None
    period_end: date
    basis: str
    accessions: str
    tag: str
    currency: str
    reference_date: date

    @property
    def usable(self) -> bool:
        return self.status in {"ok", "approximate"} and self.decimal_value is not None

    @property
    def float_value(self) -> float:
        if not self.usable or self.decimal_value is None:
            return float("nan")
        number = float(self.decimal_value)
        return number if np.isfinite(number) else float("nan")


def _resolve_concept_and_rank(
    taxonomy: Any, tag: Any, metric: Any
) -> tuple[Concept, str, str, int] | None:
    tax_s = taxonomy.strip() if isinstance(taxonomy, str) else ""
    tag_s = tag.strip() if isinstance(tag, str) else ""
    if tax_s and tag_s:
        key = (tax_s, tag_s)
        concept = CONCEPT_TAGS.get(key)
        if concept is not None:
            return concept, tax_s, tag_s, TAG_RANKS[key]
    if not tax_s and tag_s:
        concept = BARE_TAG_TO_CONCEPT.get(tag_s)
        if concept is not None:
            matched_tax = next(t for t, name in concept.tags if name == tag_s)
            return concept, matched_tax, tag_s, TAG_RANKS[(matched_tax, tag_s)]
    metric_s = metric.strip() if isinstance(metric, str) else ""
    candidate = tag_s or metric_s
    if candidate in SYNTHETIC_METRIC_TO_CONCEPT and (not tax_s or tag_s == metric_s):
        concept_name = SYNTHETIC_METRIC_TO_CONCEPT[candidate]
        concept = CONCEPTS[concept_name]
        default_tax, default_tag = concept.tags[0]
        return concept, tax_s or default_tax, tag_s or default_tag, 0
    return None


def _normalize_unit(
    concept: Concept, unit_raw: Any, currency_raw: Any
) -> tuple[str, str] | None:
    unit = unit_raw.strip() if isinstance(unit_raw, str) else ""
    currency = currency_raw.strip().upper() if isinstance(currency_raw, str) else ""
    if concept.unit_kind == "shares":
        if unit == "shares":
            return "shares", ""
        return None
    if concept.unit_kind == "per_share":
        if unit.endswith("/shares"):
            prefix = unit[: -len("/shares")].upper()
            if len(prefix) == 3 and prefix.isalpha() and prefix.isascii():
                if currency and currency != prefix:
                    return None
                return f"{prefix}/shares", prefix
        if (
            len(unit) == 3
            and unit.isalpha()
            and unit.isascii()
            and (not currency or currency == unit.upper())
        ):
            ccy = unit.upper()
            return f"{ccy}/shares", ccy
        return None
    # unit_kind == "money"
    if len(unit) == 3 and unit.isalpha() and unit.isascii():
        ccy = unit.upper()
        if currency and currency != ccy:
            return None
        return ccy, ccy
    return None


def normalize_facts(
    facts: pd.DataFrame,
    *,
    time_policy: str,
    source_timezones: Mapping[str, str] | None = None,
    concepts: Collection[str] | None = None,
) -> tuple[list[FactVersion], dict[str, int]]:
    """Normalize raw ``fundamentals`` rows into clock-filtered ``FactVersion`` items."""
    clocks.policy(time_policy)
    stats = {
        "dropped_unknown_clock_versions": 0,
        "dropped_invalid_clock_versions": 0,
        "dropped_unmapped_tags": 0,
        "dropped_unit_mismatch": 0,
    }
    if facts is None or facts.empty:
        return [], stats

    allowed_concepts = None if concepts is None else set(concepts)
    work = facts
    if "source" not in work.columns:
        work = work.assign(source="sec")
    else:
        source_col = work["source"]
        if source_col.isna().any() or (source_col == "").any():
            work = work.copy()
            work["source"] = source_col.where(
                source_col.notna() & (source_col != ""), "sec"
            )

    zones = source_timezones or {}
    public_ns_arr, declared_invalid_arr = clocks.public_clocks(work, zones)
    observed_ns_arr = (
        clocks.instants(work["observed_at"].to_numpy(dtype=object))
        if "observed_at" in work.columns
        else np.full(len(work), clocks.NAT, dtype=np.int64)
    )
    available_ns_arr = clocks.available_at(
        public_ns_arr,
        declared_invalid_arr,
        time_policy,
        (observed_ns_arr,),
    )

    n_rows = len(work)
    cols = work.columns
    ciks = work["cik"].tolist() if "cik" in cols else [""] * n_rows
    fact_ids = work["fact_id"].tolist() if "fact_id" in cols else [""] * n_rows
    taxonomies = work["taxonomy"].tolist() if "taxonomy" in cols else [""] * n_rows
    tags = work["tag"].tolist() if "tag" in cols else [""] * n_rows
    metrics = work["metric"].tolist() if "metric" in cols else [""] * n_rows
    units = work["unit"].tolist() if "unit" in cols else [""] * n_rows
    currencies = work["currency"].tolist() if "currency" in cols else [""] * n_rows
    p_starts = (
        work["period_start"].tolist() if "period_start" in cols else [None] * n_rows
    )
    p_ends = work["period_end"].tolist() if "period_end" in cols else [None] * n_rows
    p_kinds = work["period_kind"].tolist() if "period_kind" in cols else [""] * n_rows
    forms = work["form"].tolist() if "form" in cols else [""] * n_rows
    accessions = work["accession"].tolist() if "accession" in cols else [""] * n_rows
    fileds = work["filed"].tolist() if "filed" in cols else [None] * n_rows
    pub_dates = (
        work["public_date"].tolist() if "public_date" in cols else [None] * n_rows
    )
    sequences = (
        work["observation_sequence"].tolist()
        if "observation_sequence" in cols
        else [1] * n_rows
    )
    retracted_list = (
        work["is_retracted"].tolist() if "is_retracted" in cols else [False] * n_rows
    )
    values = work["value"].tolist() if "value" in cols else [None] * n_rows

    chains: dict[tuple[str, str], list[FactVersion]] = {}
    for idx in range(n_rows):
        cik = _valid_cik(str(ciks[idx]) if ciks[idx] is not None else "")
        if cik is None:
            continue
        fact_id = str(fact_ids[idx]) if fact_ids[idx] is not None else ""
        if not fact_id:
            continue
        seq = sequences[idx]
        if (
            not isinstance(seq, (int, np.integer))
            or isinstance(seq, bool)
            or int(seq) < 0
        ):
            raise ValueError("Facts require a nonnegative observation_sequence")
        seq_int = int(seq)

        resolved = _resolve_concept_and_rank(taxonomies[idx], tags[idx], metrics[idx])
        if resolved is None:
            stats["dropped_unmapped_tags"] += 1
            continue
        concept, tax_s, tag_s, tag_rank = resolved
        if allowed_concepts is not None and concept.name not in allowed_concepts:
            continue

        retracted = (
            bool(retracted_list[idx]) if pd.notna(retracted_list[idx]) else False
        )
        unit_norm = _normalize_unit(concept, units[idx], currencies[idx])
        if unit_norm is None and not retracted:
            stats["dropped_unit_mismatch"] += 1
            continue
        unit_s, currency_s = unit_norm if unit_norm is not None else ("", "")

        p_end = _parse_iso_date(p_ends[idx])
        if p_end is None and not retracted:
            continue
        p_start: date | None = None
        if concept.kind == "duration":
            p_start = _parse_iso_date(p_starts[idx])
            if not retracted and (p_start is None or p_start > p_end):
                continue

        pub_ns = int(public_ns_arr[idx])
        avail_ns = int(available_ns_arr[idx])
        if bool(declared_invalid_arr[idx]):
            stats["dropped_invalid_clock_versions"] += 1
            continue
        if avail_ns == clocks.NAT:
            stats["dropped_unknown_clock_versions"] += 1
            continue

        raw_val = values[idx]
        dec_val: Decimal | None = None
        raw_str: str | None = None
        if not retracted:
            if isinstance(raw_val, str):
                raw_str = raw_val
                try:
                    parsed = Decimal(raw_val)
                    if parsed.is_finite():
                        dec_val = parsed
                except (InvalidOperation, ValueError):
                    dec_val = None
            elif isinstance(raw_val, (int, np.integer)) and not isinstance(
                raw_val, bool
            ):
                raw_str = str(int(raw_val))
                dec_val = Decimal(int(raw_val))

        form_raw = forms[idx].strip() if isinstance(forms[idx], str) else ""
        form_base = form_raw.removesuffix("/A")
        p_kind_hint = p_kinds[idx].strip() if isinstance(p_kinds[idx], str) else ""
        accession_s = (
            accessions[idx].strip() if isinstance(accessions[idx], str) else ""
        )

        filed_d = _parse_iso_date(fileds[idx]) or _parse_iso_date(pub_dates[idx])
        if filed_d is None and pub_ns != clocks.NAT:
            filed_d = (
                pd.Timestamp(pub_ns, unit="ns", tz="UTC")
                .tz_convert(clocks.NEW_YORK)
                .date()
            )
        effective_end = p_end if p_end is not None else date(1970, 1, 1)
        if concept.name != "shares_outstanding_cover" and concept.unit_kind in {
            "shares",
            "per_share",
        }:
            ref_date = filed_d if filed_d is not None else effective_end
        else:
            ref_date = effective_end

        order_key = pub_ns if pub_ns != clocks.NAT else avail_ns
        version = FactVersion(
            cik=cik,
            fact_id=fact_id,
            concept=concept.name,
            taxonomy=tax_s,
            tag=tag_s,
            tag_rank=tag_rank,
            unit=unit_s,
            currency=currency_s,
            period_start=p_start,
            period_end=effective_end,
            period_kind_hint=p_kind_hint,
            form_base=form_base,
            accession=accession_s,
            filed_date=filed_d,
            reference_date=ref_date,
            observation_sequence=seq_int,
            is_retracted=retracted,
            decimal_value=dec_val,
            raw_value=raw_str,
            public_ns=pub_ns,
            available_ns=avail_ns,
            order_key=order_key,
        )
        chains.setdefault((cik, fact_id), []).append(version)

    normalized: list[FactVersion] = []
    for versions in chains.values():
        versions.sort(key=lambda v: v.observation_sequence)
        if len({v.observation_sequence for v in versions}) != len(versions):
            raise ValueError("Duplicate observation_sequence for one fact")
        if time_policy == "public_reconstructed":
            seen_public: set[int] = set()
            for v in versions:
                if v.public_ns == clocks.NAT:
                    continue
                if v.public_ns not in seen_public:
                    seen_public.add(v.public_ns)
                    normalized.append(v)
        else:
            normalized.extend(versions)

    normalized.sort(key=lambda v: (v.cik, v.available_ns, v.observation_sequence))
    return normalized, stats


@dataclass(frozen=True)
class _FiscalYearSlots:
    start: date
    e1: date | None
    e2: date | None
    e3: date | None
    e4: date | None
    twelve_week_interims: bool = False


class IssuerStateMachine:
    """Pure-Python point-in-time state machine for one CIK."""

    def __init__(
        self,
        cik: str,
        *,
        target_views: Sequence[str] | None = None,
        record_quarters: Collection[str] = (),
    ) -> None:
        self.cik = cik
        if target_views is None:
            views_list: list[str] = []
            for name, spec in ALL_CONCEPTS.items():
                for suffix in views_for_concept(spec):
                    views_list.append(f"{name}_{suffix}")
            self.target_views = tuple(views_list)
        else:
            self.target_views = tuple(dict.fromkeys(target_views))

        self._parsed_views: list[tuple[str, str, str]] = [
            (v, *parse_view_name(v)) for v in self.target_views
        ]
        self.record_quarters: tuple[str, ...] = tuple(dict.fromkeys(record_quarters))
        self.current: dict[str, FactVersion] = {}
        self.by_period: dict[tuple[str, date | None, date], set[str]] = {}
        self.last_emitted: dict[str, tuple[Any, ...]] = {}
        self.rows: list[dict[str, Any]] = []
        self.annual_only_steps: list[tuple[int, bool]] = []
        self.quarter_ledger: dict[tuple[str, date], dict[str, Any]] = {}

    def ingest(self, versions: Sequence[FactVersion]) -> None:
        """Process all sorted ``FactVersion`` items for this issuer."""
        idx = 0
        total = len(versions)
        while idx < total:
            batch_clock = versions[idx].available_ns
            end_idx = idx + 1
            while end_idx < total and versions[end_idx].available_ns == batch_clock:
                end_idx += 1
            self._apply_batch(versions[idx:end_idx], batch_clock)
            idx = end_idx

    def _apply_batch(self, batch: Sequence[FactVersion], batch_clock: int) -> None:
        for version in batch:
            previous = self.current.get(version.fact_id)
            if previous is not None:
                old_key = (previous.concept, previous.period_start, previous.period_end)
                bucket = self.by_period.get(old_key)
                if bucket is not None:
                    bucket.discard(version.fact_id)
                    if not bucket:
                        del self.by_period[old_key]
            if version.is_retracted:
                self.current.pop(version.fact_id, None)
            else:
                self.current[version.fact_id] = version
                new_key = (version.concept, version.period_start, version.period_end)
                self.by_period.setdefault(new_key, set()).add(version.fact_id)

        self._refresh_views(batch_clock)

    def _evaluate_base(
        self, concept_name: str, start: date | None, end: date
    ) -> PeriodValue | None:
        fact_ids = self.by_period.get((concept_name, start, end))
        if not fact_ids:
            return None
        active = [self.current[fid] for fid in fact_ids]
        max_order = max(v.order_key for v in active)
        at_order = [v for v in active if v.order_key == max_order]
        best_rank = min(v.tag_rank for v in at_order)
        candidates = [v for v in at_order if v.tag_rank == best_rank]

        # Prefer USD when dual-currency convenience facts share the same tag and clock.
        currencies = {v.currency for v in candidates}
        if len(currencies) > 1:
            chosen_ccy = "USD" if "USD" in currencies else min(currencies)
            candidates = [v for v in candidates if v.currency == chosen_ccy]

        avail_ns = max(v.available_ns for v in candidates)
        first = min(candidates, key=lambda v: v.fact_id)
        accessions = _join_accessions(*(v.accession for v in candidates))
        if any(v.decimal_value is None for v in candidates):
            return PeriodValue(
                status="invalid_value",
                decimal_value=None,
                raw_value=first.raw_value,
                available_ns=avail_ns,
                period_start=start,
                period_end=end,
                basis="reported",
                accessions=accessions,
                tag=first.tag,
                currency=first.currency,
                reference_date=first.reference_date,
            )
        distinct_values = {v.decimal_value for v in candidates}
        if len(distinct_values) > 1:
            return PeriodValue(
                status="ambiguous",
                decimal_value=None,
                raw_value=None,
                available_ns=avail_ns,
                period_start=start,
                period_end=end,
                basis="reported",
                accessions=accessions,
                tag=first.tag,
                currency=first.currency,
                reference_date=first.reference_date,
            )
        return PeriodValue(
            status="ok",
            decimal_value=first.decimal_value,
            raw_value=first.raw_value,
            available_ns=avail_ns,
            period_start=start,
            period_end=end,
            basis="reported",
            accessions=accessions,
            tag=first.tag,
            currency=first.currency,
            reference_date=first.reference_date,
        )

    def _has_nonzero_nci(self) -> bool:
        for concept_name, start, end in list(self.by_period):
            if concept_name not in {"net_income_nci", "minority_interest"}:
                continue
            pv = self._evaluate_base(concept_name, start, end)
            if pv is not None and pv.usable and pv.decimal_value != 0:
                return True
        return False

    def _evaluate_composite_period(
        self,
        name: str,
        start: date | None,
        end: date,
        base_cache: Mapping[tuple[str, date | None, date], PeriodValue],
        has_nci: bool,
    ) -> PeriodValue | None:
        def get(c: str) -> PeriodValue | None:
            return base_cache.get((c, start, end))

        def relabel(pv: PeriodValue, basis: str) -> PeriodValue:
            return PeriodValue(
                status=pv.status,
                decimal_value=pv.decimal_value,
                raw_value=pv.raw_value,
                available_ns=pv.available_ns,
                period_start=pv.period_start,
                period_end=pv.period_end,
                basis=basis,
                accessions=pv.accessions,
                tag=pv.tag,
                currency=pv.currency,
                reference_date=pv.reference_date,
            )

        def combine_add(
            a: PeriodValue, b: PeriodValue, sign: int, basis: str
        ) -> PeriodValue | None:
            if not a.usable:
                return relabel(a, basis)
            if not b.usable:
                return relabel(b, basis)
            if a.currency != b.currency:
                return None
            assert a.decimal_value is not None and b.decimal_value is not None
            val = a.decimal_value + (b.decimal_value * sign)
            status = "approximate" if "approximate" in {a.status, b.status} else "ok"
            return PeriodValue(
                status=status,
                decimal_value=val,
                raw_value=_format_decimal(val),
                available_ns=max(a.available_ns, b.available_ns),
                period_start=start,
                period_end=end,
                basis=basis,
                accessions=_join_accessions(a.accessions, b.accessions),
                tag=a.tag,
                currency=a.currency,
                reference_date=max(a.reference_date, b.reference_date),
            )

        if name == "revenue":
            tot = get("revenue_total")
            if tot is not None:
                return relabel(tot, "total")
            con = get("revenue_contracts")
            if con is not None:
                return relabel(con, "contracts")
            return None

        if name == "net_income":
            par = get("net_income_parent")
            if par is not None:
                return relabel(par, "parent")
            if not has_nci:
                tot = get("net_income_total")
                if tot is not None:
                    return relabel(tot, "total_no_nci")
            return None

        if name == "equity":
            par = get("equity_parent")
            if par is not None:
                return relabel(par, "parent")
            if not has_nci:
                tot = get("equity_total")
                if tot is not None:
                    return relabel(tot, "total_no_nci")
            return None

        if name == "shares_outstanding":
            cov = get("shares_outstanding_cover")
            if cov is not None:
                return relabel(cov, "cover")
            bs = get("shares_outstanding_bs")
            if bs is not None:
                return relabel(bs, "balance_sheet")
            return None

        if name == "fcf":
            ocf = get("operating_cash_flow")
            capex = get("capex")
            if ocf is not None and capex is not None:
                return combine_add(ocf, capex, -1, "ocf_minus_capex")
            return None

        if name == "ebitda":
            oi = get("operating_income")
            da = get("d_and_a")
            if oi is not None and da is not None:
                return combine_add(oi, da, 1, "oi_plus_da")
            return None

        if name == "total_debt":
            dc = get("debt_current")
            ltd_nc = get("long_term_debt_noncurrent")
            ltd = get("long_term_debt")
            stb = get("short_term_borrowings")
            ltd_c = get("long_term_debt_current")
            if dc is not None and ltd_nc is not None:
                return combine_add(dc, ltd_nc, 1, "dc_ltdnc")
            if ltd is not None and stb is not None:
                return combine_add(ltd, stb, 1, "ltd_stb")
            if ltd_c is not None and ltd_nc is not None:
                pair = combine_add(ltd_c, ltd_nc, 1, "ltdc_ltdnc")
                if pair is not None and stb is not None and pair.usable:
                    return combine_add(pair, stb, 1, "ltdc_ltdnc")
                return pair
            if ltd is not None and dc is None and ltd_c is None and ltd_nc is None:
                return relabel(ltd, "ltd_stb")
            if ltd_nc is not None and dc is None and ltd_c is None and ltd is None:
                if stb is not None:
                    return combine_add(ltd_nc, stb, 1, "dc_ltdnc")
                return relabel(ltd_nc, "dc_ltdnc")
            if dc is not None and ltd_nc is None and ltd is None and ltd_c is None:
                return relabel(dc, "dc_ltdnc")
            return None

        return None

    def _is_annual_period_fact(self, v: FactVersion) -> bool:
        if v.period_start is None:
            return False
        days = _inclusive_days(v.period_start, v.period_end)
        if not (350 <= days <= 380):
            return False
        if v.form_base:
            return v.form_base in PERIODIC_ANNUAL_FORMS
        return v.period_kind_hint != "quarter"

    def _build_fiscal_calendar(
        self,
    ) -> tuple[list[_FiscalYearSlots], set[tuple[date, date]]]:
        duration_periods: set[tuple[date, date]] = set()
        fy_periods: set[tuple[date, date]] = set()
        ytd_starts: set[date] = set()
        q3m_periods: list[tuple[date, date]] = []
        interim_lengths: dict[date, set[int]] = {}

        for v in self.current.values():
            if v.period_start is None:
                continue
            pair = (v.period_start, v.period_end)
            duration_periods.add(pair)
            days = _inclusive_days(v.period_start, v.period_end)
            if (
                days in {84, 168, 252}
                and v.form_base == "10-Q"
                and v.decimal_value is not None
            ):
                interim_lengths.setdefault(v.period_start, set()).add(days)
            if self._is_annual_period_fact(v):
                fy_periods.add(pair)
            elif 168 <= days <= 196 or 259 <= days <= 287:
                if (
                    not v.form_base
                    or v.form_base in PERIODIC_QUARTER_FORMS
                    or v.form_base in PERIODIC_ANNUAL_FORMS
                ):
                    ytd_starts.add(v.period_start)
            elif 77 <= days <= 105:
                q3m_periods.append(pair)

        # Candidate FY starts: (start, priority) where 0=FY, 1=YTD 6M/9M, 2=prior FY end + 1d
        raw_starts: list[tuple[date, int]] = []
        for s, e in fy_periods:
            raw_starts.append((s, 0))
            raw_starts.append((e + timedelta(days=1), 2))
        for s in ytd_starts:
            raw_starts.append((s, 1))

        raw_starts.sort(key=lambda item: (item[0], item[1]))
        clusters: list[list[tuple[date, int]]] = []
        for s, prio in raw_starts:
            if clusters and (s - clusters[-1][0][0]).days <= 3:
                clusters[-1].append((s, prio))
            else:
                clusters.append([(s, prio)])

        fy_starts = [
            min(cluster, key=lambda item: (item[1], item[0]))[0] for cluster in clusters
        ]

        # Add standalone 3M starts only if not covered by an existing fiscal year window.
        # When an earlier comparative 3M period precedes an established FY start, infer
        # the prior fiscal year start by stepping back whole years first.
        for qs, qe in sorted(set(q3m_periods)):
            if any(-3 <= (qs - s).days <= 349 for s in fy_starts):
                continue
            inferred: date | None = None
            for anchor in fy_starts:
                if anchor <= qs:
                    continue
                cand = anchor
                while (cand - qs).days > 3:
                    cand = _prev_year_date(cand)
                if -3 <= (qs - cand).days <= 349 and qe < anchor:
                    inferred = cand
                    break
            fy_starts.append(inferred if inferred is not None else qs)
            fy_starts.sort()

        slots_list: list[_FiscalYearSlots] = []
        for idx, s in enumerate(fy_starts):
            next_s = fy_starts[idx + 1] if idx + 1 < len(fy_starts) else None
            e1 = e2 = e3 = e4 = None
            for ps, pe in sorted(duration_periods):
                if abs((ps - s).days) > 3:
                    continue
                days = _inclusive_days(ps, pe)
                if 77 <= days <= 105:
                    e1 = pe if e1 is None or pe > e1 else e1
                elif 168 <= days <= 196:
                    e2 = pe if e2 is None or pe > e2 else e2
                elif 259 <= days <= 287:
                    e3 = pe if e3 is None or pe > e3 else e3
                elif 350 <= days <= 380 and (ps, pe) in fy_periods:
                    e4 = pe if e4 is None or pe > e4 else e4

            for qs, qe in sorted(set(q3m_periods)):
                if next_s is not None and qe >= next_s:
                    continue
                offset = (qs - s).days
                if e1 is None and -3 <= offset <= 15:
                    e1 = qe
                elif e2 is None and (
                    (e1 is not None and abs((qs - (e1 + timedelta(days=1))).days) <= 3)
                    or (74 <= offset <= 108)
                ):
                    e2 = qe
                elif e3 is None and (
                    (e2 is not None and abs((qs - (e2 + timedelta(days=1))).days) <= 3)
                    or (165 <= offset <= 199)
                ):
                    e3 = qe
                elif e4 is None and (
                    (e3 is not None and abs((qs - (e3 + timedelta(days=1))).days) <= 3)
                    or (256 <= offset <= 290)
                ):
                    e4 = qe

            # Require all three same-start interims and preserve conflicting fiscal slots.
            twelve_week_interims = (
                (e3 is None or _inclusive_days(s, e3) == 252)
                and {84, 168, 252}.issubset(interim_lengths.get(s, ()))
                and (e4 is None or _inclusive_days(s, e4) in {364, 371})
            )
            slots_list.append(_FiscalYearSlots(s, e1, e2, e3, e4, twelve_week_interims))

        return slots_list, fy_periods

    def _derive_quarters_for_concept(
        self,
        spec: Concept | CompositeSpec,
        slots_list: Sequence[_FiscalYearSlots],
        fy_periods: set[tuple[date, date]],
        period_map: Mapping[tuple[date | None, date], PeriodValue],
    ) -> dict[tuple[date, int], PeriodValue]:
        """Return ``(fy_start, quarter_num) -> PeriodValue`` for 1..4."""
        result: dict[tuple[date, int], PeriodValue] = {}
        if not period_map:
            return result

        # Index duration periods for this concept.
        dur_entries: list[tuple[date, date, int, PeriodValue]] = []
        for (ps, pe), pv in period_map.items():
            if ps is not None:
                dur_entries.append((ps, pe, _inclusive_days(ps, pe), pv))
        dur_entries.sort(key=lambda item: (item[1], item[0]))

        def pick_direct_3m(
            expected_start: date | None,
            fy_start: date,
            slot_range: tuple[int, int],
            expected_end: date | None,
            upper_end: date | None,
        ) -> PeriodValue | None:
            matches: list[PeriodValue] = []
            for ps, pe, days, pv in dur_entries:
                if not (77 <= days <= 105):
                    continue
                if upper_end is not None and pe >= upper_end:
                    continue
                if (
                    expected_end is not None
                    and abs((pe - expected_end).days) <= 3
                    and expected_start is not None
                    and abs((ps - expected_start).days) <= 5
                ):
                    matches.append(pv)
                    continue
                if expected_start is not None and abs((ps - expected_start).days) <= 3:
                    matches.append(pv)
                    continue
                offset = (ps - fy_start).days
                if slot_range[0] <= offset <= slot_range[1]:
                    matches.append(pv)
            return matches[-1] if matches else None

        def pick_ytd(
            fy_start: date, min_days: int, max_days: int, require_fy: bool = False
        ) -> PeriodValue | None:
            matches: list[PeriodValue] = []
            for ps, pe, days, pv in dur_entries:
                if abs((ps - fy_start).days) > 3:
                    continue
                if not (min_days <= days <= max_days):
                    continue
                if require_fy and (ps, pe) not in fy_periods:
                    continue
                matches.append(pv)
            return matches[-1] if matches else None

        def subtract_ytd(
            cur_ytd: PeriodValue,
            prev_ytd: PeriodValue,
            basis: str,
            approx: bool = False,
            long_q4: bool = False,
        ) -> PeriodValue | None:
            assert (
                cur_ytd.period_start is not None and prev_ytd.period_start is not None
            )
            if abs((cur_ytd.period_start - prev_ytd.period_start).days) > 3:
                return None
            d_start = prev_ytd.period_end + timedelta(days=1)
            d_end = cur_ytd.period_end
            days = _inclusive_days(d_start, d_end)
            if not (77 <= days <= 105 or (long_q4 and days in {112, 119})):
                return None
            if not cur_ytd.usable:
                return PeriodValue(
                    status=cur_ytd.status,
                    decimal_value=None,
                    raw_value=None,
                    available_ns=cur_ytd.available_ns,
                    period_start=d_start,
                    period_end=d_end,
                    basis=basis,
                    accessions=cur_ytd.accessions,
                    tag=cur_ytd.tag,
                    currency=cur_ytd.currency,
                    reference_date=cur_ytd.reference_date,
                )
            if not prev_ytd.usable:
                return PeriodValue(
                    status=prev_ytd.status,
                    decimal_value=None,
                    raw_value=None,
                    available_ns=prev_ytd.available_ns,
                    period_start=d_start,
                    period_end=d_end,
                    basis=basis,
                    accessions=prev_ytd.accessions,
                    tag=prev_ytd.tag,
                    currency=prev_ytd.currency,
                    reference_date=prev_ytd.reference_date,
                )
            if cur_ytd.currency != prev_ytd.currency:
                return None
            assert (
                cur_ytd.decimal_value is not None and prev_ytd.decimal_value is not None
            )
            val = cur_ytd.decimal_value - prev_ytd.decimal_value
            status = (
                "approximate"
                if approx or "approximate" in {cur_ytd.status, prev_ytd.status}
                else "ok"
            )
            return PeriodValue(
                status=status,
                decimal_value=val,
                raw_value=_format_decimal(val),
                available_ns=max(cur_ytd.available_ns, prev_ytd.available_ns),
                period_start=d_start,
                period_end=d_end,
                basis=basis,
                accessions=_join_accessions(cur_ytd.accessions, prev_ytd.accessions),
                tag=cur_ytd.tag,
                currency=cur_ytd.currency,
                reference_date=max(cur_ytd.reference_date, prev_ytd.reference_date),
            )

        is_eps = spec.name in {"eps_diluted", "eps_basic"}

        for idx, slots in enumerate(slots_list):
            s = slots.start
            upper_end = slots_list[idx + 1].start if idx + 1 < len(slots_list) else None

            q1 = pick_direct_3m(s, s, (-3, 15), slots.e1, upper_end)
            if q1 is not None:
                result[(s, 1)] = q1

            e1_ref = q1.period_end if q1 is not None else slots.e1
            q2 = pick_direct_3m(
                e1_ref + timedelta(days=1) if e1_ref is not None else None,
                s,
                (74, 108),
                slots.e2,
                upper_end,
            )
            if q2 is None and spec.additive:
                ytd6 = pick_ytd(s, 168, 196)
                ytd3 = pick_ytd(s, 77, 105)
                if ytd6 is not None and ytd3 is not None:
                    q2 = subtract_ytd(ytd6, ytd3, "ytd_difference")
            if q2 is not None:
                result[(s, 2)] = q2

            e2_ref = q2.period_end if q2 is not None else slots.e2
            q3 = pick_direct_3m(
                e2_ref + timedelta(days=1) if e2_ref is not None else None,
                s,
                (165, 199),
                slots.e3,
                upper_end,
            )
            if q3 is None and spec.additive:
                ytd9 = pick_ytd(s, 259, 287)
                ytd6 = pick_ytd(s, 168, 196)
                if ytd9 is not None and ytd6 is not None:
                    q3 = subtract_ytd(ytd9, ytd6, "ytd_difference")

            e3_ref = q3.period_end if q3 is not None else slots.e3
            q4 = pick_direct_3m(
                e3_ref + timedelta(days=1) if e3_ref is not None else None,
                s,
                (256, 290),
                slots.e4,
                upper_end,
            )
            if q4 is None and (spec.additive or is_eps):
                fy_pv = pick_ytd(s, 350, 380, require_fy=True)
                ytd9 = pick_ytd(s, 259, 287)
                if fy_pv is not None and ytd9 is not None:
                    q4 = subtract_ytd(
                        fy_pv,
                        ytd9,
                        "fy_minus_ytd_approx" if is_eps else "fy_minus_ytd",
                        approx=is_eps,
                    )
                elif (
                    is_eps
                    and fy_pv is not None
                    and q1 is not None
                    and q2 is not None
                    and q3 is not None
                    and q1.usable
                    and q2.usable
                    and q3.usable
                    and fy_pv.usable
                    and len({q1.currency, q2.currency, q3.currency, fy_pv.currency})
                    == 1
                ):
                    d_start = q3.period_end + timedelta(days=1)
                    d_end = fy_pv.period_end
                    if 77 <= _inclusive_days(d_start, d_end) <= 105:
                        assert (
                            fy_pv.decimal_value is not None
                            and q1.decimal_value is not None
                            and q2.decimal_value is not None
                            and q3.decimal_value is not None
                        )
                        val = fy_pv.decimal_value - (
                            q1.decimal_value + q2.decimal_value + q3.decimal_value
                        )
                        q4 = PeriodValue(
                            status="approximate",
                            decimal_value=val,
                            raw_value=_format_decimal(val),
                            available_ns=max(
                                fy_pv.available_ns,
                                q1.available_ns,
                                q2.available_ns,
                                q3.available_ns,
                            ),
                            period_start=d_start,
                            period_end=d_end,
                            basis="fy_minus_ytd_approx",
                            accessions=_join_accessions(
                                fy_pv.accessions,
                                q1.accessions,
                                q2.accessions,
                                q3.accessions,
                            ),
                            tag=fy_pv.tag,
                            currency=fy_pv.currency,
                            reference_date=max(
                                fy_pv.reference_date,
                                q1.reference_date,
                                q2.reference_date,
                                q3.reference_date,
                            ),
                        )
            # Preserve the existing concept-specific choices, including Q4's original Q3
            # reference. Use the inferred weekly calendar only for missing usable quarters.
            if spec.additive and slots.twelve_week_interims:
                ytd36 = period_map.get((s, s + timedelta(days=251)))
                if ytd36 is not None:
                    if q3 is None or not q3.usable:
                        ytd24 = period_map.get((s, s + timedelta(days=167)))
                        if ytd24 is not None:
                            weekly_q3 = subtract_ytd(ytd36, ytd24, "ytd_difference")
                            if weekly_q3 is not None and weekly_q3.usable:
                                q3 = weekly_q3
                    if q4 is None or not q4.usable:
                        fy_pv = pick_ytd(s, 350, 380, require_fy=True)
                        if (
                            fy_pv is not None
                            and fy_pv.period_start == s
                            and _inclusive_days(s, fy_pv.period_end) in {364, 371}
                        ):
                            weekly_q4 = subtract_ytd(
                                fy_pv, ytd36, "fy_minus_ytd", long_q4=True
                            )
                            if weekly_q4 is not None and weekly_q4.usable:
                                q4 = weekly_q4
            if q3 is not None:
                result[(s, 3)] = q3
            if q4 is not None:
                result[(s, 4)] = q4

        return result

    def _derive_ttm_for_concept(
        self,
        spec: Concept | CompositeSpec,
        fy_periods: set[tuple[date, date]],
        period_map: Mapping[tuple[date | None, date], PeriodValue],
        quarters_map: Mapping[tuple[date, int], PeriodValue],
    ) -> dict[date, PeriodValue]:
        """Return ``period_end -> PeriodValue`` for trailing 12-month series."""
        result: dict[date, PeriodValue] = {}
        if not period_map and not quarters_map:
            return result

        is_eps = spec.name in {"eps_diluted", "eps_basic"}

        fy_by_end: dict[date, PeriodValue] = {}
        for ps, pe in sorted(fy_periods):
            pv = period_map.get((ps, pe))
            if pv is not None:
                prev = fy_by_end.get(pe)
                if prev is None or (pv.period_start or date.min) >= (
                    prev.period_start or date.min
                ):
                    fy_by_end[pe] = pv

        usable_quarters_by_end: dict[date, PeriodValue] = {}
        for (ps, pe), pv in period_map.items():
            if ps is not None and 77 <= _inclusive_days(ps, pe) <= 105 and pv.usable:
                usable_quarters_by_end[pe] = pv
        for pv in quarters_map.values():
            if pv.usable:
                usable_quarters_by_end[pv.period_end] = pv
        q_list = [usable_quarters_by_end[k] for k in sorted(usable_quarters_by_end)]

        candidate_ends: set[date] = set(fy_by_end) | {
            pv.period_end for pv in quarters_map.values()
        }
        if spec.additive:
            for ps, pe in period_map:
                if ps is not None and 77 <= _inclusive_days(ps, pe) <= 290:
                    candidate_ends.add(pe)

        for e in sorted(candidate_ends):
            # 1. Fiscal year end -> reported/composite FY directly.
            fy_pv = fy_by_end.get(e)
            if fy_pv is not None and fy_pv.usable:
                result[e] = PeriodValue(
                    status=fy_pv.status,
                    decimal_value=fy_pv.decimal_value,
                    raw_value=fy_pv.raw_value,
                    available_ns=fy_pv.available_ns,
                    period_start=fy_pv.period_start,
                    period_end=fy_pv.period_end,
                    basis="fiscal_year",
                    accessions=fy_pv.accessions,
                    tag=fy_pv.tag,
                    currency=fy_pv.currency,
                    reference_date=fy_pv.reference_date,
                )
                continue

            # 2. YTD bridge: FY_prev + YTD_cur(S, e) - YTD_prev(S_prev, e - 1y +-7d).
            if spec.additive:
                ytd_cur_list = [
                    pv
                    for (ps, pe), pv in period_map.items()
                    if pe == e
                    and ps is not None
                    and pv.usable
                    and 77 <= _inclusive_days(ps, pe) <= 290
                ]
                ytd_cur_list.sort(
                    key=lambda pv: _inclusive_days(pv.period_start or e, pv.period_end),
                    reverse=True,
                )
                bridged: PeriodValue | None = None
                for ytd_cur in ytd_cur_list:
                    assert ytd_cur.period_start is not None
                    s_cur = ytd_cur.period_start
                    len_cur = _inclusive_days(s_cur, e)
                    fy_prev_cands = [
                        fpv
                        for fpv in fy_by_end.values()
                        if fpv.usable
                        and fpv.period_start is not None
                        and fpv.currency == ytd_cur.currency
                        and abs((s_cur - (fpv.period_end + timedelta(days=1))).days)
                        <= 5
                    ]
                    if not fy_prev_cands:
                        continue
                    fy_prev = max(fy_prev_cands, key=lambda fpv: fpv.period_end)
                    assert fy_prev.period_start is not None
                    s_prev_fy = fy_prev.period_start
                    exp_prev_end = _prev_year_date(e)
                    ytd_prev_cands = [
                        ppv
                        for (pps, ppe), ppv in period_map.items()
                        if pps is not None
                        and ppv.usable
                        and ppv.currency == ytd_cur.currency
                        and abs((pps - s_prev_fy).days) <= 3
                        and abs((ppe - exp_prev_end).days) <= 7
                        and abs(_inclusive_days(pps, ppe) - len_cur) <= 7
                    ]
                    if not ytd_prev_cands:
                        continue
                    ytd_prev = min(
                        ytd_prev_cands,
                        key=lambda ppv: abs((ppv.period_end - exp_prev_end).days),
                    )
                    ttm_start = ytd_prev.period_end + timedelta(days=1)
                    if not (350 <= _inclusive_days(ttm_start, e) <= 380):
                        continue
                    assert (
                        fy_prev.decimal_value is not None
                        and ytd_cur.decimal_value is not None
                        and ytd_prev.decimal_value is not None
                    )
                    val = (
                        fy_prev.decimal_value
                        + ytd_cur.decimal_value
                        - ytd_prev.decimal_value
                    )
                    st = (
                        "approximate"
                        if "approximate"
                        in {fy_prev.status, ytd_cur.status, ytd_prev.status}
                        else "ok"
                    )
                    bridged = PeriodValue(
                        status=st,
                        decimal_value=val,
                        raw_value=_format_decimal(val),
                        available_ns=max(
                            fy_prev.available_ns,
                            ytd_cur.available_ns,
                            ytd_prev.available_ns,
                        ),
                        period_start=ttm_start,
                        period_end=e,
                        basis="ytd_bridge",
                        accessions=_join_accessions(
                            fy_prev.accessions,
                            ytd_cur.accessions,
                            ytd_prev.accessions,
                        ),
                        tag=ytd_cur.tag,
                        currency=ytd_cur.currency,
                        reference_date=max(
                            fy_prev.reference_date,
                            ytd_cur.reference_date,
                            ytd_prev.reference_date,
                        ),
                    )
                    break
                if bridged is not None:
                    result[e] = bridged
                    continue

            # 3. Sum of 4 contiguous quarters spanning 350..380 days.
            q4 = usable_quarters_by_end.get(e)
            if q4 is not None and q4.period_start is not None:

                def _prev_quarter(cur_q: PeriodValue) -> PeriodValue | None:
                    assert cur_q.period_start is not None
                    matches = [
                        cand
                        for cand in q_list
                        if cand.currency == cur_q.currency
                        and cand.period_end < cur_q.period_end
                        and abs(
                            (
                                cur_q.period_start
                                - (cand.period_end + timedelta(days=1))
                            ).days
                        )
                        <= 5
                    ]
                    return matches[-1] if matches else None

                q3 = _prev_quarter(q4)
                q2 = (
                    _prev_quarter(q3)
                    if q3 is not None and q3.period_start is not None
                    else None
                )
                q1 = (
                    _prev_quarter(q2)
                    if q2 is not None and q2.period_start is not None
                    else None
                )
                if (
                    q1 is not None
                    and q2 is not None
                    and q3 is not None
                    and q1.period_start is not None
                    and 350 <= _inclusive_days(q1.period_start, q4.period_end) <= 380
                ):
                    assert (
                        q1.decimal_value is not None
                        and q2.decimal_value is not None
                        and q3.decimal_value is not None
                        and q4.decimal_value is not None
                    )
                    val = (
                        q1.decimal_value
                        + q2.decimal_value
                        + q3.decimal_value
                        + q4.decimal_value
                    )
                    st = (
                        "approximate"
                        if (
                            is_eps
                            or any(q.status == "approximate" for q in (q1, q2, q3, q4))
                        )
                        else "ok"
                    )
                    result[e] = PeriodValue(
                        status=st,
                        decimal_value=val,
                        raw_value=_format_decimal(val),
                        available_ns=max(
                            q1.available_ns,
                            q2.available_ns,
                            q3.available_ns,
                            q4.available_ns,
                        ),
                        period_start=q1.period_start,
                        period_end=q4.period_end,
                        basis="quarter_sum",
                        accessions=_join_accessions(
                            q1.accessions,
                            q2.accessions,
                            q3.accessions,
                            q4.accessions,
                        ),
                        tag=q4.tag,
                        currency=q4.currency,
                        reference_date=max(
                            q1.reference_date,
                            q2.reference_date,
                            q3.reference_date,
                            q4.reference_date,
                        ),
                    )
                    continue

            if fy_pv is not None:
                result[e] = PeriodValue(
                    status=fy_pv.status,
                    decimal_value=None,
                    raw_value=None,
                    available_ns=fy_pv.available_ns,
                    period_start=fy_pv.period_start,
                    period_end=fy_pv.period_end,
                    basis="fiscal_year",
                    accessions=fy_pv.accessions,
                    tag=fy_pv.tag,
                    currency=fy_pv.currency,
                    reference_date=fy_pv.reference_date,
                )

        return result

    def _update_quarter_ledger(
        self,
        batch_clock: int,
        slots_list: Sequence[_FiscalYearSlots],
        concept_periods: Mapping[str, Mapping[tuple[date | None, date], PeriodValue]],
        quarters_by_concept: Mapping[str, Mapping[tuple[date, int], PeriodValue]],
    ) -> None:
        if not self.record_quarters:
            return
        slots_by_start = {s.start: s for s in slots_list}
        for c_name in self.record_quarters:
            q_map = quarters_by_concept.get(c_name, {})
            if not q_map:
                continue
            p_map = concept_periods.get(c_name, {})
            prior_pool_by_key: dict[tuple[date | None, date], PeriodValue] = {}
            for (ps, pe), pv in p_map.items():
                if (
                    ps is not None
                    and 77 <= _inclusive_days(ps, pe) <= 105
                    and pv.usable
                ):
                    prior_pool_by_key[(ps, pe)] = pv
            for pv in q_map.values():
                if pv.usable:
                    prior_pool_by_key[(pv.period_start, pv.period_end)] = pv
            prior_pool = list(prior_pool_by_key.values())

            for (fy_start, q_num), pv in sorted(q_map.items()):
                if not pv.usable or pv.period_start is None:
                    continue
                num = pv.float_value
                if not np.isfinite(num):
                    continue
                slots = slots_by_start.get(fy_start)
                fy_end = slots.e4 if slots is not None else None
                ledger_key = (c_name, pv.period_end)
                existing = self.quarter_ledger.get(ledger_key)
                if existing is None:
                    exp_end = _prev_year_date(pv.period_end)
                    cur_days = _inclusive_days(pv.period_start, pv.period_end)
                    matches = [
                        cand
                        for cand in prior_pool
                        if cand.period_start is not None
                        and cand.currency == pv.currency
                        and cand.period_end < pv.period_end
                        and abs((cand.period_end - exp_end).days) <= 7
                        and abs(
                            _inclusive_days(cand.period_start, cand.period_end)
                            - cur_days
                        )
                        <= 7
                    ]
                    prior_val = float("nan")
                    prior_end: date | None = None
                    if matches:
                        best_prior = min(
                            matches,
                            key=lambda cand: (
                                abs((cand.period_end - exp_end).days),
                                -cand.period_end.toordinal(),
                            ),
                        )
                        prior_val = best_prior.float_value
                        prior_end = best_prior.period_end
                    first_acc = (
                        pv.accessions.split(",")[0].strip() if pv.accessions else ""
                    )
                    self.quarter_ledger[ledger_key] = {
                        "cik": self.cik,
                        "concept": c_name,
                        "fiscal_year_start": fy_start,
                        "fiscal_year_end": fy_end,
                        "fiscal_quarter": q_num,
                        "period_start": pv.period_start,
                        "period_end": pv.period_end,
                        "value_first": num,
                        "decimal_latest": pv.decimal_value,
                        "available_at_first": batch_clock,
                        "basis_first": pv.basis,
                        "status_first": pv.status,
                        "accession_first": first_acc,
                        "prior_year_value_first": prior_val,
                        "prior_year_period_end_first": prior_end,
                        "reference_date_first": pv.reference_date,
                        "value_latest": num,
                        "available_at_latest": batch_clock,
                        "currency": pv.currency,
                    }
                else:
                    existing["fiscal_year_start"] = fy_start
                    existing["fiscal_quarter"] = q_num
                    if fy_end is not None:
                        existing["fiscal_year_end"] = fy_end
                    if pv.decimal_value != existing["decimal_latest"]:
                        existing["decimal_latest"] = pv.decimal_value
                        existing["value_latest"] = num
                        existing["available_at_latest"] = batch_clock

    def _is_currently_annual_only(self) -> bool:
        has_annual = False
        for v in self.current.values():
            if v.form_base in PERIODIC_QUARTER_FORMS:
                return False
            if v.period_start is not None:
                days = _inclusive_days(v.period_start, v.period_end)
                if days < 350:
                    return False
                if self._is_annual_period_fact(v):
                    has_annual = True
        return has_annual

    def _refresh_views(self, batch_clock: int) -> None:
        has_nci = self._has_nonzero_nci()
        is_annual_only = self._is_currently_annual_only()
        if (
            not self.annual_only_steps
            or self.annual_only_steps[-1][1] != is_annual_only
        ):
            self.annual_only_steps.append((batch_clock, is_annual_only))

        base_cache: dict[tuple[str, date | None, date], PeriodValue] = {}
        concept_periods: dict[str, dict[tuple[date | None, date], PeriodValue]] = {}
        for c_name, start, end in list(self.by_period):
            pv = self._evaluate_base(c_name, start, end)
            if pv is not None:
                base_cache[(c_name, start, end)] = pv
                concept_periods.setdefault(c_name, {})[(start, end)] = pv

        # Candidate period keys per composite.
        all_duration_keys = {(ps, pe) for (_, ps, pe) in base_cache if ps is not None}
        all_instant_keys = {(None, pe) for (_, ps, pe) in base_cache if ps is None}
        for comp_name, comp_spec in COMPOSITES.items():
            keys = (
                all_instant_keys if comp_spec.kind == "instant" else all_duration_keys
            )
            comp_map: dict[tuple[date | None, date], PeriodValue] = {}
            for ps, pe in keys:
                pv = self._evaluate_composite_period(
                    comp_name, ps, pe, base_cache, has_nci
                )
                if pv is not None:
                    comp_map[(ps, pe)] = pv
            if comp_map:
                concept_periods[comp_name] = comp_map

        slots_list, fy_periods = self._build_fiscal_calendar()

        needed_ttm = {
            c_name
            for _, c_name, suffix in self._parsed_views
            if suffix in {"ttm", "ttm_yoy"}
        }
        if "fcf" in needed_ttm:
            needed_ttm.update({"operating_cash_flow", "capex"})
        if "ebitda" in needed_ttm:
            needed_ttm.update({"operating_income", "d_and_a"})

        needed_quarters = (
            {
                c_name
                for _, c_name, suffix in self._parsed_views
                if suffix in {"q", "q_yoy", "ttm", "ttm_yoy"}
            }
            | set(self.record_quarters)
            | needed_ttm
        )
        if "fcf" in needed_quarters:
            needed_quarters.update({"operating_cash_flow", "capex"})
        if "ebitda" in needed_quarters:
            needed_quarters.update({"operating_income", "d_and_a"})

        quarters_by_concept: dict[str, dict[tuple[date, int], PeriodValue]] = {}
        for c_name in needed_quarters:
            if c_name in CONCEPTS:
                quarters_by_concept[c_name] = self._derive_quarters_for_concept(
                    CONCEPTS[c_name],
                    slots_list,
                    fy_periods,
                    concept_periods.get(c_name, {}),
                )
        for c_name in needed_quarters:
            if c_name in COMPOSITES:
                comp_q = self._derive_quarters_for_concept(
                    COMPOSITES[c_name],
                    slots_list,
                    fy_periods,
                    concept_periods.get(c_name, {}),
                )
                if c_name in {"fcf", "ebitda"}:
                    leg_a, leg_b, sign, basis_label = (
                        ("operating_cash_flow", "capex", -1, "ocf_minus_capex")
                        if c_name == "fcf"
                        else ("operating_income", "d_and_a", 1, "oi_plus_da")
                    )
                    qa_map = quarters_by_concept.get(leg_a, {})
                    qb_map = quarters_by_concept.get(leg_b, {})
                    for q_key in set(qa_map).intersection(qb_map):
                        if q_key in comp_q:
                            continue
                        pa_v, pb_v = qa_map[q_key], qb_map[q_key]
                        if (
                            pa_v.usable
                            and pb_v.usable
                            and pa_v.currency == pb_v.currency
                            and pa_v.period_start is not None
                            and pb_v.period_start is not None
                            and abs((pa_v.period_start - pb_v.period_start).days) <= 3
                            and abs((pa_v.period_end - pb_v.period_end).days) <= 3
                        ):
                            assert (
                                pa_v.decimal_value is not None
                                and pb_v.decimal_value is not None
                            )
                            val = pa_v.decimal_value + pb_v.decimal_value * sign
                            st = (
                                "approximate"
                                if "approximate" in {pa_v.status, pb_v.status}
                                else "ok"
                            )
                            comp_q[q_key] = PeriodValue(
                                status=st,
                                decimal_value=val,
                                raw_value=_format_decimal(val),
                                available_ns=max(pa_v.available_ns, pb_v.available_ns),
                                period_start=pa_v.period_start,
                                period_end=pa_v.period_end,
                                basis=basis_label,
                                accessions=_join_accessions(
                                    pa_v.accessions, pb_v.accessions
                                ),
                                tag=pa_v.tag,
                                currency=pa_v.currency,
                                reference_date=max(
                                    pa_v.reference_date, pb_v.reference_date
                                ),
                            )
                quarters_by_concept[c_name] = comp_q

        self._update_quarter_ledger(
            batch_clock, slots_list, concept_periods, quarters_by_concept
        )

        ttm_by_concept: dict[str, dict[date, PeriodValue]] = {}
        for c_name in needed_ttm:
            if c_name in CONCEPTS:
                ttm_by_concept[c_name] = self._derive_ttm_for_concept(
                    CONCEPTS[c_name],
                    fy_periods,
                    concept_periods.get(c_name, {}),
                    quarters_by_concept.get(c_name, {}),
                )
        for c_name in needed_ttm:
            if c_name in COMPOSITES:
                comp_ttm = self._derive_ttm_for_concept(
                    COMPOSITES[c_name],
                    fy_periods,
                    concept_periods.get(c_name, {}),
                    quarters_by_concept.get(c_name, {}),
                )
                if c_name in {"fcf", "ebitda"}:
                    leg_a, leg_b, sign, basis_label = (
                        ("operating_cash_flow", "capex", -1, "ocf_minus_capex")
                        if c_name == "fcf"
                        else ("operating_income", "d_and_a", 1, "oi_plus_da")
                    )
                    ta_map = ttm_by_concept.get(leg_a, {})
                    tb_map = ttm_by_concept.get(leg_b, {})
                    for e_a, pa_v in ta_map.items():
                        if e_a in comp_ttm or not pa_v.usable:
                            continue
                        matching_b = [
                            pb_v
                            for e_b, pb_v in tb_map.items()
                            if pb_v.usable
                            and abs((e_a - e_b).days) <= 3
                            and pa_v.currency == pb_v.currency
                            and pa_v.period_start is not None
                            and pb_v.period_start is not None
                            and abs((pa_v.period_start - pb_v.period_start).days) <= 3
                        ]
                        if matching_b:
                            pb_v = min(
                                matching_b,
                                key=lambda cand: abs((cand.period_end - e_a).days),
                            )
                            assert (
                                pa_v.decimal_value is not None
                                and pb_v.decimal_value is not None
                            )
                            val = pa_v.decimal_value + pb_v.decimal_value * sign
                            st = (
                                "approximate"
                                if "approximate" in {pa_v.status, pb_v.status}
                                else "ok"
                            )
                            comp_ttm[e_a] = PeriodValue(
                                status=st,
                                decimal_value=val,
                                raw_value=_format_decimal(val),
                                available_ns=max(pa_v.available_ns, pb_v.available_ns),
                                period_start=pa_v.period_start,
                                period_end=pa_v.period_end,
                                basis=basis_label,
                                accessions=_join_accessions(
                                    pa_v.accessions, pb_v.accessions
                                ),
                                tag=pa_v.tag,
                                currency=pa_v.currency,
                                reference_date=max(
                                    pa_v.reference_date, pb_v.reference_date
                                ),
                            )
                ttm_by_concept[c_name] = comp_ttm

        for view_name, c_name, suffix in self._parsed_views:
            chosen = self._select_view_state(
                c_name,
                suffix,
                concept_periods.get(c_name, {}),
                quarters_by_concept.get(c_name, {}),
                ttm_by_concept.get(c_name, {}),
                fy_periods,
                is_annual_only,
            )
            if chosen is None:
                if (
                    view_name in self.last_emitted
                    and self.last_emitted[view_name][0] != "metric_missing"
                ):
                    tombstone = (
                        "metric_missing",
                        None,
                        None,
                        None,
                        "",
                        "",
                        "",
                        "",
                        None,
                    )
                    self.last_emitted[view_name] = tombstone
                    self.rows.append(
                        {
                            "cik": self.cik,
                            "view": view_name,
                            "available_at": batch_clock,
                            "value": float("nan"),
                            "raw_value": None,
                            "status": "metric_missing",
                            "period_start": None,
                            "period_end": None,
                            "basis": "",
                            "accessions": "",
                            "tag": "",
                            "currency": "",
                            "reference_date": None,
                        }
                    )
                continue

            signature = (
                chosen.status,
                chosen.decimal_value,
                chosen.period_start,
                chosen.period_end,
                chosen.basis,
                chosen.accessions,
                chosen.tag,
                chosen.currency,
                chosen.reference_date,
            )
            if self.last_emitted.get(view_name) == signature:
                continue
            self.last_emitted[view_name] = signature
            num = chosen.float_value
            status = (
                "invalid_value"
                if chosen.usable and not np.isfinite(num)
                else chosen.status
            )
            self.rows.append(
                {
                    "cik": self.cik,
                    "view": view_name,
                    "available_at": batch_clock,
                    "value": num if status in {"ok", "approximate"} else float("nan"),
                    "raw_value": chosen.raw_value,
                    "status": status,
                    "period_start": chosen.period_start,
                    "period_end": chosen.period_end,
                    "basis": chosen.basis,
                    "accessions": chosen.accessions,
                    "tag": chosen.tag,
                    "currency": chosen.currency,
                    "reference_date": chosen.reference_date,
                }
            )

    def _select_view_state(
        self,
        c_name: str,
        suffix: str,
        p_map: Mapping[tuple[date | None, date], PeriodValue],
        q_map: Mapping[tuple[date, int], PeriodValue],
        ttm_map: Mapping[date, PeriodValue],
        fy_periods: set[tuple[date, date]],
        is_annual_only: bool,
    ) -> PeriodValue | None:
        if suffix.endswith("_yoy"):
            return self._select_yoy_state(
                c_name,
                suffix[:-4],
                p_map,
                q_map,
                ttm_map,
                fy_periods,
                is_annual_only,
            )

        if suffix == "i":
            instants = [pv for (ps, _), pv in p_map.items() if ps is None]
            if not instants:
                return None
            return max(instants, key=lambda pv: pv.period_end)

        if suffix == "fy":
            fys = [
                pv
                for (ps, pe), pv in p_map.items()
                if ps is not None and (ps, pe) in fy_periods
            ]
            if not fys:
                if p_map:
                    latest = max(p_map.values(), key=lambda pv: pv.period_end)
                    return PeriodValue(
                        status="period_unavailable",
                        decimal_value=None,
                        raw_value=None,
                        available_ns=latest.available_ns,
                        period_start=latest.period_start,
                        period_end=latest.period_end,
                        basis="",
                        accessions=latest.accessions,
                        tag=latest.tag,
                        currency=latest.currency,
                        reference_date=latest.reference_date,
                    )
                return None
            return max(fys, key=lambda pv: (pv.period_end, pv.period_start or date.min))

        if suffix == "q":
            if is_annual_only:
                if p_map:
                    latest = max(p_map.values(), key=lambda pv: pv.period_end)
                    return PeriodValue(
                        status="annual_only",
                        decimal_value=None,
                        raw_value=None,
                        available_ns=latest.available_ns,
                        period_start=latest.period_start,
                        period_end=latest.period_end,
                        basis="",
                        accessions=latest.accessions,
                        tag=latest.tag,
                        currency=latest.currency,
                        reference_date=latest.reference_date,
                    )
                return None
            if q_map:
                return max(
                    q_map.values(),
                    key=lambda pv: (pv.period_end, pv.period_start or date.min),
                )
            if p_map:
                latest = max(p_map.values(), key=lambda pv: pv.period_end)
                return PeriodValue(
                    status="period_unavailable",
                    decimal_value=None,
                    raw_value=None,
                    available_ns=latest.available_ns,
                    period_start=latest.period_start,
                    period_end=latest.period_end,
                    basis="",
                    accessions=latest.accessions,
                    tag=latest.tag,
                    currency=latest.currency,
                    reference_date=latest.reference_date,
                )
            return None

        if suffix == "ttm":
            usable_ttms = [pv for pv in ttm_map.values() if pv.usable]
            if usable_ttms:
                return max(usable_ttms, key=lambda pv: pv.period_end)
            if ttm_map:
                return max(ttm_map.values(), key=lambda pv: pv.period_end)
            if p_map:
                latest = max(p_map.values(), key=lambda pv: pv.period_end)
                return PeriodValue(
                    status="period_unavailable",
                    decimal_value=None,
                    raw_value=None,
                    available_ns=latest.available_ns,
                    period_start=latest.period_start,
                    period_end=latest.period_end,
                    basis="",
                    accessions=latest.accessions,
                    tag=latest.tag,
                    currency=latest.currency,
                    reference_date=latest.reference_date,
                )
            return None

        return None

    def _select_yoy_state(
        self,
        c_name: str,
        base_suffix: str,
        p_map: Mapping[tuple[date | None, date], PeriodValue],
        q_map: Mapping[tuple[date, int], PeriodValue],
        ttm_map: Mapping[date, PeriodValue],
        fy_periods: set[tuple[date, date]],
        is_annual_only: bool,
    ) -> PeriodValue | None:
        cur = self._select_view_state(
            c_name,
            base_suffix,
            p_map,
            q_map,
            ttm_map,
            fy_periods,
            is_annual_only,
        )
        if cur is None:
            return None
        if not cur.usable:
            return PeriodValue(
                status=cur.status,
                decimal_value=None,
                raw_value=None,
                available_ns=cur.available_ns,
                period_start=cur.period_start,
                period_end=cur.period_end,
                basis=cur.basis,
                accessions=cur.accessions,
                tag=cur.tag,
                currency=cur.currency,
                reference_date=cur.reference_date,
            )

        if base_suffix == "i":
            candidates = [pv for (ps, _), pv in p_map.items() if ps is None]
        elif base_suffix == "fy":
            candidates = [
                pv
                for (ps, pe), pv in p_map.items()
                if ps is not None and (ps, pe) in fy_periods
            ]
        elif base_suffix == "ttm":
            candidates = list(ttm_map.values())
        else:  # "q"
            pool: dict[tuple[date | None, date], PeriodValue] = {}
            for (ps, pe), pv in p_map.items():
                if ps is not None and 77 <= _inclusive_days(ps, pe) <= 105:
                    pool[(ps, pe)] = pv
            for pv in q_map.values():
                pool[(pv.period_start, pv.period_end)] = pv
            candidates = list(pool.values())

        exp_end = _prev_year_date(cur.period_end)
        near_end = [
            pv
            for pv in candidates
            if pv.period_end < cur.period_end
            and abs((pv.period_end - exp_end).days) <= 7
        ]
        if base_suffix == "i":
            matched = near_end
        else:
            assert cur.period_start is not None
            cur_days = _inclusive_days(cur.period_start, cur.period_end)
            matched = [
                pv
                for pv in near_end
                if pv.period_start is not None
                and abs(_inclusive_days(pv.period_start, pv.period_end) - cur_days) <= 7
            ]

        def _err(status_code: str, prior_pv: PeriodValue | None = None) -> PeriodValue:
            acc = (
                _join_accessions(cur.accessions, prior_pv.accessions)
                if prior_pv is not None
                else cur.accessions
            )
            avail = (
                max(cur.available_ns, prior_pv.available_ns)
                if prior_pv is not None
                else cur.available_ns
            )
            return PeriodValue(
                status=status_code,
                decimal_value=None,
                raw_value=None,
                available_ns=avail,
                period_start=cur.period_start,
                period_end=cur.period_end,
                basis=cur.basis,
                accessions=acc,
                tag=cur.tag,
                currency=cur.currency,
                reference_date=cur.reference_date,
            )

        if not matched:
            has_unverified = any(
                pv.period_end < cur.period_end
                and (
                    pv.period_end <= exp_end + timedelta(days=7)
                    or abs((pv.period_end - exp_end).days) <= 60
                )
                for pv in candidates
            )
            return _err(
                "unverified_prior_period" if has_unverified else "prior_unavailable"
            )

        prior = min(
            matched,
            key=lambda pv: (
                abs((pv.period_end - exp_end).days),
                -pv.period_end.toordinal(),
            ),
        )
        if not prior.usable or prior.decimal_value is None:
            return _err(prior.status, prior)
        if cur.currency != prior.currency:
            return _err("unit_unavailable", prior)
        if prior.decimal_value == 0:
            return _err("zero_prior", prior)
        if prior.decimal_value < 0:
            return _err("nonpositive_prior", prior)

        assert cur.decimal_value is not None
        growth = (cur.decimal_value - prior.decimal_value) / prior.decimal_value
        st = "approximate" if "approximate" in {cur.status, prior.status} else "ok"
        return PeriodValue(
            status=st,
            decimal_value=growth,
            raw_value=_format_decimal(growth),
            available_ns=max(cur.available_ns, prior.available_ns),
            period_start=cur.period_start,
            period_end=cur.period_end,
            basis=cur.basis,
            accessions=_join_accessions(cur.accessions, prior.accessions),
            tag=cur.tag,
            currency=cur.currency,
            reference_date=cur.reference_date,
        )


def _extract_manifest_and_universe(
    version_or_material: Any,
) -> tuple[Mapping[str, Any], list[dict[str, Any]]]:
    if isinstance(version_or_material, Mapping):
        manifest = version_or_material.get("manifest", {})
        universe = version_or_material.get("universe", [])
    else:
        manifest = getattr(version_or_material, "manifest", {})
        universe = getattr(version_or_material, "universe", [])
    records = (
        universe.to_dict("records")
        if isinstance(universe, pd.DataFrame)
        else list(universe)
    )
    return manifest, records


def _optional_family(
    version_or_material: Any, name: str, symbols: Sequence[str] | None = None
) -> pd.DataFrame | None:
    if isinstance(version_or_material, Mapping):
        frame = version_or_material.get(name)
        if frame is None:
            return None
        return frame if isinstance(frame, pd.DataFrame) else pd.DataFrame(frame)
    manifest = getattr(version_or_material, "manifest", {})
    families = manifest.get("data_families", {}) if isinstance(manifest, dict) else {}
    if name not in families:
        return None
    reader = getattr(version_or_material, "family", None)
    if callable(reader):
        return reader(name, symbols)
    return None


def asset_at(version_or_material: Any, symbol: str, session: str | date) -> str | None:
    """Resolve ``symbol`` at ``session`` using ``symbol_history`` when available."""
    day_obj = clocks.day(session)
    day_s = day_obj.isoformat()
    target = symbol.strip().upper()
    if not target:
        return None
    sym_hist = _optional_family(version_or_material, "symbol_history")
    if sym_hist is not None and not sym_hist.empty:
        sym_col = sym_hist["symbol"].astype(str).str.upper()
        vf = sym_hist["valid_from"].fillna("").astype(str)
        vt = sym_hist["valid_to"].fillna("").astype(str)
        vt_eff = vt.where(vt != "", "9999-12-31")
        status = (
            sym_hist["status"].fillna("").astype(str)
            if "status" in sym_hist.columns
            else pd.Series("verified", index=sym_hist.index)
        )
        matched = sym_hist[
            (sym_col == target)
            & (vf <= day_s)
            & (day_s <= vt_eff)
            & status.isin({"verified", "provisional"})
        ]
        if matched.empty:
            return None
        verified = matched[status.loc[matched.index] == "verified"]
        chosen = verified if not verified.empty else matched
        ids = list(dict.fromkeys(chosen["asset_id"].astype(str)))
        return ids[0] if len(ids) == 1 else None

    _, universe = _extract_manifest_and_universe(version_or_material)
    ids = list(
        dict.fromkeys(
            str(row["asset_id"])
            for row in universe
            if str(row.get("symbol", "")).upper() == target
        )
    )
    return ids[0] if len(ids) == 1 else None


def _resolve_sample_ciks(
    version_or_material: Any,
    asset_ids: Sequence[str],
    sessions: Sequence[Any],
) -> tuple[list[str], list[str]]:
    """Return ``(ciks, missing_reasons)`` per row where ``cik == ''`` when unmapped."""
    if len(asset_ids) != len(sessions):
        raise ValueError("asset_ids and sessions must have equal length")
    if not asset_ids:
        return [], []
    days = [clocks.day(s).isoformat() for s in sessions]
    unique_assets = list(dict.fromkeys(str(a) for a in asset_ids))
    iss_hist = _optional_family(version_or_material, "issuer_history", unique_assets)
    if iss_hist is not None:
        by_asset: dict[str, list[tuple[str, str, str, str]]] = {}
        if not iss_hist.empty:
            for row in iss_hist.to_dict("records"):
                aid = str(row.get("asset_id", ""))
                vf = str(row.get("valid_from") or "")
                vt = str(row.get("valid_to") or "") or "9999-12-31"
                st = str(row.get("status") or "")
                cik = _valid_cik(str(row.get("cik") or "")) or ""
                by_asset.setdefault(aid, []).append((vf, vt, st, cik))
        ciks_out: list[str] = []
        reasons_out: list[str] = []
        for aid, day_s in zip(asset_ids, days):
            intervals = by_asset.get(str(aid), ())
            matched_cik = ""
            reason = "mapping_missing"
            for vf, vt, st, cik in intervals:
                if vf <= day_s <= vt:
                    if st == "verified" and cik:
                        matched_cik = cik
                        reason = ""
                        break
                    if st == "not_sec_filer":
                        reason = "issuer_not_sec_filer"
            ciks_out.append(matched_cik)
            reasons_out.append(reason)
        return ciks_out, reasons_out

    _, universe = _extract_manifest_and_universe(version_or_material)
    by_aid: dict[str, tuple[str, str]] = {}
    for row in universe:
        aid = str(row["asset_id"])
        st = str(row.get("issuer_mapping_status") or "")
        cik = _valid_cik(str(row.get("cik") or "")) or ""
        if st == "verified" and cik:
            by_aid[aid] = (cik, "")
        elif st == "not_sec_filer":
            by_aid[aid] = ("", "issuer_not_sec_filer")
        else:
            by_aid[aid] = ("", "mapping_missing")
    ciks_out = []
    reasons_out = []
    for aid in asset_ids:
        cik, reason = by_aid.get(str(aid), ("", "mapping_missing"))
        ciks_out.append(cik)
        reasons_out.append(reason)
    return ciks_out, reasons_out


def cik_at(
    version_or_material: Any,
    asset_ids: Sequence[str],
    sessions: Sequence[str | date],
) -> pd.Series:
    """Point-in-time verified 10-digit CIK per ``(asset_id, session)`` (or ``''``)."""
    ciks, _ = _resolve_sample_ciks(version_or_material, asset_ids, sessions)
    return pd.Series(ciks, dtype="object", name="cik")


def _iter_fact_frames(
    version_or_material: Any,
    ciks: Sequence[str] | None,
) -> tuple[Mapping[str, Any], Iterable[pd.DataFrame]]:
    manifest, universe = _extract_manifest_and_universe(version_or_material)
    wanted_ciks = (
        None if ciks is None else sorted({_valid_cik(str(c)) for c in ciks} - {None})  # type: ignore[arg-type]
    )
    if wanted_ciks is not None and not wanted_ciks:
        return manifest, []
    if isinstance(version_or_material, Mapping):
        facts = version_or_material.get("fundamentals")
        frame = facts if isinstance(facts, pd.DataFrame) else pd.DataFrame(facts or [])
        if not frame.empty and wanted_ciks is not None and "cik" in frame.columns:
            padded = frame["cik"].astype(str).str.zfill(10)
            frame = frame[padded.isin(set(wanted_ciks))]
        return manifest, [frame]

    iterator_fn = getattr(version_or_material, "iter_fundamentals", None)
    if callable(iterator_fn):
        return manifest, iterator_fn(ciks=wanted_ciks)

    # Duck-typed version fallback via fundamentals()
    if wanted_ciks is not None:
        wanted_set = set(wanted_ciks)
        symbols = [
            str(row["asset_id"])
            for row in universe
            if (_valid_cik(str(row.get("cik") or "")) in wanted_set)
        ]
        frame = version_or_material.fundamentals(symbols) if symbols else pd.DataFrame()
    else:
        frame = version_or_material.fundamentals()
    return manifest, [frame]


def _format_state_frame(
    rows: list[dict[str, Any]],
    *,
    time_policy: str,
    stats: Mapping[str, int],
    limitations: Sequence[str],
    annual_only_steps: Mapping[str, list[tuple[int, bool]]] | None = None,
) -> pd.DataFrame:
    steps_attr = {
        cik: [[int(ns), bool(flag)] for ns, flag in seq]
        for cik, seq in (annual_only_steps or {}).items()
    }
    if not rows:
        empty = pd.DataFrame(columns=list(STATE_COLUMNS))
        empty["available_at"] = pd.to_datetime(empty["available_at"], utc=True)
        empty["value"] = empty["value"].astype("float64")
        for col in ("cik", "view", "status", "basis", "tag", "currency"):
            empty[col] = empty[col].astype("category")
        empty.attrs.update(
            time_policy=time_policy,
            derivation_version=DERIVATION_VERSION,
            dropped_counts=dict(stats),
            limitations=list(limitations),
            annual_only_steps=steps_attr,
        )
        return empty

    frame = pd.DataFrame(rows, columns=list(STATE_COLUMNS))
    frame["available_at"] = pd.to_datetime(frame["available_at"], unit="ns", utc=True)
    frame["value"] = frame["value"].astype("float64")
    frame["status"] = pd.Categorical(
        frame["status"], categories=list(FUNDAMENTAL_STATUSES)
    )
    for col in ("cik", "view", "basis", "tag", "currency"):
        frame[col] = frame[col].astype("category")
    frame.sort_values(["cik", "view", "available_at"], kind="mergesort", inplace=True)
    frame.reset_index(drop=True, inplace=True)
    frame.attrs.update(
        time_policy=time_policy,
        derivation_version=DERIVATION_VERSION,
        dropped_counts=dict(stats),
        limitations=list(limitations),
        annual_only_steps=steps_attr,
    )
    return frame


def _state_cache_paths(
    version_or_material: Any,
    *,
    time_policy: str,
    ciks: Sequence[str] | None,
    target_views: Sequence[str] | None,
) -> tuple[Path, Path] | None:
    if isinstance(version_or_material, Mapping):
        cache_root = version_or_material.get("cache_dir")
        manifest = version_or_material.get("manifest", {})
        dataset_id = (
            manifest.get("dataset_id") if isinstance(manifest, Mapping) else None
        )
        manifest_sha = version_or_material.get("manifest_sha256")
    else:
        client = getattr(version_or_material, "_client", None)
        cache_root = getattr(client, "cache_dir", None)
        dataset_id = getattr(version_or_material, "id", None)
        manifest_sha = getattr(version_or_material, "manifest_sha256", None)

    if not cache_root or not dataset_id or not manifest_sha:
        return None

    wanted_ciks = (
        "ALL"
        if ciks is None
        else sorted({c for c in (_valid_cik(x) for x in ciks) if c is not None})
    )
    views_key = "ALL" if target_views is None else list(target_views)
    payload = json.dumps({"ciks": wanted_ciks, "views": views_key}, sort_keys=True)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
    directory = (
        Path(cache_root)
        / "derived"
        / str(dataset_id)
        / str(manifest_sha)
        / time_policy
        / DERIVATION_VERSION
    )
    return directory / f"{digest}.parquet", directory / f"{digest}.meta.json"


def _load_cached_states(parquet_path: Path, meta_path: Path) -> pd.DataFrame | None:
    if not parquet_path.is_file() or not meta_path.is_file():
        return None
    try:
        frame = pd.read_parquet(parquet_path)
        meta = json.loads(meta_path.read_text("utf-8"))
    except Exception:  # noqa: BLE001
        return None
    frame["available_at"] = pd.to_datetime(frame["available_at"], utc=True)
    frame["value"] = frame["value"].astype("float64")
    frame["status"] = pd.Categorical(
        frame["status"], categories=list(FUNDAMENTAL_STATUSES)
    )
    for col in ("cik", "view", "basis", "tag", "currency"):
        frame[col] = frame[col].astype("category")
    for col in ("period_start", "period_end", "reference_date"):
        if col in frame.columns:
            frame[col] = frame[col].map(_parse_iso_date)
    frame.attrs.update(meta)
    return frame


def _save_cached_states(
    frame: pd.DataFrame, parquet_path: Path, meta_path: Path
) -> None:
    try:
        parquet_path.parent.mkdir(parents=True, exist_ok=True)
        serializable = frame.copy()
        for col in ("raw_value", "accessions"):
            serializable[col] = serializable[col].astype("string")
        for col in ("period_start", "period_end", "reference_date"):
            serializable[col] = (
                serializable[col]
                .map(lambda d: d.isoformat() if isinstance(d, date) else None)
                .astype("string")
            )
        tmp_pq = parquet_path.with_suffix(".parquet.tmp")
        tmp_meta = meta_path.with_suffix(".json.tmp")
        serializable.to_parquet(tmp_pq, index=False, engine="pyarrow")
        tmp_meta.write_text(json.dumps(dict(frame.attrs), indent=2) + "\n", "utf-8")
        tmp_pq.replace(parquet_path)
        tmp_meta.replace(meta_path)
    except OSError:
        return


def fundamental_states(
    version_or_material: Any,
    *,
    time_policy: str,
    ciks: Sequence[str] | None = None,
    concepts: Sequence[str] | None = None,
    views: Sequence[str] | None = None,
) -> pd.DataFrame:
    """Build the point-in-time derived state timeline per ``(cik, view, available_at)``."""
    clocks.policy(time_policy)
    if views is not None:
        target_views = tuple(dict.fromkeys(views))
        for v in target_views:
            parse_view_name(v)
        base_needed = required_base_concepts(list(target_views))
    elif concepts is not None:
        expanded = list(dict.fromkeys(concepts))
        target_views_list: list[str] = []
        for item in expanded:
            if item in ALL_CONCEPTS:
                spec = ALL_CONCEPTS[item]
                for suffix in views_for_concept(spec):
                    target_views_list.append(f"{item}_{suffix}")
            else:
                parse_view_name(item)
                target_views_list.append(item)
        target_views = tuple(dict.fromkeys(target_views_list))
        base_needed = required_base_concepts(list(target_views))
    else:
        target_views = None
        base_needed = None

    cache_paths = _state_cache_paths(
        version_or_material,
        time_policy=time_policy,
        ciks=ciks,
        target_views=target_views,
    )
    if cache_paths is not None:
        cached = _load_cached_states(*cache_paths)
        if cached is not None:
            return cached

    manifest, frames = _iter_fact_frames(version_or_material, ciks)
    zones = (
        manifest.get("source_timezones", {}) if isinstance(manifest, Mapping) else {}
    )
    totals = {
        "dropped_unknown_clock_versions": 0,
        "dropped_invalid_clock_versions": 0,
        "dropped_unmapped_tags": 0,
        "dropped_unit_mismatch": 0,
    }
    all_rows: list[dict[str, Any]] = []
    annual_only_steps: dict[str, list[tuple[int, bool]]] = {}
    by_cik_buffer: dict[str, list[FactVersion]] = {}

    # When computing annual-only detection accurately under concept projection,
    # include revenue_total/total_assets if needed; base_needed=None reads all.
    norm_concepts = (
        None
        if base_needed is None
        else (
            set(base_needed)
            | {"revenue_total", "revenue_contracts", "net_income_parent"}
        )
    )
    for chunk in frames:
        if chunk is None or chunk.empty:
            continue
        versions, stats = normalize_facts(
            chunk,
            time_policy=time_policy,
            source_timezones=zones,
            concepts=norm_concepts,
        )
        for key, count in stats.items():
            totals[key] = totals.get(key, 0) + count
        for v in versions:
            by_cik_buffer.setdefault(v.cik, []).append(v)

    for cik in sorted(by_cik_buffer):
        issuer_versions = by_cik_buffer[cik]
        issuer_versions.sort(key=lambda v: (v.available_ns, v.observation_sequence))
        machine = IssuerStateMachine(cik, target_views=target_views)
        machine.ingest(issuer_versions)
        all_rows.extend(machine.rows)
        if machine.annual_only_steps:
            annual_only_steps[cik] = machine.annual_only_steps

    limitations = list(manifest.get("limitations", [])) + [
        "Derived fundamentals (single quarters, TTM, YoY) are computed from as-filed XBRL facts.",
    ]
    result = _format_state_frame(
        all_rows,
        time_policy=time_policy,
        stats=totals,
        limitations=limitations,
        annual_only_steps=annual_only_steps,
    )
    if cache_paths is not None:
        _save_cached_states(result, *cache_paths)
    return result


def fiscal_quarters(
    version_or_material: Any,
    *,
    time_policy: str,
    concepts: Sequence[str] = ("eps_diluted", "eps_basic", "net_income", "revenue"),
    ciks: Sequence[str] | None = None,
) -> pd.DataFrame:
    """Point-in-time quarterly ledger recording first-known and latest values per quarter."""
    clocks.policy(time_policy)
    concept_list = tuple(dict.fromkeys(concepts))
    for name in concept_list:
        spec = ALL_CONCEPTS.get(name)
        if spec is None or spec.kind != "duration":
            raise ValueError(f"Unsupported quarterly concept {name!r}")

    base_needed = required_base_concepts(list(concept_list)) | {
        "revenue_total",
        "revenue_contracts",
        "net_income_parent",
    }
    manifest, frames = _iter_fact_frames(version_or_material, ciks)
    zones = (
        manifest.get("source_timezones", {}) if isinstance(manifest, Mapping) else {}
    )
    by_cik_buffer: dict[str, list[FactVersion]] = {}
    for chunk in frames:
        if chunk is None or chunk.empty:
            continue
        versions, _ = normalize_facts(
            chunk,
            time_policy=time_policy,
            source_timezones=zones,
            concepts=base_needed,
        )
        for v in versions:
            by_cik_buffer.setdefault(v.cik, []).append(v)

    ledger_rows: list[dict[str, Any]] = []
    for cik in sorted(by_cik_buffer):
        issuer_versions = by_cik_buffer[cik]
        issuer_versions.sort(key=lambda v: (v.available_ns, v.observation_sequence))
        machine = IssuerStateMachine(cik, target_views=(), record_quarters=concept_list)
        machine.ingest(issuer_versions)
        for _, entry in sorted(machine.quarter_ledger.items()):
            row = {col: entry[col] for col in FISCAL_QUARTER_COLUMNS}
            ledger_rows.append(row)

    if not ledger_rows:
        empty = pd.DataFrame(columns=list(FISCAL_QUARTER_COLUMNS))
        empty["available_at_first"] = pd.to_datetime(
            empty["available_at_first"], utc=True
        )
        empty["available_at_latest"] = pd.to_datetime(
            empty["available_at_latest"], utc=True
        )
        for col in ("value_first", "prior_year_value_first", "value_latest"):
            empty[col] = empty[col].astype("float64")
        empty["fiscal_quarter"] = empty["fiscal_quarter"].astype("int64")
        empty.attrs.update(
            time_policy=time_policy,
            derivation_version=DERIVATION_VERSION,
            concepts=list(concept_list),
        )
        return empty

    out = pd.DataFrame(ledger_rows, columns=list(FISCAL_QUARTER_COLUMNS))
    out["available_at_first"] = pd.to_datetime(
        out["available_at_first"], unit="ns", utc=True
    )
    out["available_at_latest"] = pd.to_datetime(
        out["available_at_latest"], unit="ns", utc=True
    )
    for col in ("value_first", "prior_year_value_first", "value_latest"):
        out[col] = out[col].astype("float64")
    out["fiscal_quarter"] = out["fiscal_quarter"].astype("int64")
    out["status_first"] = pd.Categorical(
        out["status_first"], categories=list(FUNDAMENTAL_STATUSES)
    )
    out.sort_values(["cik", "concept", "period_end"], kind="mergesort", inplace=True)
    out.reset_index(drop=True, inplace=True)
    out.attrs.update(
        time_policy=time_policy,
        derivation_version=DERIVATION_VERSION,
        concepts=list(concept_list),
    )
    return out


@dataclass(frozen=True)
class _SampleCheckDiag:
    override_status: str | None  # "issuer_not_sec_filer" | "not_checked" | None
    max_parser: int  # 1 or 2 (2 when no financial_checks table is supplied)


def _evaluate_check_diagnostics(
    version_or_material: Any,
    sample_ciks: Sequence[str],
    signal_days: Sequence[date],
    decision_ns: np.ndarray,
    unique_assets: Sequence[str],
    time_policy: str,
) -> list[_SampleCheckDiag]:
    n = len(sample_ciks)
    checks_df = _optional_family(version_or_material, "financial_checks", unique_assets)
    if checks_df is None:
        return [_SampleCheckDiag(None, 2) for _ in range(n)]

    by_cik: dict[
        str, list[tuple[int, int, str, str, date | None, date | None, int]]
    ] = {}
    if not checks_df.empty and "cik" in checks_df.columns:
        checked_ns_arr = (
            clocks.instants(checks_df["checked_at"].to_numpy(dtype=object))
            if "checked_at" in checks_df.columns
            else np.zeros(len(checks_df), dtype=np.int64)
        )
        rows_list = checks_df.to_dict("records")
        for idx, row in enumerate(rows_list):
            cik = _valid_cik(str(row.get("cik") or ""))
            if cik is None:
                continue
            seq_raw = row.get("check_sequence", idx)
            seq = (
                int(seq_raw)
                if isinstance(seq_raw, (int, np.integer))
                and not isinstance(seq_raw, bool)
                else idx
            )
            c_ns = int(checked_ns_arr[idx])
            st = str(row.get("status") or "")
            err = str(row.get("error_code") or "")
            cs = _parse_iso_date(row.get("checked_start") or row.get("requested_start"))
            ce = _parse_iso_date(row.get("checked_end") or row.get("requested_end"))
            pv_str = str(row.get("parser_version") or "")
            p_ver = 2 if pv_str == "companyfacts-v2" else 1
            by_cik.setdefault(cik, []).append((seq, c_ns, st, err, cs, ce, p_ver))

    for entries in by_cik.values():
        entries.sort(key=lambda item: (item[0], item[1]))

    diags: list[_SampleCheckDiag] = []
    for i in range(n):
        cik = sample_ciks[i]
        if not cik or decision_ns[i] == clocks.NAT:
            diags.append(_SampleCheckDiag(None, 2))
            continue
        entries = by_cik.get(cik, [])
        if time_policy == "observed_content":
            cutoff_ns = int(decision_ns[i])
            visible = [
                e
                for e in entries
                if e[1] != clocks.NAT and (e[1] - clocks.GRACE_NS) <= cutoff_ns
            ]
        else:
            visible = entries

        if not visible:
            diags.append(_SampleCheckDiag("not_checked", 1))
            continue

        latest = visible[-1]
        if latest[2] == "unsupported_filer" or latest[3] == "SEC_NOT_PERIODIC_FILER":
            diags.append(_SampleCheckDiag("issuer_not_sec_filer", 2))
            continue

        sig_day = signal_days[i]
        covering_parsers: list[int] = []
        for _, _, st, _, cs, ce, p_ver in visible:
            if st not in {"checked", "empty", "not_changed"}:
                continue
            if cs is not None and ce is not None and not (cs <= sig_day <= ce):
                continue
            covering_parsers.append(p_ver)

        if not covering_parsers:
            diags.append(_SampleCheckDiag("not_checked", 1))
        else:
            diags.append(_SampleCheckDiag(None, max(covering_parsers)))

    return diags


def _is_annual_only_at(
    steps: Sequence[Sequence[Any]] | None, decision_ns_val: int
) -> bool:
    if not steps or decision_ns_val == clocks.NAT:
        return False
    flag = False
    for pair in steps:
        ns, val = int(pair[0]), bool(pair[1])
        if ns <= decision_ns_val:
            flag = val
        else:
            break
    return flag


def derived_fundamentals(
    version_or_material: Any,
    samples: pd.DataFrame,
    *,
    time_policy: str,
    views: Sequence[str] | None = None,
    stale_after_days: Mapping[str, int] | None = None,
    provenance: bool = False,
) -> pd.DataFrame:
    """Join derived point-in-time fundamental views onto ``samples`` at ``decision_at``."""
    clocks.policy(time_policy)
    if not set(KEYS + ["decision_at"]).issubset(samples.columns):
        raise ValueError("Samples require candidate keys and decision_at")

    if views is None:
        selected_views = DEFAULT_VIEWS
    else:
        selected_views = tuple(dict.fromkeys(views))
        for v in selected_views:
            _, suffix = parse_view_name(v)
            if suffix not in _ALL_SUFFIXES:
                raise ValueError(f"Unsupported fundamental view {v!r}")

    thresholds = dict(STALE_AFTER_DAYS)
    if stale_after_days is not None:
        thresholds.update({k: int(v) for k, v in stale_after_days.items()})

    out = samples[KEYS].copy()
    if samples.empty:
        for view in selected_views:
            out[f"{view}_value"] = pd.Series(dtype="float64", index=samples.index)
            out[f"{view}_status"] = pd.Series(
                pd.Categorical([], categories=list(FUNDAMENTAL_STATUSES)),
                index=samples.index,
            )
            out[f"{view}_age_days"] = pd.Series(dtype="float64", index=samples.index)
            if provenance:
                out[f"{view}_period_end"] = pd.Series(
                    dtype="object", index=samples.index
                )
                out[f"{view}_available_at"] = pd.Series(
                    dtype="datetime64[ns, UTC]", index=samples.index
                )
                out[f"{view}_basis"] = pd.Series(dtype="object", index=samples.index)
                out[f"{view}_accessions"] = pd.Series(
                    dtype="object", index=samples.index
                )
                out[f"{view}_tag"] = pd.Series(dtype="object", index=samples.index)
                out[f"{view}_currency"] = pd.Series(dtype="object", index=samples.index)
                out[f"{view}_reference_date"] = pd.Series(
                    dtype="object", index=samples.index
                )
        out.attrs.update(
            parameters={
                "views": list(selected_views),
                "stale_after_days": thresholds,
                "time_policy": time_policy,
                "provenance": provenance,
            },
            derivation_version=DERIVATION_VERSION,
        )
        return out

    asset_list = samples["asset_id"].astype(str).tolist()
    unique_assets = list(dict.fromkeys(asset_list))
    signal_days = [clocks.day(val) for val in samples["signal_session"].tolist()]
    sample_ciks, missing_reasons = _resolve_sample_ciks(
        version_or_material, asset_list, signal_days
    )
    mapped_ciks = sorted({c for c in sample_ciks if c})

    states = fundamental_states(
        version_or_material,
        time_policy=time_policy,
        ciks=mapped_ciks,
        views=selected_views,
    )
    annual_steps_map: Mapping[str, Sequence[Sequence[Any]]] = states.attrs.get(
        "annual_only_steps", {}
    )

    decision_ns = clocks.instants(samples["decision_at"].to_numpy(dtype=object))
    valid_decision = decision_ns != clocks.NAT
    check_diags = _evaluate_check_diagnostics(
        version_or_material,
        sample_ciks,
        signal_days,
        decision_ns,
        unique_assets,
        time_policy,
    )
    annual_only_flags = [
        _is_annual_only_at(annual_steps_map.get(sample_ciks[i]), int(decision_ns[i]))
        if sample_ciks[i] and valid_decision[i]
        else False
        for i in range(len(samples))
    ]

    work_samples = pd.DataFrame(
        {
            "cik": sample_ciks,
            "decision_at": samples["decision_at"].to_numpy(),
        },
        index=samples.index,
    )

    join_cols = [
        "value",
        "status",
        "period_end",
        "available_at",
        "basis",
        "accessions",
        "tag",
        "currency",
        "reference_date",
    ]
    ciks_with_view: dict[str, set[str]] = {}
    if not states.empty:
        for view_name, grp in states.groupby("view", observed=True):
            ciks_with_view[str(view_name)] = set(grp["cik"].astype(str))

    new_cols: dict[str, Any] = {}
    for view in selected_views:
        c_name, suffix = parse_view_name(view)
        spec_min_parser = ALL_CONCEPTS[c_name].min_parser
        base_suffix = suffix.removesuffix("_yoy")
        default_stale_limit = thresholds.get(suffix, thresholds.get(base_suffix, 200))
        fy_stale_limit = thresholds.get("fy", 460)

        sub = states[states["view"] == view] if not states.empty else states
        joined = asof.asof_join(
            work_samples,
            sub,
            by="cik",
            columns=join_cols,
            sample_time="decision_at",
            table_time="available_at",
            inclusive=True,
        )

        vals = joined["value"].to_numpy(dtype="float64", copy=True)
        raw_status = joined["status"].astype(object).to_numpy(copy=True)
        p_ends = joined["period_end"].tolist()
        ages = np.full(len(samples), np.nan, dtype="float64")
        known_ciks = ciks_with_view.get(view, set())

        final_status: list[str] = []
        for i in range(len(samples)):
            cik = sample_ciks[i]
            if not cik:
                vals[i] = np.nan
                final_status.append(missing_reasons[i] or "mapping_missing")
                continue
            if not valid_decision[i]:
                vals[i] = np.nan
                final_status.append("invalid_value")
                continue
            diag = check_diags[i]
            if diag.override_status == "issuer_not_sec_filer":
                vals[i] = np.nan
                final_status.append("issuer_not_sec_filer")
                continue
            st = raw_status[i]
            if pd.isna(st) or not st:
                vals[i] = np.nan
                if diag.override_status is not None:
                    final_status.append(diag.override_status)
                elif cik in known_ciks:
                    final_status.append("not_yet_available")
                elif spec_min_parser > diag.max_parser:
                    final_status.append("not_captured")
                else:
                    final_status.append("metric_missing")
                continue
            st_str = str(st)
            if st_str == "metric_missing" and spec_min_parser > diag.max_parser:
                st_str = "not_captured"
            pe = _parse_iso_date(p_ends[i])
            if pe is not None:
                age_val = float((signal_days[i] - pe).days)
                ages[i] = age_val
                limit = (
                    fy_stale_limit
                    if base_suffix == "ttm" and annual_only_flags[i]
                    else default_stale_limit
                )
                if st_str in {"ok", "approximate"} and age_val > limit:
                    st_str = "stale"
            final_status.append(st_str)

        new_cols[f"{view}_value"] = vals
        new_cols[f"{view}_status"] = pd.Categorical(
            final_status, categories=list(FUNDAMENTAL_STATUSES)
        )
        new_cols[f"{view}_age_days"] = ages
        if provenance:
            cleared = {
                i
                for i, st_val in enumerate(final_status)
                if st_val
                in {"mapping_missing", "invalid_value", "issuer_not_sec_filer"}
            }
            pe_vals = [
                None if i in cleared or (isinstance(v, float) and np.isnan(v)) else v
                for i, v in enumerate(joined["period_end"].tolist())
            ]
            avail_series = pd.to_datetime(joined["available_at"], utc=True)
            if cleared:
                avail_series = avail_series.copy()
                avail_series.iloc[list(cleared)] = pd.NaT
            basis_vals = [
                None if i in cleared or pd.isna(v) else str(v)
                for i, v in enumerate(joined["basis"].astype(object).tolist())
            ]
            acc_vals = [
                None if i in cleared or not isinstance(v, (list, tuple)) else list(v)
                for i, v in enumerate(joined["accessions"].tolist())
            ]
            tag_vals = [
                None if i in cleared or pd.isna(v) else str(v)
                for i, v in enumerate(joined["tag"].astype(object).tolist())
            ]
            cur_vals = [
                None if i in cleared or pd.isna(v) else str(v)
                for i, v in enumerate(joined["currency"].astype(object).tolist())
            ]
            ref_vals = [
                None if i in cleared or (isinstance(v, float) and np.isnan(v)) else v
                for i, v in enumerate(joined["reference_date"].tolist())
            ]
            new_cols[f"{view}_period_end"] = pd.Series(
                pe_vals, index=samples.index, dtype="object"
            )
            new_cols[f"{view}_available_at"] = avail_series
            new_cols[f"{view}_basis"] = pd.Series(
                basis_vals, index=samples.index, dtype="object"
            )
            new_cols[f"{view}_accessions"] = pd.Series(
                acc_vals, index=samples.index, dtype="object"
            )
            new_cols[f"{view}_tag"] = pd.Series(
                tag_vals, index=samples.index, dtype="object"
            )
            new_cols[f"{view}_currency"] = pd.Series(
                cur_vals, index=samples.index, dtype="object"
            )
            new_cols[f"{view}_reference_date"] = pd.Series(
                ref_vals, index=samples.index, dtype="object"
            )

    result = pd.concat(
        [out, pd.DataFrame(new_cols, index=samples.index)],
        axis=1,
    )
    result.attrs.update(
        parameters={
            "views": list(selected_views),
            "stale_after_days": thresholds,
            "time_policy": time_policy,
            "provenance": provenance,
        },
        derivation_version=DERIVATION_VERSION,
        dropped_counts=dict(states.attrs.get("dropped_counts", {})),
        limitations=list(states.attrs.get("limitations", [])),
    )
    return result


def fundamental_factors(derived: pd.DataFrame) -> pd.DataFrame:
    """Compute statement-only quality, margin, growth, and balance-sheet factors."""
    if not set(KEYS).issubset(derived.columns):
        raise ValueError("Derived frame requires candidate KEYS")

    n = len(derived)
    out = derived[KEYS].copy()
    if n == 0:
        for name in FACTOR_NAMES:
            out[f"{name}_value"] = pd.Series(dtype="float64", index=derived.index)
            out[f"{name}_status"] = pd.Series(
                pd.Categorical([], categories=list(FUNDAMENTAL_STATUSES)),
                index=derived.index,
            )
        out.attrs.update(derivation_version=DERIVATION_VERSION)
        return out

    cols = set(derived.columns)

    def _get_view(view: str) -> tuple[np.ndarray, list[str], np.ndarray, list[str]]:
        v_col, s_col, a_col, p_col, c_col = (
            f"{view}_value",
            f"{view}_status",
            f"{view}_age_days",
            f"{view}_period_end",
            f"{view}_currency",
        )
        if v_col not in cols or s_col not in cols:
            return (
                np.full(n, np.nan, dtype="float64"),
                ["metric_missing"] * n,
                np.full(n, np.nan, dtype="float64"),
                [""] * n,
            )
        vals = derived[v_col].to_numpy(dtype="float64", copy=False)
        sts = [
            "metric_missing" if pd.isna(x) or not x else str(x)
            for x in derived[s_col].tolist()
        ]
        if p_col in cols:
            pe_ords = np.array(
                [
                    float(d.toordinal())
                    if (d := _parse_iso_date(x)) is not None
                    else np.nan
                    for x in derived[p_col].tolist()
                ],
                dtype="float64",
            )
        elif a_col in cols:
            # Negate age_days so relative period differences match period_end ordinals.
            pe_ords = -derived[a_col].to_numpy(dtype="float64", copy=False)
        else:
            pe_ords = np.full(n, np.nan, dtype="float64")
        ccys = (
            ["" if pd.isna(x) or not x else str(x) for x in derived[c_col].tolist()]
            if c_col in cols
            else [""] * n
        )
        return vals, sts, pe_ords, ccys

    cache: dict[str, tuple[np.ndarray, list[str], np.ndarray, list[str]]] = {}

    def view_data(view: str) -> tuple[np.ndarray, list[str], np.ndarray, list[str]]:
        if view not in cache:
            cache[view] = _get_view(view)
        return cache[view]

    def _ratio(num_view: str, den_view: str) -> tuple[np.ndarray, pd.Categorical]:
        nv, ns, np_ord, nc = view_data(num_view)
        dv, ds, dp_ord, dc = view_data(den_view)
        vals = np.full(n, np.nan, dtype="float64")
        statuses: list[str] = []
        for i in range(n):
            if ns[i] not in {"ok", "approximate"}:
                statuses.append(ns[i])
                continue
            if ds[i] not in {"ok", "approximate"}:
                statuses.append(ds[i])
                continue
            if not (np.isfinite(nv[i]) and np.isfinite(dv[i])):
                statuses.append("invalid_value")
                continue
            if not (np.isfinite(np_ord[i]) and np.isfinite(dp_ord[i])) or (
                abs(np_ord[i] - dp_ord[i]) > 7.0
            ):
                statuses.append("period_mismatch")
                continue
            if nc[i] and dc[i] and nc[i] != dc[i]:
                statuses.append("unit_unavailable")
                continue
            if dv[i] <= 0.0:
                statuses.append("invalid_value")
                continue
            res = nv[i] / dv[i]
            if not np.isfinite(res):
                statuses.append("invalid_value")
                continue
            vals[i] = res
            statuses.append("approximate" if "approximate" in {ns[i], ds[i]} else "ok")
        return vals, pd.Categorical(statuses, categories=list(FUNDAMENTAL_STATUSES))

    def _accruals() -> tuple[np.ndarray, pd.Categorical]:
        niv, nis, nip, nic = view_data("net_income_ttm")
        ocfv, ocfs, ocfp, ocfc = view_data("operating_cash_flow_ttm")
        tav, tas, tap, tac = view_data("total_assets_i")
        vals = np.full(n, np.nan, dtype="float64")
        statuses: list[str] = []
        for i in range(n):
            bad = next(
                (
                    s
                    for s in (nis[i], ocfs[i], tas[i])
                    if s not in {"ok", "approximate"}
                ),
                None,
            )
            if bad is not None:
                statuses.append(bad)
                continue
            if not (
                np.isfinite(niv[i]) and np.isfinite(ocfv[i]) and np.isfinite(tav[i])
            ):
                statuses.append("invalid_value")
                continue
            pts = (nip[i], ocfp[i], tap[i])
            if not all(np.isfinite(p) for p in pts) or (max(pts) - min(pts) > 7.0):
                statuses.append("period_mismatch")
                continue
            ccys = {c for c in (nic[i], ocfc[i], tac[i]) if c}
            if len(ccys) > 1:
                statuses.append("unit_unavailable")
                continue
            if tav[i] <= 0.0:
                statuses.append("invalid_value")
                continue
            res = (niv[i] - ocfv[i]) / tav[i]
            if not np.isfinite(res):
                statuses.append("invalid_value")
                continue
            vals[i] = res
            statuses.append(
                "approximate" if "approximate" in {nis[i], ocfs[i], tas[i]} else "ok"
            )
        return vals, pd.Categorical(statuses, categories=list(FUNDAMENTAL_STATUSES))

    def _passthrough(view: str) -> tuple[np.ndarray, pd.Categorical]:
        vv, vs, _, _ = view_data(view)
        vals = np.full(n, np.nan, dtype="float64")
        statuses: list[str] = []
        for i in range(n):
            if vs[i] not in {"ok", "approximate"}:
                statuses.append(vs[i])
                continue
            if not np.isfinite(vv[i]):
                statuses.append("invalid_value")
                continue
            vals[i] = vv[i]
            statuses.append(vs[i])
        return vals, pd.Categorical(statuses, categories=list(FUNDAMENTAL_STATUSES))

    computed: dict[str, tuple[np.ndarray, pd.Categorical]] = {
        "gross_margin_ttm": _ratio("gross_profit_ttm", "revenue_ttm"),
        "operating_margin_ttm": _ratio("operating_income_ttm", "revenue_ttm"),
        "net_margin_ttm": _ratio("net_income_ttm", "revenue_ttm"),
        "fcf_margin_ttm": _ratio("fcf_ttm", "revenue_ttm"),
        "roe_ttm": _ratio("net_income_ttm", "equity_i"),
        "roa_ttm": _ratio("net_income_ttm", "total_assets_i"),
        "gross_profitability": _ratio("gross_profit_ttm", "total_assets_i"),
        "asset_growth_1y": _passthrough("total_assets_i_yoy"),
        "accruals_ttm": _accruals(),
        "debt_to_assets": _ratio("total_debt_i", "total_assets_i"),
        "current_ratio": _ratio("assets_current_i", "liabilities_current_i"),
    }

    factor_cols: dict[str, Any] = {}
    for name in FACTOR_NAMES:
        f_val, f_st = computed[name]
        factor_cols[f"{name}_value"] = f_val
        factor_cols[f"{name}_status"] = f_st

    result = pd.concat(
        [out, pd.DataFrame(factor_cols, index=derived.index)],
        axis=1,
    )
    result.attrs.update(
        derivation_version=DERIVATION_VERSION,
        parameters=dict(derived.attrs.get("parameters", {})),
    )
    return result
