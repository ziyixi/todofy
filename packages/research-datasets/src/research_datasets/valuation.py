"""Point-in-time issuer and security market value, split adjustments, and valuation ratios."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

import numpy as np
import pandas as pd

from . import candidates as _candidates
from . import clocks
from .concepts import FUNDAMENTAL_STATUSES, STALE_AFTER_DAYS
from .constants import KEYS
from .fundamentals_derived import (
    DERIVATION_VERSION,
    asset_at,
    cik_at,
    derived_fundamentals,
    fundamental_states,
)

VALUATION_NAMES: tuple[str, ...] = (
    "market_cap_issuer",
    "market_cap_security",
    "log_market_cap",
    "book_to_market",
    "earnings_yield",
    "sales_yield",
    "cfo_yield",
    "fcf_yield",
    "dividend_yield",
    "net_payout_yield",
    "enterprise_value",
    "ev_to_sales",
    "ev_to_ebit",
    "net_issuance_1y",
)

VALUATION_LIMITATION = (
    "Unlisted share classes in share_classes are converted one-for-one at the "
    "primary listed class price in issuer market value (flagged approximate)."
)

_VALUATION_REQUIRED_VIEWS: tuple[str, ...] = (
    "shares_outstanding_i",
    "shares_weighted_basic_q",
    "equity_i",
    "net_income_ttm",
    "revenue_ttm",
    "operating_cash_flow_ttm",
    "fcf_ttm",
    "dividends_paid_ttm",
    "repurchases_ttm",
    "stock_issuance_ttm",
    "total_debt_i",
    "minority_interest_i",
    "preferred_stock_i",
    "cash_i",
    "operating_income_ttm",
)

_DEBT_HISTORY_VIEWS: tuple[str, ...] = (
    "total_debt_i",
    "debt_current_i",
    "long_term_debt_current_i",
    "short_term_borrowings_i",
    "long_term_debt_noncurrent_i",
    "long_term_debt_i",
)

_USABLE_VAL_STATUSES = frozenset({"ok", "approximate", "split_unverified"})


def _parse_date(val: Any) -> date | None:
    if isinstance(val, pd.Timestamp):
        return None if pd.isna(val) else val.date()
    if isinstance(val, date):
        return val
    if isinstance(val, str):
        s = val.strip()
        if len(s) >= 10:
            try:
                return date.fromisoformat(s[:10])
            except ValueError:
                return None
    return None


def _norm_symbol(sym: Any) -> str:
    if sym is None or pd.isna(sym):
        return ""
    return re.sub(r"[^A-Z0-9]", "", str(sym).upper())


def _safe_positive_decimal_float(val: Any) -> float | None:
    if val is None or isinstance(val, bool):
        return None
    if isinstance(val, (int, float, np.number)):
        f = float(val)
        return f if math.isfinite(f) and f > 0.0 else None
    if isinstance(val, str):
        s = val.strip()
        if not s:
            return None
        try:
            d = Decimal(s)
            if d.is_finite() and d > 0:
                f = float(d)
                return f if math.isfinite(f) and f > 0.0 else None
        except (InvalidOperation, ValueError):
            return None
    return None


def _previous_year_date(d: date) -> date:
    try:
        return d.replace(year=d.year - 1)
    except ValueError:
        return d.replace(year=d.year - 1, day=28)


class _PriceBook:
    """Fast raw/adjusted close lookup within a bounded session gap."""

    def __init__(
        self,
        raw_df: pd.DataFrame,
        all_df: pd.DataFrame | None,
        calendar_days: Sequence[date] | None,
    ) -> None:
        self._cal = list(calendar_days) if calendar_days else []
        self._cal_pos = {d: idx for idx, d in enumerate(self._cal)}
        self._raw: dict[str, tuple[list[date], list[float]]] = {}
        self._adj_ratio: dict[str, tuple[list[date], list[float]]] = {}

        if raw_df is not None and not raw_df.empty:
            work = raw_df
            if "adjustment" in work.columns:
                work = work[work["adjustment"].astype(str) == "raw"]
            self._raw = self._build_series(work)

        if (
            all_df is not None
            and not all_df.empty
            and raw_df is not None
            and not raw_df.empty
        ):
            adj_work = all_df
            if "adjustment" in adj_work.columns:
                adj_work = adj_work[adj_work["adjustment"].astype(str) == "all"]
            adj_map = self._build_series(adj_work)
            for aid, (r_days, r_closes) in self._raw.items():
                if aid not in adj_map:
                    continue
                a_days, a_closes = adj_map[aid]
                a_lookup = dict(zip(a_days, a_closes))
                ratio_days: list[date] = []
                ratios: list[float] = []
                for d, rc in zip(r_days, r_closes):
                    ac = a_lookup.get(d)
                    if ac is not None and rc > 0.0 and ac > 0.0:
                        ratio_days.append(d)
                        ratios.append(ac / rc)
                if ratio_days:
                    self._adj_ratio[aid] = (ratio_days, ratios)

    @staticmethod
    def _build_series(
        df: pd.DataFrame,
    ) -> dict[str, tuple[list[date], list[float]]]:
        result: dict[str, list[tuple[date, float]]] = {}
        if df.empty or not {"asset_id", "date", "close"}.issubset(df.columns):
            return {}
        aids = df["asset_id"].astype(str).tolist()
        dates = df["date"].tolist()
        closes = df["close"].tolist()
        for aid, d_raw, c_raw in zip(aids, dates, closes):
            d = _parse_date(d_raw)
            if d is None or c_raw is None:
                continue
            try:
                c = float(c_raw)
            except (TypeError, ValueError):
                continue
            if math.isfinite(c) and c > 0.0:
                result.setdefault(aid, []).append((d, c))
        out: dict[str, tuple[list[date], list[float]]] = {}
        for aid, pairs in result.items():
            pairs.sort(key=lambda item: item[0])
            dedup_d: list[date] = []
            dedup_c: list[float] = []
            for d, c in pairs:
                if dedup_d and dedup_d[-1] == d:
                    dedup_c[-1] = c
                else:
                    dedup_d.append(d)
                    dedup_c.append(c)
            out[aid] = (dedup_d, dedup_c)
        return out

    def raw_close_at(
        self, asset_id: str, session: date, max_lag_sessions: int = 5
    ) -> tuple[float | None, date | None]:
        series = self._raw.get(asset_id)
        if not series:
            return None, None
        days, closes = series
        import bisect

        idx = bisect.bisect_right(days, session) - 1
        if idx < 0:
            return None, None
        found_day = days[idx]
        if self._cal_pos and session in self._cal_pos and found_day in self._cal_pos:
            if self._cal_pos[session] - self._cal_pos[found_day] > max_lag_sessions:
                return None, None
        elif (session - found_day).days > max_lag_sessions + 4:
            return None, None
        return closes[idx], found_day

    def adj_over_raw_near(self, asset_id: str, target: date) -> float | None:
        series = self._adj_ratio.get(asset_id)
        if not series:
            return None
        days, ratios = series
        import bisect

        idx = bisect.bisect_right(days, target) - 1
        if idx >= 0:
            if (target - days[idx]).days <= 10:
                return ratios[idx]
            return None
        # Target slightly precedes first bar (e.g. Dec 31 before Jan 2 session)
        if days and (days[0] - target).days <= 7:
            return ratios[0]
        return None


class _SplitAdjuster:
    """Cumulative split ratio (new/old) over ``(ref_date, signal_session]``."""

    def __init__(
        self,
        *,
        mode: str,
        events_by_asset: dict[str, list[tuple[date, float, bool]]],
        split_index_by_asset: dict[str, tuple[list[date], list[float]]],
        price_book: _PriceBook,
    ) -> None:
        self.mode = mode
        self._events = events_by_asset
        self._split_index = split_index_by_asset
        self._prices = price_book

    def factor(
        self, asset_id: str, ref_date: date | None, signal_session: date
    ) -> tuple[float, bool, str]:
        """Return ``(factor, unverified_flag, basis)``."""
        if ref_date is None or ref_date >= signal_session:
            basis = self.mode if self.mode != "vendor_bars" else "none"
            return 1.0, False, basis

        if self.mode in {"explicit", "structured"}:
            items = self._events.get(asset_id, [])
            prod = 1.0
            unverified = False
            for ex_d, ratio, disputed in items:
                if ref_date < ex_d <= signal_session:
                    prod *= ratio
                    if disputed:
                        unverified = True
            return prod, unverified, self.mode

        if self.mode == "daily_returns":
            series = self._split_index.get(asset_id)
            if not series:
                return 1.0, False, "daily_returns"
            days, vals = series
            import bisect

            i_sig = bisect.bisect_right(days, signal_session) - 1
            i_ref = bisect.bisect_right(days, ref_date) - 1
            if i_ref < 0 and days and (days[0] - ref_date).days <= 7:
                i_ref = 0
            if i_sig >= 0 and i_ref >= 0 and vals[i_ref] > 0.0:
                return vals[i_sig] / vals[i_ref], False, "daily_returns"
            return 1.0, False, "daily_returns"

        # Fallback: infer large discontinuities from all/raw bars
        r_sig = self._prices.adj_over_raw_near(asset_id, signal_session)
        r_ref = self._prices.adj_over_raw_near(asset_id, ref_date)
        if r_sig is not None and r_ref is not None and r_ref > 0.0:
            change = r_sig / r_ref
            if math.isfinite(change) and change > 0.0 and not (0.8 <= change <= 1.25):
                return change, True, "vendor_bars"
        return 1.0, False, "none"


@dataclass(frozen=True)
class _CoverClassRow:
    accession: str
    as_of_date: date
    ref_date: date
    available_ns: int
    class_member: str
    trading_symbol: str
    shares: float


def _build_split_adjuster(
    version_or_material: Any,
    asset_ids: list[str],
    price_book: _PriceBook,
    split_events: pd.DataFrame | None,
) -> _SplitAdjuster:
    if split_events is not None:
        ev_map: dict[str, list[tuple[date, float, bool]]] = {}
        if not split_events.empty:
            date_col = next(
                (
                    c
                    for c in ("ex_date", "effect_date", "date")
                    if c in split_events.columns
                ),
                None,
            )
            ratio_col = next(
                (
                    c
                    for c in ("ratio_new_per_old", "split_ratio", "ratio")
                    if c in split_events.columns
                ),
                None,
            )
            if (
                date_col is not None
                and ratio_col is not None
                and "asset_id" in split_events.columns
            ):
                for rec in split_events.to_dict("records"):
                    aid = str(rec.get("asset_id") or "")
                    d = _parse_date(rec.get(date_col))
                    r = _safe_positive_decimal_float(rec.get(ratio_col))
                    st = str(rec.get("status") or "")
                    if aid and d is not None and r is not None:
                        ev_map.setdefault(aid, []).append(
                            (d, r, st in {"disputed", "unverified"})
                        )
        return _SplitAdjuster(
            mode="explicit",
            events_by_asset=ev_map,
            split_index_by_asset={},
            price_book=price_book,
        )

    has_ca = False
    ca_df = pd.DataFrame()
    has_dr = False
    dr_df = pd.DataFrame()

    if isinstance(version_or_material, Mapping):
        families = version_or_material.get("manifest", {}).get("data_families") or {}
        if (
            "corporate_actions" in version_or_material
            or "corporate_actions" in families
        ):
            has_ca = True
            raw_ca = version_or_material.get("corporate_actions")
            ca_df = (
                raw_ca
                if isinstance(raw_ca, pd.DataFrame)
                else pd.DataFrame(raw_ca or [])
            )
        elif "daily_returns" in version_or_material or "daily_returns" in families:
            has_dr = True
            raw_dr = version_or_material.get("daily_returns")
            dr_df = (
                raw_dr
                if isinstance(raw_dr, pd.DataFrame)
                else pd.DataFrame(raw_dr or [])
            )
    else:
        families = version_or_material.manifest.get("data_families") or {}
        if isinstance(families, Mapping) and "corporate_actions" in families:
            has_ca = True
            ca_df = (
                version_or_material.corporate_actions(asset_ids)
                if asset_ids
                else pd.DataFrame()
            )
        elif isinstance(families, Mapping) and "daily_returns" in families:
            has_dr = True
            dr_df = (
                version_or_material.total_returns(asset_ids)
                if asset_ids
                else pd.DataFrame()
            )

    if has_ca:
        ev_map = {}
        if not ca_df.empty and "asset_id" in ca_df.columns:
            # Deduplicate observation chains if present
            work = ca_df
            id_col = (
                "action_uid"
                if "action_uid" in work.columns
                else ("action_id" if "action_id" in work.columns else None)
            )
            if id_col is not None and "observation_sequence" in work.columns:
                role_cols = (
                    [id_col, "asset_id", "role"]
                    if "role" in work.columns
                    else [id_col, "asset_id"]
                )
                work = work.sort_values("observation_sequence").drop_duplicates(
                    role_cols, keep="last"
                )
            if "is_retracted" in work.columns:
                work = work[~work["is_retracted"].fillna(False).astype(bool)]
            if "status" in work.columns:
                work = work[work["status"].astype(str) != "withdrawn"]
            date_col = next(
                (c for c in ("effect_date", "ex_date", "date") if c in work.columns),
                None,
            )
            ratio_col = next(
                (
                    c
                    for c in ("split_ratio", "ratio_new_per_old", "ratio")
                    if c in work.columns
                ),
                None,
            )
            if date_col is not None and ratio_col is not None:
                for rec in work.to_dict("records"):
                    role = str(rec.get("role") or "subject")
                    if role != "subject":
                        continue
                    kind = str(
                        rec.get("type")
                        or rec.get("action_type")
                        or rec.get("kind")
                        or ""
                    ).lower()
                    if kind and kind not in {
                        "split",
                        "forward_split",
                        "reverse_split",
                        "stock_dividend",
                    }:
                        continue
                    r = _safe_positive_decimal_float(rec.get(ratio_col))
                    st = str(rec.get("status") or "")
                    unverified = st in {"disputed", "unverified"}
                    unknown_ratio = False
                    if kind == "stock_dividend":
                        rate = _safe_positive_decimal_float(rec.get("rate"))
                        is_legacy = str(rec.get("normalizer_version")) == "actions-v1"
                        unknown_ratio = r is None or (
                            is_legacy and (rate is None or rate >= 1.0)
                        )
                    if unknown_ratio:
                        # A v1 freeze lacks the terms needed to verify a multiplier.
                        r = 1.0
                        unverified = True
                    elif r is None or r == 1.0:
                        continue
                    aid = str(rec.get("asset_id") or "")
                    d = _parse_date(rec.get(date_col))
                    if aid and d is not None:
                        ev_map.setdefault(aid, []).append((d, r, unverified))
        return _SplitAdjuster(
            mode="structured",
            events_by_asset=ev_map,
            split_index_by_asset={},
            price_book=price_book,
        )

    if (
        has_dr
        and not dr_df.empty
        and {"asset_id", "date", "split_index"}.issubset(dr_df.columns)
    ):
        si_map: dict[str, list[tuple[date, float]]] = {}
        work = dr_df
        if "row_kind" in work.columns:
            work = work[work["row_kind"].astype(str) != "terminal"]
        for rec in work.to_dict("records"):
            aid = str(rec.get("asset_id") or "")
            d = _parse_date(rec.get("date"))
            si = _safe_positive_decimal_float(rec.get("split_index"))
            if aid and d is not None and si is not None:
                si_map.setdefault(aid, []).append((d, si))
        indexed: dict[str, tuple[list[date], list[float]]] = {}
        for aid, pairs in si_map.items():
            pairs.sort(key=lambda item: item[0])
            indexed[aid] = ([p[0] for p in pairs], [p[1] for p in pairs])
        return _SplitAdjuster(
            mode="daily_returns",
            events_by_asset={},
            split_index_by_asset=indexed,
            price_book=price_book,
        )

    return _SplitAdjuster(
        mode="vendor_bars",
        events_by_asset={},
        split_index_by_asset={},
        price_book=price_book,
    )


def _load_share_classes(
    version_or_material: Any,
    mapped_assets: list[str],
    mapped_ciks: set[str],
    time_policy: str,
) -> dict[str, list[_CoverClassRow]]:
    if not mapped_ciks:
        return {}
    sc_df = pd.DataFrame()
    zones: Mapping[str, str] = {}
    if isinstance(version_or_material, Mapping):
        zones = version_or_material.get("manifest", {}).get("source_timezones") or {}
        raw_sc = version_or_material.get("share_classes")
        if raw_sc is not None:
            sc_df = raw_sc if isinstance(raw_sc, pd.DataFrame) else pd.DataFrame(raw_sc)
    else:
        zones = version_or_material.manifest.get("source_timezones") or {}
        families = version_or_material.manifest.get("data_families") or {}
        if (
            isinstance(families, Mapping)
            and "share_classes" in families
            and mapped_assets
        ):
            sc_df = version_or_material.share_classes(mapped_assets)

    if sc_df.empty or "cik" not in sc_df.columns:
        return {}

    work = sc_df.copy()
    if "source" not in work.columns:
        work["source"] = "sec"
    if "public_time_precision" not in work.columns:
        work["public_time_precision"] = "second"
    if "public_date" not in work.columns:
        work["public_date"] = (
            work["filed"]
            if "filed" in work.columns
            else work["public_at"].astype(str).str.slice(0, 10)
        )

    pub_ns, invalid = clocks.public_clocks(work, zones)
    obs_ns = (
        clocks.instants(work["observed_at"].to_numpy(dtype=object))
        if "observed_at" in work.columns
        else pub_ns
    )
    avail_ns = clocks.available_at(pub_ns, invalid, time_policy, (obs_ns,))

    # Deduplicate observation chains per class_fact_id
    chains: dict[tuple[str, str], tuple[int, dict[str, Any], int]] = {}
    for idx, rec in enumerate(work.to_dict("records")):
        if bool(invalid[idx]) or int(avail_ns[idx]) == clocks.NAT:
            continue
        cik_raw = str(rec.get("cik") or "").strip()
        if not cik_raw or not cik_raw.isdigit():
            continue
        cik = cik_raw.zfill(10)
        if cik not in mapped_ciks:
            continue
        seq_raw = rec.get("observation_sequence", 1)
        seq = int(seq_raw) if isinstance(seq_raw, (int, np.integer)) else 1
        cfid = str(
            rec.get("class_fact_id")
            or f"{rec.get('accession', '')}|{rec.get('as_of_date', '')}|{rec.get('class_member', '')}|{idx}"
        )
        key = (cik, cfid)
        prev = chains.get(key)
        if prev is None or seq >= prev[0]:
            chains[key] = (seq, rec, int(avail_ns[idx]))

    by_cik: dict[str, list[_CoverClassRow]] = {}
    for (cik, _), (_, rec, av_ns) in chains.items():
        if bool(rec.get("is_retracted", False)):
            continue
        shares = _safe_positive_decimal_float(rec.get("value"))
        as_of = _parse_date(rec.get("as_of_date")) or _parse_date(rec.get("filed"))
        acc = str(rec.get("accession") or "").strip()
        if shares is None or as_of is None or not acc:
            continue
        member = str(rec.get("class_member") or "").strip()
        sym = str(rec.get("trading_symbol") or "").strip()
        by_cik.setdefault(cik, []).append(
            _CoverClassRow(
                accession=acc,
                as_of_date=as_of,
                ref_date=as_of,
                available_ns=av_ns,
                class_member=member,
                trading_symbol=sym,
                shares=shares,
            )
        )

    for rows in by_cik.values():
        rows.sort(key=lambda r: (r.as_of_date, r.available_ns, r.accession))
    return by_cik


def _resolve_normalized_symbol_at(
    version_or_material: Any,
    raw_symbol: str,
    session: date,
    uni_records: list[Mapping[str, Any]],
    sym_hist_records: list[Mapping[str, Any]],
) -> str | None:
    if not raw_symbol:
        return None
    direct = asset_at(version_or_material, raw_symbol, session)
    if direct is not None:
        return direct
    target = _norm_symbol(raw_symbol)
    if not target:
        return None
    matches: list[str] = []
    for row in sym_hist_records:
        if _norm_symbol(row.get("symbol")) != target:
            continue
        vf = _parse_date(row.get("valid_from"))
        vt = _parse_date(row.get("valid_to"))
        if (vf is None or vf <= session) and (vt is None or vt >= session):
            aid = str(row.get("asset_id") or "")
            if aid:
                matches.append(aid)
    unique = list(dict.fromkeys(matches))
    if len(unique) == 1:
        return unique[0]
    uni_matches = [
        str(r.get("asset_id") or "")
        for r in uni_records
        if _norm_symbol(r.get("symbol")) == target and r.get("asset_id")
    ]
    uni_unique = list(dict.fromkeys(uni_matches))
    return uni_unique[0] if len(uni_unique) == 1 else None


def _select_cover_accession(
    rows: list[_CoverClassRow],
    decision_ns: int,
    time_policy: str,
    target_as_of: date | None = None,
    tolerance_days: int = 30,
) -> list[_CoverClassRow] | None:
    visible = [r for r in rows if r.available_ns <= decision_ns]
    if not visible:
        return None

    # Build carry-back symbol map for class_member -> trading_symbol
    symbol_source = rows if time_policy == "public_reconstructed" else visible
    carry_symbol: dict[str, str] = {}
    for r in symbol_source:
        if r.class_member and r.trading_symbol:
            carry_symbol[r.class_member] = r.trading_symbol

    by_acc: dict[str, list[_CoverClassRow]] = {}
    for r in visible:
        sym = r.trading_symbol or carry_symbol.get(r.class_member, "")
        enriched = (
            r
            if sym == r.trading_symbol
            else _CoverClassRow(
                accession=r.accession,
                as_of_date=r.as_of_date,
                ref_date=r.ref_date,
                available_ns=r.available_ns,
                class_member=r.class_member,
                trading_symbol=sym,
                shares=r.shares,
            )
        )
        by_acc.setdefault(r.accession, []).append(enriched)

    candidates: list[tuple[tuple[Any, ...], list[_CoverClassRow]]] = []
    for acc, acc_rows in by_acc.items():
        max_asof = max(r.as_of_date for r in acc_rows)
        max_avail = max(r.available_ns for r in acc_rows)
        if target_as_of is not None:
            diff = abs((max_asof - target_as_of).days)
            if diff > tolerance_days:
                continue
            key: tuple[Any, ...] = (-diff, max_asof, max_avail, acc)
        else:
            key = (max_asof, max_avail, acc)
        dimensional = [r for r in acc_rows if r.class_member]
        chosen = dimensional if dimensional else acc_rows
        candidates.append((key, chosen))

    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0])
    return candidates[-1][1]


def _convert_currency(
    val: float,
    ccy: str,
    session: date,
    fx_lookup: dict[tuple[str, date], float] | None,
) -> tuple[float | None, bool]:
    if not ccy or ccy == "USD":
        return val, True
    if fx_lookup:
        rate = fx_lookup.get((ccy, session))
        if rate is not None and math.isfinite(rate) and rate > 0.0:
            return val * rate, True
    return None, False


def valuation(
    version_or_material: Any,
    samples: pd.DataFrame,
    derived: pd.DataFrame | None = None,
    *,
    time_policy: str,
    prices: pd.DataFrame | None = None,
    split_events: pd.DataFrame | None = None,
    fx: pd.DataFrame | None = None,
    provenance: bool = False,
) -> pd.DataFrame:
    """Compute point-in-time market values, enterprise value, and valuation yields."""
    clocks.policy(time_policy)
    if not set(KEYS + ["decision_at"]).issubset(samples.columns):
        if (
            set(KEYS).issubset(samples.columns)
            and not isinstance(version_or_material, Mapping)
            and hasattr(version_or_material, "calendar")
        ):
            samples = _candidates.ensure_samples(version_or_material, samples)
        else:
            raise ValueError("Samples require candidate KEYS and decision_at")

    n = len(samples)
    out = samples[KEYS].copy()
    if n == 0:
        for name in VALUATION_NAMES:
            out[f"{name}_value"] = pd.Series(dtype="float64", index=samples.index)
            out[f"{name}_status"] = pd.Series(
                pd.Categorical([], categories=list(FUNDAMENTAL_STATUSES)),
                index=samples.index,
            )
        if provenance:
            for col, dt in (
                ("market_cap_issuer_basis", "object"),
                ("market_cap_security_basis", "object"),
                ("valuation_price_raw", "float64"),
                ("valuation_price_session", "object"),
                ("valuation_split_factor", "float64"),
                ("valuation_split_basis", "object"),
                ("valuation_shares_reference_date", "object"),
            ):
                out[col] = pd.Series(dtype=dt, index=samples.index)
        out.attrs.update(
            parameters={"time_policy": time_policy, "provenance": provenance},
            derivation_version=DERIVATION_VERSION,
            limitations=[VALUATION_LIMITATION],
        )
        return out

    # Ensure required derived views + provenance columns (period_end, currency, reference_date)
    need_derived = derived is None or not all(
        f"{v}_value" in derived.columns
        and f"{v}_status" in derived.columns
        and f"{v}_period_end" in derived.columns
        and f"{v}_currency" in derived.columns
        and f"{v}_reference_date" in derived.columns
        for v in _VALUATION_REQUIRED_VIEWS
    )
    full_derived = (
        derived_fundamentals(
            version_or_material,
            samples,
            time_policy=time_policy,
            views=_VALUATION_REQUIRED_VIEWS,
            provenance=True,
        )
        if need_derived
        else derived
    )
    assert full_derived is not None

    # If caller passed a custom derived frame with overridden statuses (e.g. custom stale_after_days),
    # respect caller's _value and _status columns where present.
    def _col_values(
        view: str,
    ) -> tuple[
        np.ndarray,
        list[str],
        list[date | None],
        list[str],
        list[date | None],
        list[str],
    ]:
        src_val = (
            derived
            if derived is not None and f"{view}_value" in derived.columns
            else full_derived
        )
        src_st = (
            derived
            if derived is not None and f"{view}_status" in derived.columns
            else full_derived
        )
        vals = src_val[f"{view}_value"].to_numpy(dtype="float64", copy=False)
        sts = [
            "metric_missing" if pd.isna(x) or not x else str(x)
            for x in src_st[f"{view}_status"].tolist()
        ]
        pes = [_parse_date(x) for x in full_derived[f"{view}_period_end"].tolist()]
        ccys = [
            "" if pd.isna(x) or not x else str(x)
            for x in full_derived[f"{view}_currency"].tolist()
        ]
        refs = [_parse_date(x) for x in full_derived[f"{view}_reference_date"].tolist()]
        bases = [
            "" if pd.isna(x) or not x else str(x)
            for x in full_derived[f"{view}_basis"].tolist()
        ]
        return vals, sts, pes, ccys, refs, bases

    # Universe, symbol_history, and sibling securities per CIK
    if isinstance(version_or_material, Mapping):
        manifest = version_or_material.get("manifest", {})
        raw_uni = version_or_material.get("universe", [])
        uni_records = (
            raw_uni.to_dict("records")
            if isinstance(raw_uni, pd.DataFrame)
            else list(raw_uni)
        )
        raw_sh = version_or_material.get("symbol_history")
        sh_records = (
            raw_sh.to_dict("records")
            if isinstance(raw_sh, pd.DataFrame)
            else list(raw_sh or [])
        )
        cal_raw = version_or_material.get("calendar") or manifest.get("calendar") or []
    else:
        manifest = version_or_material.manifest
        uni_records = _candidates.records(version_or_material.universe)
        families = manifest.get("data_families") or {}
        sh_records = (
            version_or_material.family("symbol_history").to_dict("records")
            if isinstance(families, Mapping) and "symbol_history" in families
            else []
        )
        cal_raw = manifest.get("calendar") or []

    cal_days = [d for item in cal_raw if (d := _parse_date(item)) is not None]

    asset_list = samples["asset_id"].astype(str).tolist()
    signal_days = [clocks.day(v) for v in samples["signal_session"].tolist()]
    decision_ns = clocks.instants(samples["decision_at"].to_numpy(dtype=object))
    sample_ciks = cik_at(version_or_material, asset_list, signal_days).tolist()
    mapped_ciks = sorted({c for c in sample_ciks if c})

    # Find all securities belonging to mapped_ciks so dual-class share sums have all sibling prices
    sibling_assets_by_cik: dict[str, list[str]] = {}
    symbol_by_asset: dict[str, str] = {}
    sh_windows_by_asset: dict[str, list[tuple[date | None, date | None]]] = {}
    for row in sh_records:
        aid = str(row.get("asset_id") or "")
        if aid:
            sh_windows_by_asset.setdefault(aid, []).append(
                (_parse_date(row.get("valid_from")), _parse_date(row.get("valid_to")))
            )

    for row in uni_records:
        aid = str(row.get("asset_id") or "")
        if not aid:
            continue
        symbol_by_asset[aid] = str(row.get("symbol") or "")
        cik_raw = str(row.get("cik") or "").strip()
        if (
            row.get("issuer_mapping_status") == "verified"
            and cik_raw.isdigit()
            and cik_raw.zfill(10) in set(mapped_ciks)
        ):
            sibling_assets_by_cik.setdefault(cik_raw.zfill(10), []).append(aid)

    # Also include any sample asset mapped via issuer_history
    for aid, c in zip(asset_list, sample_ciks):
        if c:
            existing = sibling_assets_by_cik.setdefault(c, [])
            if aid not in existing:
                existing.append(aid)

    for c, aids in sibling_assets_by_cik.items():
        aids.sort(key=lambda a: (symbol_by_asset.get(a, "~"), a))

    all_needed_assets = list(
        dict.fromkeys(
            [
                *asset_list,
                *(a for aids in sibling_assets_by_cik.values() for a in aids),
            ]
        )
    )

    # Load raw (and adjusted if needed for vendor split fallback) prices
    all_df: pd.DataFrame | None = None
    if prices is not None:
        raw_df = prices
        if "adjustment" in prices.columns:
            all_df = prices[prices["adjustment"].astype(str) == "all"]
    elif isinstance(version_or_material, Mapping):
        r_obj = version_or_material.get("raw")
        raw_df = r_obj if isinstance(r_obj, pd.DataFrame) else pd.DataFrame(r_obj or [])
        a_obj = version_or_material.get("all")
        all_df = a_obj if isinstance(a_obj, pd.DataFrame) else pd.DataFrame(a_obj or [])
    else:
        raw_df = (
            version_or_material.prices(all_needed_assets, adjusted=False)
            if all_needed_assets
            else pd.DataFrame()
        )
        families = manifest.get("data_families") or {}
        if (
            split_events is None
            and "corporate_actions" not in families
            and "daily_returns" not in families
            and all_needed_assets
        ):
            all_df = version_or_material.prices(all_needed_assets, adjusted=True)

    price_book = _PriceBook(raw_df, all_df, cal_days)
    split_adj = _build_split_adjuster(
        version_or_material, all_needed_assets, price_book, split_events
    )

    mapped_assets_for_family = list(
        dict.fromkeys(a for aids in sibling_assets_by_cik.values() for a in aids)
    )
    cover_by_cik = _load_share_classes(
        version_or_material, mapped_assets_for_family, set(mapped_ciks), time_policy
    )

    # Load historical share states & debt reporting history from fundamental_states
    hist_states = (
        fundamental_states(
            version_or_material,
            time_policy=time_policy,
            ciks=mapped_ciks,
            views=("shares_outstanding_i", *_DEBT_HISTORY_VIEWS),
        )
        if mapped_ciks
        else pd.DataFrame()
    )
    first_debt_ns_by_cik: dict[str, int] = {}
    share_states_by_cik: dict[str, list[tuple[int, date, date, float, str]]] = {}
    if not hist_states.empty:
        av_ns_col = clocks.instants(hist_states["available_at"].to_numpy(dtype=object))
        for idx, rec in enumerate(hist_states.to_dict("records")):
            c = str(rec.get("cik") or "")
            v = str(rec.get("view") or "")
            st = str(rec.get("status") or "")
            av_ns = int(av_ns_col[idx])
            if st not in {"ok", "approximate"} or av_ns == clocks.NAT:
                continue
            if v in _DEBT_HISTORY_VIEWS:
                prev_ns = first_debt_ns_by_cik.get(c)
                if prev_ns is None or av_ns < prev_ns:
                    first_debt_ns_by_cik[c] = av_ns
            elif v == "shares_outstanding_i":
                pe = _parse_date(rec.get("period_end"))
                rf = _parse_date(rec.get("reference_date")) or pe
                val_f = float(rec.get("value", np.nan))
                bs = str(rec.get("basis") or "")
                if (
                    pe is not None
                    and rf is not None
                    and math.isfinite(val_f)
                    and val_f > 0
                ):
                    share_states_by_cik.setdefault(c, []).append(
                        (av_ns, pe, rf, val_f, bs)
                    )
        for entries in share_states_by_cik.values():
            entries.sort(key=lambda item: item[0])

    # Optional FX lookup
    fx_lookup: dict[tuple[str, date], float] | None = None
    if fx is not None and not fx.empty:
        fx_lookup = {}
        d_col = "date" if "date" in fx.columns else "session"
        r_col = "rate_to_usd" if "rate_to_usd" in fx.columns else "rate"
        if {"currency", d_col, r_col}.issubset(fx.columns):
            for rec in fx.to_dict("records"):
                ccy = str(rec.get("currency") or "").upper()
                d = _parse_date(rec.get(d_col))
                r = _safe_positive_decimal_float(rec.get(r_col))
                if ccy and d is not None and r is not None:
                    fx_lookup[(ccy, d)] = r

    # Pre-extract statement views
    sh_i_v, sh_i_s, sh_i_pe, _, sh_i_ref, sh_i_basis = _col_values(
        "shares_outstanding_i"
    )
    sh_q_v, sh_q_s, sh_q_pe, _, sh_q_ref, _ = _col_values("shares_weighted_basic_q")
    eq_v, eq_s, _, eq_c, _, _ = _col_values("equity_i")
    ni_v, ni_s, _, ni_c, _, _ = _col_values("net_income_ttm")
    rev_v, rev_s, rev_pe, rev_c, _, _ = _col_values("revenue_ttm")
    ocf_v, ocf_s, _, ocf_c, _, _ = _col_values("operating_cash_flow_ttm")
    fcf_v, fcf_s, _, fcf_c, _, _ = _col_values("fcf_ttm")
    div_v, div_s, div_pe, div_c, _, _ = _col_values("dividends_paid_ttm")
    rep_v, rep_s, rep_pe, rep_c, _, _ = _col_values("repurchases_ttm")
    iss_v, iss_s, iss_pe, iss_c, _, _ = _col_values("stock_issuance_ttm")
    debt_v, debt_s, debt_pe, debt_c, _, _ = _col_values("total_debt_i")
    mi_v, mi_s, mi_pe, mi_c, _, _ = _col_values("minority_interest_i")
    pref_v, pref_s, pref_pe, pref_c, _, _ = _col_values("preferred_stock_i")
    cash_v, cash_s, cash_pe, cash_c, _, _ = _col_values("cash_i")
    ebit_v, ebit_s, ebit_pe, ebit_c, _, _ = _col_values("operating_income_ttm")

    stale_i_limit = int(STALE_AFTER_DAYS.get("i", 200))

    def _active_siblings(cik: str, session: date) -> list[str]:
        aids = sibling_assets_by_cik.get(cik, [])
        if len(aids) <= 1:
            return aids
        active: list[str] = []
        for a in aids:
            wins = sh_windows_by_asset.get(a)
            if not wins or any(
                (vf is None or vf <= session) and (vt is None or vt >= session)
                for vf, vt in wins
            ):
                active.append(a)
        return active if active else aids

    # Arrays for all outputs
    out_vals: dict[str, np.ndarray] = {
        name: np.full(n, np.nan, dtype="float64") for name in VALUATION_NAMES
    }
    out_sts: dict[str, list[str]] = {name: [] for name in VALUATION_NAMES}

    prov_issuer_basis: list[str | None] = [None] * n
    prov_sec_basis: list[str | None] = [None] * n
    prov_price_raw = np.full(n, np.nan, dtype="float64")
    prov_price_session: list[date | None] = [None] * n
    prov_split_factor = np.full(n, np.nan, dtype="float64")
    prov_split_basis: list[str | None] = [None] * n
    prov_ref_date: list[date | None] = [None] * n

    def _combine_status(*statuses: str) -> str:
        if "split_unverified" in statuses:
            return "split_unverified"
        if "approximate" in statuses:
            return "approximate"
        return "ok"

    def _yield_metric(
        num_val: float,
        num_st: str,
        num_ccy: str,
        mcap_val: float,
        mcap_st: str,
        session_d: date,
    ) -> tuple[float, str]:
        if mcap_st not in _USABLE_VAL_STATUSES:
            return np.nan, mcap_st
        if num_st not in {"ok", "approximate"}:
            return np.nan, num_st
        if not (math.isfinite(num_val) and math.isfinite(mcap_val) and mcap_val > 0.0):
            return np.nan, "invalid_value"
        conv, ok_fx = _convert_currency(num_val, num_ccy, session_d, fx_lookup)
        if not ok_fx or conv is None:
            return np.nan, "fx_unavailable"
        res = conv / mcap_val
        if not math.isfinite(res):
            return np.nan, "invalid_value"
        return res, _combine_status(mcap_st, num_st)

    for i in range(n):
        aid = asset_list[i]
        sig = signal_days[i]
        d_ns = int(decision_ns[i])
        cik = sample_ciks[i]

        px_self, px_day_self = price_book.raw_close_at(aid, sig)
        if px_self is not None:
            prov_price_raw[i] = px_self
            prov_price_session[i] = px_day_self

        # Base identity / check guard
        base_diag = sh_i_s[i]
        if not cik or base_diag in {"mapping_missing", "issuer_not_sec_filer"}:
            st_fail = (
                base_diag
                if base_diag in {"mapping_missing", "issuer_not_sec_filer"}
                else "mapping_missing"
            )
            for name in VALUATION_NAMES:
                out_sts[name].append(st_fail)
            continue
        if d_ns == clocks.NAT:
            for name in VALUATION_NAMES:
                out_sts[name].append("invalid_value")
            continue

        # 1. Compute market_cap_issuer, market_cap_security, and current split-adjusted issuer shares
        mcap_iss = np.nan
        mcap_iss_st = "shares_unavailable"
        mcap_sec = np.nan
        mcap_sec_st = "shares_unavailable"
        cur_shares_adj: float | None = None
        cur_shares_asof: date | None = None
        used_cover_classes = False

        cover_rows = _select_cover_accession(
            cover_by_cik.get(cik, []), d_ns, time_policy
        )
        active_sibs = _active_siblings(cik, sig)

        if cover_rows:
            used_cover_classes = True
            # Map each class row to an asset_id if listed
            mapped_classes: list[tuple[_CoverClassRow, str | None]] = []
            for cr in cover_rows:
                c_aid = _resolve_normalized_symbol_at(
                    version_or_material,
                    cr.trading_symbol,
                    sig,
                    uni_records,
                    sh_records,
                )
                # Single-security issuer with non-dimensional cover row maps to its sole security
                if c_aid is None and not cr.class_member and len(active_sibs) == 1:
                    c_aid = active_sibs[0]
                mapped_classes.append((cr, c_aid))

            listed = [(cr, c_aid) for cr, c_aid in mapped_classes if c_aid is not None]
            unlisted = [cr for cr, c_aid in mapped_classes if c_aid is None]

            if not listed:
                # Fallback to primary active security if only one listed security exists
                prim_aid = active_sibs[0] if active_sibs else aid
                px_p, _ = price_book.raw_close_at(prim_aid, sig)
                if px_p is None:
                    mcap_iss_st = "price_unavailable"
                    mcap_sec_st = "price_unavailable"
                else:
                    total_val = 0.0
                    total_sh = 0.0
                    any_unver = False
                    max_age = max((sig - cr.as_of_date).days for cr in cover_rows)
                    for cr in cover_rows:
                        f_c, unv_c, sb_c = split_adj.factor(prim_aid, cr.ref_date, sig)
                        any_unver = any_unver or unv_c
                        total_sh += cr.shares * f_c
                        total_val += cr.shares * f_c * px_p
                        prov_split_factor[i] = f_c
                        prov_split_basis[i] = sb_c
                        prov_ref_date[i] = cr.ref_date
                    if max_age > stale_i_limit:
                        mcap_iss_st = "stale"
                        mcap_sec_st = (
                            "stale"
                            if len(active_sibs) <= 1
                            else "class_shares_unavailable"
                        )
                    else:
                        mcap_iss = total_val
                        cur_shares_adj = total_sh
                        cur_shares_asof = max(cr.as_of_date for cr in cover_rows)
                        mcap_iss_st = (
                            "split_unverified"
                            if any_unver
                            else ("approximate" if len(cover_rows) > 1 else "ok")
                        )
                        prov_issuer_basis[i] = "class_sum"
                        if len(active_sibs) <= 1:
                            mcap_sec = total_val
                            mcap_sec_st = mcap_iss_st
                            prov_sec_basis[i] = "single_security"
                        else:
                            mcap_sec_st = "class_shares_unavailable"
            else:
                # Choose deterministic issuer-level primary listed class (Class A first, else largest shares)
                listed_sorted = sorted(
                    listed,
                    key=lambda pair: (
                        0 if "CLASSA" in _norm_symbol(pair[0].class_member) else 1,
                        -pair[0].shares,
                        pair[1] or "",
                    ),
                )
                primary_aid = listed_sorted[0][1]
                assert primary_aid is not None

                missing_px = False
                total_val = 0.0
                total_sh = 0.0
                any_unver = False
                sec_val_acc = 0.0
                sec_matched = False
                sec_unver = False

                for cr, c_aid in listed:
                    assert c_aid is not None
                    px_c, _ = price_book.raw_close_at(c_aid, sig)
                    if px_c is None:
                        missing_px = True
                        break
                    f_c, unv_c, sb_c = split_adj.factor(c_aid, cr.ref_date, sig)
                    any_unver = any_unver or unv_c
                    total_sh += cr.shares * f_c
                    total_val += cr.shares * f_c * px_c
                    if c_aid == aid:
                        sec_matched = True
                        sec_val_acc += cr.shares * f_c * px_c
                        sec_unver = sec_unver or unv_c
                        prov_split_factor[i] = f_c
                        prov_split_basis[i] = sb_c
                        prov_ref_date[i] = cr.ref_date

                px_prim, _ = price_book.raw_close_at(primary_aid, sig)
                if px_prim is None:
                    missing_px = True
                elif not missing_px:
                    for cr in unlisted:
                        f_u, unv_u, _ = split_adj.factor(primary_aid, cr.ref_date, sig)
                        any_unver = any_unver or unv_u
                        total_sh += cr.shares * f_u
                        total_val += cr.shares * f_u * px_prim

                max_age = max((sig - cr.as_of_date).days for cr in cover_rows)
                if missing_px:
                    mcap_iss_st = "price_unavailable"
                    mcap_sec_st = "price_unavailable"
                elif max_age > stale_i_limit:
                    mcap_iss_st = "stale"
                    mcap_sec_st = "stale"
                else:
                    mcap_iss = total_val
                    cur_shares_adj = total_sh
                    cur_shares_asof = max(cr.as_of_date for cr in cover_rows)
                    prov_issuer_basis[i] = "class_sum"
                    if any_unver:
                        mcap_iss_st = "split_unverified"
                    elif unlisted:
                        mcap_iss_st = "approximate"
                    else:
                        mcap_iss_st = "ok"

                    if sec_matched:
                        mcap_sec = sec_val_acc
                        mcap_sec_st = "split_unverified" if sec_unver else "ok"
                        prov_sec_basis[i] = "class_shares"
                    elif len(active_sibs) <= 1 and not unlisted:
                        mcap_sec = mcap_iss
                        mcap_sec_st = mcap_iss_st
                        prov_sec_basis[i] = "single_security"
                    else:
                        mcap_sec_st = (
                            "price_unavailable"
                            if px_self is None
                            else "class_shares_unavailable"
                        )
        else:
            # No share_classes rows -> use shares_outstanding_i, else shares_weighted_basic_q (approximate)
            prim_aid = active_sibs[0] if active_sibs else aid
            px_iss, _ = price_book.raw_close_at(prim_aid, sig)
            if px_iss is None or px_self is None:
                mcap_iss_st = (
                    "price_unavailable" if px_iss is None else "shares_unavailable"
                )
                mcap_sec_st = (
                    "price_unavailable"
                    if px_self is None
                    else (
                        "class_shares_unavailable"
                        if len(active_sibs) > 1
                        else mcap_iss_st
                    )
                )
            if px_iss is not None:
                sh_val: float | None = None
                sh_ref: date | None = None
                sh_pe: date | None = None
                sh_approx = False
                sh_basis_label = ""
                if (
                    sh_i_s[i] in {"ok", "approximate"}
                    and math.isfinite(sh_i_v[i])
                    and sh_i_v[i] > 0
                ):
                    sh_val = float(sh_i_v[i])
                    sh_ref = sh_i_ref[i] or sh_i_pe[i]
                    sh_pe = sh_i_pe[i]
                    sh_approx = sh_i_s[i] == "approximate"
                    sh_basis_label = sh_i_basis[i] or "shares_outstanding"
                elif (
                    sh_i_s[i]
                    in {
                        "metric_missing",
                        "not_captured",
                        "not_yet_available",
                        "period_unavailable",
                    }
                    and sh_q_s[i] in {"ok", "approximate"}
                    and math.isfinite(sh_q_v[i])
                    and sh_q_v[i] > 0
                ):
                    sh_val = float(sh_q_v[i])
                    sh_ref = sh_q_ref[i] or sh_q_pe[i]
                    sh_pe = sh_q_pe[i]
                    sh_approx = True
                    sh_basis_label = "weighted_basic"

                if sh_val is not None:
                    f_iss, unv_iss, sb_iss = split_adj.factor(prim_aid, sh_ref, sig)
                    prov_split_factor[i] = f_iss
                    prov_split_basis[i] = sb_iss
                    prov_ref_date[i] = sh_ref
                    cur_shares_adj = sh_val * f_iss
                    cur_shares_asof = sh_pe
                    mcap_iss = cur_shares_adj * px_iss
                    prov_issuer_basis[i] = sh_basis_label
                    mcap_iss_st = (
                        "split_unverified"
                        if unv_iss
                        else ("approximate" if sh_approx else "ok")
                    )
                    if len(active_sibs) <= 1:
                        if px_self is not None:
                            f_sec, unv_sec, _ = split_adj.factor(aid, sh_ref, sig)
                            mcap_sec = sh_val * f_sec * px_self
                            mcap_sec_st = (
                                "split_unverified"
                                if unv_sec
                                else ("approximate" if sh_approx else "ok")
                            )
                            prov_sec_basis[i] = "single_security"
                        else:
                            mcap_sec_st = "price_unavailable"
                    else:
                        mcap_sec_st = "class_shares_unavailable"
                else:
                    fail_st = (
                        "shares_unavailable"
                        if sh_i_s[i]
                        in {"metric_missing", "not_captured", "period_unavailable"}
                        else sh_i_s[i]
                    )
                    mcap_iss_st = fail_st
                    mcap_sec_st = (
                        "class_shares_unavailable"
                        if len(active_sibs) > 1 and fail_st == "shares_unavailable"
                        else fail_st
                    )

        out_vals["market_cap_issuer"][i] = mcap_iss
        out_sts["market_cap_issuer"].append(mcap_iss_st)
        out_vals["market_cap_security"][i] = mcap_sec
        out_sts["market_cap_security"].append(mcap_sec_st)

        # 2. log_market_cap
        if (
            mcap_iss_st in _USABLE_VAL_STATUSES
            and math.isfinite(mcap_iss)
            and mcap_iss > 0.0
        ):
            out_vals["log_market_cap"][i] = math.log(mcap_iss)
            out_sts["log_market_cap"].append(mcap_iss_st)
        else:
            out_sts["log_market_cap"].append(
                mcap_iss_st
                if mcap_iss_st not in _USABLE_VAL_STATUSES
                else "invalid_value"
            )

        # 3. Direct yields over market_cap_issuer
        for out_name, v_arr, s_arr, c_arr in (
            ("book_to_market", eq_v, eq_s, eq_c),
            ("earnings_yield", ni_v, ni_s, ni_c),
            ("sales_yield", rev_v, rev_s, rev_c),
            ("cfo_yield", ocf_v, ocf_s, ocf_c),
            ("fcf_yield", fcf_v, fcf_s, fcf_c),
            ("dividend_yield", div_v, div_s, div_c),
        ):
            yv, ys = _yield_metric(
                float(v_arr[i]), s_arr[i], c_arr[i], mcap_iss, mcap_iss_st, sig
            )
            out_vals[out_name][i] = yv
            out_sts[out_name].append(ys)

        # 4. net_payout_yield = (dividends_paid + repurchases - stock_issuance)_ttm / market_cap_issuer
        if mcap_iss_st not in _USABLE_VAL_STATUSES:
            out_sts["net_payout_yield"].append(mcap_iss_st)
        else:
            legs = [
                (float(div_v[i]), div_s[i], div_pe[i], div_c[i], 1.0),
                (float(rep_v[i]), rep_s[i], rep_pe[i], rep_c[i], 1.0),
                (float(iss_v[i]), iss_s[i], iss_pe[i], iss_c[i], -1.0),
            ]
            bad_leg = next(
                (
                    st_l
                    for _, st_l, _, _, _ in legs
                    if st_l
                    not in {
                        "ok",
                        "approximate",
                        "metric_missing",
                        "not_captured",
                    }
                ),
                None,
            )
            present_legs = [leg for leg in legs if leg[1] in {"ok", "approximate"}]
            if bad_leg is not None:
                out_sts["net_payout_yield"].append(bad_leg)
            elif not present_legs:
                out_sts["net_payout_yield"].append(div_s[i])
            else:
                pes_present = [leg[2] for leg in present_legs if leg[2] is not None]
                if (
                    len(pes_present) != len(present_legs)
                    or (max(pes_present) - min(pes_present)).days > 7
                ):
                    out_sts["net_payout_yield"].append("period_mismatch")
                else:
                    payout_usd = 0.0
                    fx_ok_all = True
                    for val_l, _, _, ccy_l, sign_l in present_legs:
                        conv_l, ok_l = _convert_currency(val_l, ccy_l, sig, fx_lookup)
                        if not ok_l or conv_l is None:
                            fx_ok_all = False
                            break
                        payout_usd += sign_l * conv_l
                    if not fx_ok_all:
                        out_sts["net_payout_yield"].append("fx_unavailable")
                    elif mcap_iss <= 0.0:
                        out_sts["net_payout_yield"].append("invalid_value")
                    else:
                        npy = payout_usd / mcap_iss
                        leg_approx = len(present_legs) < 3 or any(
                            leg[1] == "approximate" for leg in present_legs
                        )
                        out_vals["net_payout_yield"][i] = npy
                        out_sts["net_payout_yield"].append(
                            _combine_status(
                                mcap_iss_st, "approximate" if leg_approx else "ok"
                            )
                        )

        # 5. enterprise_value = market_cap_issuer + total_debt + minority_interest + preferred_stock - cash
        ev_val = np.nan
        ev_st = mcap_iss_st
        ev_bs_pe: date | None = None
        if mcap_iss_st not in _USABLE_VAL_STATUSES:
            ev_st = mcap_iss_st
        elif cash_s[i] not in {"ok", "approximate"}:
            ev_st = cash_s[i]
        else:
            cash_pe_i = cash_pe[i]
            ev_bs_pe = cash_pe_i
            cash_usd, ok_cash = _convert_currency(
                float(cash_v[i]), cash_c[i], sig, fx_lookup
            )
            if not ok_cash or cash_usd is None:
                ev_st = "fx_unavailable"
            elif cash_pe_i is None:
                ev_st = "period_mismatch"
            else:
                # Resolve total_debt (0 + approximate if issuer never reported any debt concept)
                debt_usd: float | None = None
                debt_approx = False
                debt_err: str | None = None
                if debt_s[i] in {"ok", "approximate"}:
                    if debt_pe[i] is None or abs((debt_pe[i] - cash_pe_i).days) > 7:
                        debt_err = "period_mismatch"
                    else:
                        d_conv, d_ok = _convert_currency(
                            float(debt_v[i]), debt_c[i], sig, fx_lookup
                        )
                        if not d_ok or d_conv is None:
                            debt_err = "fx_unavailable"
                        else:
                            debt_usd = d_conv
                            debt_approx = debt_s[i] == "approximate"
                elif debt_s[i] in {
                    "metric_missing",
                    "not_captured",
                    "not_yet_available",
                }:
                    first_debt = first_debt_ns_by_cik.get(cik)
                    if first_debt is None or first_debt > d_ns:
                        debt_usd = 0.0
                        debt_approx = True
                    else:
                        debt_err = debt_s[i]
                else:
                    debt_err = debt_s[i]

                # Optional minority_interest and preferred_stock (0 when absent)
                opt_sum = 0.0
                opt_approx = False
                for opt_v_arr, opt_s_arr, opt_pe_arr, opt_c_arr in (
                    (mi_v, mi_s, mi_pe, mi_c),
                    (pref_v, pref_s, pref_pe, pref_c),
                ):
                    if debt_err is not None:
                        break
                    ost = opt_s_arr[i]
                    if ost in {"ok", "approximate"}:
                        ope = opt_pe_arr[i]
                        if ope is None or abs((ope - cash_pe_i).days) > 7:
                            debt_err = "period_mismatch"
                            break
                        oc, ook = _convert_currency(
                            float(opt_v_arr[i]), opt_c_arr[i], sig, fx_lookup
                        )
                        if not ook or oc is None:
                            debt_err = "fx_unavailable"
                            break
                        opt_sum += oc
                        opt_approx = opt_approx or (ost == "approximate")
                    elif ost in {"metric_missing", "not_captured", "not_yet_available"}:
                        continue
                    else:
                        debt_err = ost
                        break

                if debt_err is not None or debt_usd is None:
                    ev_st = debt_err or "metric_missing"
                else:
                    ev_candidate = mcap_iss + debt_usd + opt_sum - cash_usd
                    if math.isfinite(ev_candidate):
                        ev_val = ev_candidate
                        ev_st = _combine_status(
                            mcap_iss_st,
                            cash_s[i],
                            "approximate" if (debt_approx or opt_approx) else "ok",
                        )
                    else:
                        ev_st = "invalid_value"

        out_vals["enterprise_value"][i] = ev_val
        out_sts["enterprise_value"].append(ev_st)

        # 6. ev_to_sales and ev_to_ebit
        for out_name, den_v_arr, den_s_arr, den_pe_arr, den_c_arr in (
            ("ev_to_sales", rev_v, rev_s, rev_pe, rev_c),
            ("ev_to_ebit", ebit_v, ebit_s, ebit_pe, ebit_c),
        ):
            if ev_st not in _USABLE_VAL_STATUSES:
                out_sts[out_name].append(ev_st)
                continue
            dst = den_s_arr[i]
            if dst not in {"ok", "approximate"}:
                out_sts[out_name].append(dst)
                continue
            dpe = den_pe_arr[i]
            if ev_bs_pe is None or dpe is None or abs((dpe - ev_bs_pe).days) > 7:
                out_sts[out_name].append("period_mismatch")
                continue
            d_usd, d_ok = _convert_currency(
                float(den_v_arr[i]), den_c_arr[i], sig, fx_lookup
            )
            if not d_ok or d_usd is None:
                out_sts[out_name].append("fx_unavailable")
                continue
            if ev_val <= 0.0 or d_usd <= 0.0:
                out_sts[out_name].append("invalid_value")
                continue
            ratio_val = ev_val / d_usd
            if not math.isfinite(ratio_val):
                out_sts[out_name].append("invalid_value")
                continue
            out_vals[out_name][i] = ratio_val
            out_sts[out_name].append(_combine_status(ev_st, dst))

        # 7. net_issuance_1y (split-adjusted shares now vs one year earlier)
        if cur_shares_adj is None or cur_shares_asof is None or cur_shares_adj <= 0.0:
            out_sts["net_issuance_1y"].append(
                mcap_iss_st
                if mcap_iss_st not in _USABLE_VAL_STATUSES
                else "shares_unavailable"
            )
        else:
            target_prev = _previous_year_date(cur_shares_asof)
            prior_adj: float | None = None
            prior_unver = False

            if used_cover_classes:
                prior_cover = _select_cover_accession(
                    cover_by_cik.get(cik, []),
                    d_ns,
                    time_policy,
                    target_as_of=target_prev,
                    tolerance_days=30,
                )
                if prior_cover:
                    prim_aid = active_sibs[0] if active_sibs else aid
                    tot_p = 0.0
                    for pcr in prior_cover:
                        p_aid = (
                            _resolve_normalized_symbol_at(
                                version_or_material,
                                pcr.trading_symbol,
                                sig,
                                uni_records,
                                sh_records,
                            )
                            or prim_aid
                        )
                        f_p, unv_p, _ = split_adj.factor(p_aid, pcr.ref_date, sig)
                        prior_unver = prior_unver or unv_p
                        tot_p += pcr.shares * f_p
                    if tot_p > 0.0:
                        prior_adj = tot_p

            if prior_adj is None:
                # Look up shares_outstanding_i state history up to decision_ns
                prim_aid = active_sibs[0] if active_sibs else aid
                vis_sh = [
                    entry
                    for entry in share_states_by_cik.get(cik, [])
                    if entry[0] <= d_ns
                    and entry[1] < cur_shares_asof - timedelta(days=300)
                ]
                # Latest visible entry per period_end
                by_pe: dict[date, tuple[int, date, date, float, str]] = {}
                for entry in vis_sh:
                    by_pe[entry[1]] = entry
                best_entry: tuple[int, date, date, float, str] | None = None
                best_diff = 999
                for pe_cand, entry in by_pe.items():
                    tol = 30 if (entry[4] == "cover" or sh_i_basis[i] == "cover") else 7
                    diff = abs((pe_cand - target_prev).days)
                    if diff <= tol and diff < best_diff:
                        best_diff = diff
                        best_entry = entry
                if best_entry is not None:
                    _, _, rf_p, val_p, _ = best_entry
                    f_p, unv_p, _ = split_adj.factor(prim_aid, rf_p, sig)
                    prior_unver = prior_unver or unv_p
                    prior_adj = val_p * f_p

            if prior_adj is None:
                out_sts["net_issuance_1y"].append("prior_unavailable")
            elif prior_adj <= 0.0:
                out_sts["net_issuance_1y"].append("invalid_value")
            else:
                ni_1y = cur_shares_adj / prior_adj - 1.0
                if math.isfinite(ni_1y):
                    out_vals["net_issuance_1y"][i] = ni_1y
                    st_ni = (
                        "split_unverified"
                        if (prior_unver or mcap_iss_st == "split_unverified")
                        else ("approximate" if mcap_iss_st == "approximate" else "ok")
                    )
                    out_sts["net_issuance_1y"].append(st_ni)
                else:
                    out_sts["net_issuance_1y"].append("invalid_value")

    cols_dict: dict[str, Any] = {}
    for name in VALUATION_NAMES:
        cols_dict[f"{name}_value"] = out_vals[name]
        cols_dict[f"{name}_status"] = pd.Categorical(
            out_sts[name], categories=list(FUNDAMENTAL_STATUSES)
        )
    if provenance:
        cols_dict["market_cap_issuer_basis"] = pd.Series(
            prov_issuer_basis, index=samples.index, dtype="object"
        )
        cols_dict["market_cap_security_basis"] = pd.Series(
            prov_sec_basis, index=samples.index, dtype="object"
        )
        cols_dict["valuation_price_raw"] = prov_price_raw
        cols_dict["valuation_price_session"] = pd.Series(
            prov_price_session, index=samples.index, dtype="object"
        )
        cols_dict["valuation_split_factor"] = prov_split_factor
        cols_dict["valuation_split_basis"] = pd.Series(
            prov_split_basis, index=samples.index, dtype="object"
        )
        cols_dict["valuation_shares_reference_date"] = pd.Series(
            prov_ref_date, index=samples.index, dtype="object"
        )

    result = pd.concat([out, pd.DataFrame(cols_dict, index=samples.index)], axis=1)
    result.attrs.update(
        parameters={"time_policy": time_policy, "provenance": provenance},
        derivation_version=DERIVATION_VERSION,
        limitations=[VALUATION_LIMITATION],
    )
    return result
