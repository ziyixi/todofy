"""Point-in-time derived financial statement states and single-quarter derivations."""

from __future__ import annotations

from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
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
    SYNTHETIC_METRIC_TO_CONCEPT,
    TAG_RANKS,
    CompositeSpec,
    Concept,
    parse_view_name,
    required_base_concepts,
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

_SDK5_SUFFIXES = frozenset({"q", "fy", "i"})


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


class IssuerStateMachine:
    """Pure-Python point-in-time state machine for one CIK."""

    def __init__(
        self,
        cik: str,
        *,
        target_views: Sequence[str] | None = None,
    ) -> None:
        self.cik = cik
        if target_views is None:
            views_list: list[str] = []
            for name, spec in ALL_CONCEPTS.items():
                if spec.kind == "instant":
                    views_list.append(f"{name}_i")
                else:
                    views_list.extend([f"{name}_q", f"{name}_fy"])
            self.target_views = tuple(views_list)
        else:
            self.target_views = tuple(dict.fromkeys(target_views))

        self._parsed_views: list[tuple[str, str, str]] = [
            (v, *parse_view_name(v)) for v in self.target_views
        ]
        self.current: dict[str, FactVersion] = {}
        self.by_period: dict[tuple[str, date | None, date], set[str]] = {}
        self.last_emitted: dict[str, tuple[Any, ...]] = {}
        self.rows: list[dict[str, Any]] = []

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

        for v in self.current.values():
            if v.period_start is None:
                continue
            pair = (v.period_start, v.period_end)
            duration_periods.add(pair)
            days = _inclusive_days(v.period_start, v.period_end)
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
        for qs, _ in sorted(set(q3m_periods)):
            if not any(-3 <= (qs - s).days <= 349 for s in fy_starts):
                fy_starts.append(qs)
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

            slots_list.append(_FiscalYearSlots(s, e1, e2, e3, e4))

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
        ) -> PeriodValue | None:
            assert (
                cur_ytd.period_start is not None and prev_ytd.period_start is not None
            )
            if abs((cur_ytd.period_start - prev_ytd.period_start).days) > 3:
                return None
            d_start = prev_ytd.period_end + timedelta(days=1)
            d_end = cur_ytd.period_end
            if not (77 <= _inclusive_days(d_start, d_end) <= 105):
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
            if q3 is not None:
                result[(s, 3)] = q3

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
            if q4 is not None:
                result[(s, 4)] = q4

        return result

    def _refresh_views(self, batch_clock: int) -> None:
        has_nci = self._has_nonzero_nci()

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

        needed_quarters = {
            c_name for _, c_name, suffix in self._parsed_views if suffix == "q"
        }
        # Ensure base leg quarters exist when fcf_q or ebitda_q is requested.
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
                            comp_q[q_key] = PeriodValue(
                                status="ok",
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

        for view_name, c_name, suffix in self._parsed_views:
            chosen = self._select_view_state(
                c_name,
                suffix,
                concept_periods.get(c_name, {}),
                quarters_by_concept.get(c_name, {}),
                fy_periods,
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
        fy_periods: set[tuple[date, date]],
    ) -> PeriodValue | None:
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

        return None


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
    if wanted_ciks is not None and not wanted_ciks:
        return manifest, []
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
) -> pd.DataFrame:
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
    )
    return frame


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
        base_needed = required_base_concepts(list(target_views))
    elif concepts is not None:
        expanded = list(dict.fromkeys(concepts))
        target_views_list: list[str] = []
        for item in expanded:
            if item in ALL_CONCEPTS:
                spec = ALL_CONCEPTS[item]
                if spec.kind == "instant":
                    target_views_list.append(f"{item}_i")
                else:
                    target_views_list.extend([f"{item}_q", f"{item}_fy"])
            else:
                parse_view_name(item)
                target_views_list.append(item)
        target_views = tuple(dict.fromkeys(target_views_list))
        base_needed = required_base_concepts(list(target_views))
    else:
        target_views = None
        base_needed = None

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
    by_cik_buffer: dict[str, list[FactVersion]] = {}

    for chunk in frames:
        if chunk is None or chunk.empty:
            continue
        versions, stats = normalize_facts(
            chunk,
            time_policy=time_policy,
            source_timezones=zones,
            concepts=base_needed,
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

    limitations = list(manifest.get("limitations", [])) + [
        "Derived fundamentals (single quarters) are computed from as-filed XBRL facts.",
    ]
    return _format_state_frame(
        all_rows,
        time_policy=time_policy,
        stats=totals,
        limitations=limitations,
    )


def derived_fundamentals(
    version_or_material: Any,
    samples: pd.DataFrame,
    *,
    time_policy: str,
    views: Sequence[str] | None = None,
    provenance: bool = False,
) -> pd.DataFrame:
    """Join derived point-in-time fundamental views onto ``samples`` at ``decision_at``."""
    clocks.policy(time_policy)
    if not set(KEYS + ["decision_at"]).issubset(samples.columns):
        raise ValueError("Samples require candidate keys and decision_at")

    if views is None:
        selected_views = tuple(
            v for v in DEFAULT_VIEWS if parse_view_name(v)[1] in _SDK5_SUFFIXES
        )
    else:
        selected_views = tuple(dict.fromkeys(views))
        for v in selected_views:
            _, suffix = parse_view_name(v)
            if suffix not in _SDK5_SUFFIXES:
                raise ValueError(f"View {v!r} is not supported in this build")

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
        out.attrs.update(
            parameters={
                "views": list(selected_views),
                "time_policy": time_policy,
                "provenance": provenance,
            },
            derivation_version=DERIVATION_VERSION,
        )
        return out

    asset_list = samples["asset_id"].astype(str).tolist()
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

    decision_ns = clocks.instants(samples["decision_at"].to_numpy(dtype=object))
    valid_decision = decision_ns != clocks.NAT

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
    ]
    ciks_with_view: dict[str, set[str]] = {}
    if not states.empty:
        for view_name, grp in states.groupby("view", observed=True):
            ciks_with_view[str(view_name)] = set(grp["cik"].astype(str))

    new_cols: dict[str, Any] = {}
    for view in selected_views:
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
            st = raw_status[i]
            if pd.isna(st) or not st:
                vals[i] = np.nan
                final_status.append(
                    "not_yet_available" if cik in known_ciks else "metric_missing"
                )
                continue
            pe = _parse_iso_date(p_ends[i])
            if pe is not None:
                ages[i] = float((signal_days[i] - pe).days)
            final_status.append(str(st))

        new_cols[f"{view}_value"] = vals
        new_cols[f"{view}_status"] = pd.Categorical(
            final_status, categories=list(FUNDAMENTAL_STATUSES)
        )
        new_cols[f"{view}_age_days"] = ages
        if provenance:
            new_cols[f"{view}_period_end"] = (
                joined["period_end"].astype(object).to_numpy()
            )
            new_cols[f"{view}_available_at"] = pd.to_datetime(
                joined["available_at"], utc=True
            ).to_numpy()
            new_cols[f"{view}_basis"] = joined["basis"].astype(object).to_numpy()
            new_cols[f"{view}_accessions"] = (
                joined["accessions"].astype(object).to_numpy()
            )
            new_cols[f"{view}_tag"] = joined["tag"].astype(object).to_numpy()
            new_cols[f"{view}_currency"] = joined["currency"].astype(object).to_numpy()

    result = pd.concat(
        [out, pd.DataFrame(new_cols, index=samples.index)],
        axis=1,
    )
    result.attrs.update(
        parameters={
            "views": list(selected_views),
            "time_policy": time_policy,
            "provenance": provenance,
        },
        derivation_version=DERIVATION_VERSION,
        dropped_counts=dict(states.attrs.get("dropped_counts", {})),
        limitations=list(states.attrs.get("limitations", [])),
    )
    return result
