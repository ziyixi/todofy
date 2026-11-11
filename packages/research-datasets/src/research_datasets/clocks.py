"""Calendar, decision instants and public clocks: one 06:00 New York rule for history and live use.

A row (asset, signal session T) is decided at 06:00 New York on its entry session t and
sees what was public at or before that instant. Instants are UTC; vectorized helpers use
int64 nanoseconds with ``NAT`` for a missing clock.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from datetime import date, datetime, time, timedelta
from functools import lru_cache
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from .constants import (
    CAPTURE_GRACE,
    DECISION_TIME,
    LABEL_CLOSE_TIME,
    LABEL_OPEN_TIME,
    NEW_YORK_ZONE,
    POLICIES,
    SEC_DISSEMINATION_START,
    SOURCE_CONTRACTS,
)

NEW_YORK = ZoneInfo(NEW_YORK_ZONE)
NAT = np.iinfo(np.int64).min  # int64 view of NaT; earlier than every instant
NEVER = np.iinfo(np.int64).max  # later than every instant
GRACE_NS = int(CAPTURE_GRACE / timedelta(microseconds=1)) * 1000
CAPTURE_DEADLINE = (
    datetime.combine(date(2000, 1, 3), DECISION_TIME) + CAPTURE_GRACE
).time()
_ISO_INSTANT = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$"
)
_EPOCH_ORDINAL = date(1970, 1, 1).toordinal()
_DAY_NS = 86_400_000_000_000


@lru_cache(maxsize=65536)
def day_str(value: str) -> date:
    return date.fromisoformat(value[:10])


def day(value: Any) -> date:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    return day_str(str(value))


@lru_cache(maxsize=131072)
def _clock_str(value: str) -> pd.Timestamp | None:
    try:
        parsed = pd.Timestamp(value)
    except (TypeError, ValueError):
        return None
    if pd.isna(parsed) or parsed.tzinfo is None:
        return None
    return parsed.tz_convert("UTC")


def clock(value: Any) -> pd.Timestamp | None:
    """Only offset-bearing timestamps establish an instant."""
    if value is None or value is pd.NaT:
        return None
    if isinstance(value, str):
        return _clock_str(value) if value else None
    if pd.isna(value):
        return None
    if isinstance(value, pd.Timestamp):
        if value.tzinfo is None:
            return None
        return value.tz_convert("UTC")
    return _clock_str(str(value))


@lru_cache(maxsize=16384)
def at(value: date, hour: int, minute: int = 0) -> pd.Timestamp:
    """A New York wall time on a date, as a UTC instant."""
    return pd.Timestamp(
        datetime.combine(value, time(hour, minute), NEW_YORK)
    ).tz_convert("UTC")


def decision_at(value: date) -> pd.Timestamp:
    return at(value, DECISION_TIME.hour, DECISION_TIME.minute)


def policy(time_policy: str) -> str:
    if time_policy not in POLICIES:
        raise ValueError(
            "Choose an explicit supported time policy: " + " or ".join(POLICIES)
        )
    return time_policy


def mapping(value: Any) -> dict[str, Any]:
    """An Arrow MAP cell (dict, pairs or key/value records) as a dict."""
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, (list, tuple, np.ndarray)):
        return dict(
            (item["key"], item["value"]) if isinstance(item, Mapping) else item
            for item in value
        )
    return {}


def date_field(row: Mapping[str, Any], *names: str) -> date | None:
    """The first present YYYY-MM-DD field; a malformed present value gives None."""
    for name in names:
        value = row.get(name)
        if isinstance(value, str) and value:
            try:
                return day_str(value)
            except ValueError:
                return None
    return None


def source_zone(source: str, zones: Mapping[str, str]) -> ZoneInfo:
    contract = SOURCE_CONTRACTS.get(source)
    for name in (zones.get(source), contract.timezone if contract else NEW_YORK_ZONE):
        if name:
            try:
                return ZoneInfo(name)
            except (ValueError, KeyError):
                continue
    return NEW_YORK


SEC_ACCEPTANCE_CUTOFF = time(17, 30)
NYSE_EARLY_CLOSE = "13:00"


def _observed_holiday(fixed: date) -> date:
    if fixed.weekday() == 5:
        return fixed - timedelta(days=1)
    if fixed.weekday() == 6:
        return fixed + timedelta(days=1)
    return fixed


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    first = date(year, month, 1)
    offset = (weekday - first.weekday()) % 7
    return first + timedelta(days=offset + 7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    next_month = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    last = next_month - timedelta(days=1)
    offset = (last.weekday() - weekday) % 7
    return last - timedelta(days=offset)


def _easter_sunday(year: int) -> date:
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    ell = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * ell) // 451
    month, day_num = divmod(h + ell - 7 * m + 114, 31)
    return date(year, month, day_num + 1)


@lru_cache(maxsize=256)
def us_federal_holidays(year: int) -> frozenset[date]:
    """US federal holidays (SEC EDGAR closed schedule) falling in ``year``."""
    found = {
        _nth_weekday(year, 1, 0, 3),  # Martin Luther King Jr. Day
        _nth_weekday(year, 2, 0, 3),  # Washington's Birthday
        _last_weekday(year, 5, 0),  # Memorial Day
        _observed_holiday(date(year, 7, 4)),  # Independence Day
        _nth_weekday(year, 9, 0, 1),  # Labor Day
        _nth_weekday(year, 10, 0, 2),  # Columbus Day (SEC closed, NYSE open)
        _observed_holiday(date(year, 11, 11)),  # Veterans Day (SEC closed, NYSE open)
        _nth_weekday(year, 11, 3, 4),  # Thanksgiving Day
        _observed_holiday(date(year, 12, 25)),  # Christmas Day
    }
    nyd = _observed_holiday(date(year, 1, 1))
    if nyd.year == year:
        found.add(nyd)
    next_nyd = _observed_holiday(date(year + 1, 1, 1))
    if next_nyd.year == year:
        found.add(next_nyd)
    if year >= 2021:
        found.add(_observed_holiday(date(year, 6, 19)))  # Juneteenth
    return frozenset(found)


@lru_cache(maxsize=256)
def nyse_holidays(year: int) -> frozenset[date]:
    """Regular NYSE full-day holiday closures in ``year``."""
    found = {
        _nth_weekday(year, 1, 0, 3),  # Martin Luther King Jr. Day
        _nth_weekday(year, 2, 0, 3),  # Washington's Birthday
        _easter_sunday(year) - timedelta(days=2),  # Good Friday
        _last_weekday(year, 5, 0),  # Memorial Day
        _observed_holiday(date(year, 7, 4)),  # Independence Day
        _nth_weekday(year, 9, 0, 1),  # Labor Day
        _nth_weekday(year, 11, 3, 4),  # Thanksgiving Day
        _observed_holiday(date(year, 12, 25)),  # Christmas Day
    }
    jan1 = date(year, 1, 1)
    if jan1.weekday() < 5:
        found.add(jan1)
    elif jan1.weekday() == 6:
        found.add(date(year, 1, 2))
    if year >= 2022:
        found.add(_observed_holiday(date(year, 6, 19)))  # Juneteenth
    return frozenset(found)


def nyse_early_closes(sessions: Sequence[Any]) -> dict[str, str]:
    """Standard NYSE 13:00 New York early-close sessions among ``sessions``."""
    result: dict[str, str] = {}
    for raw in sessions:
        d = day(raw)
        if d in nyse_holidays(d.year) or d.weekday() > 4:
            continue
        black_friday = _nth_weekday(d.year, 11, 3, 4) + timedelta(days=1)
        if (
            d == black_friday
            or (d.month == 7 and d.day == 3 and d.weekday() < 4)
            or (d.month == 12 and d.day == 24 and d.weekday() < 4)
        ):
            result[d.isoformat()] = NYSE_EARLY_CLOSE
    return result


def is_sec_business_day(value: date) -> bool:
    """Whether ``value`` is a weekday on which SEC EDGAR assigns same-day filings."""
    return value.weekday() < 5 and value not in us_federal_holidays(value.year)


def next_sec_business_day(value: date) -> date:
    """First SEC business day strictly after ``value``."""
    candidate = value + timedelta(days=1)
    while not is_sec_business_day(candidate):
        candidate += timedelta(days=1)
    return candidate


def sec_filing_date_from_acceptance(accepted: pd.Timestamp | str) -> date:
    """Infer SEC filing date from an acceptance timestamp using the 17:30 ET and
    US federal-holiday schedule when ``filing_date`` is absent."""
    ts = accepted if isinstance(accepted, pd.Timestamp) else clock(accepted)
    if ts is None or ts.tzinfo is None:
        raise ValueError("accepted must be an offset-bearing timestamp")
    local = ts.tz_convert(NEW_YORK)
    local_day = local.date()
    if not is_sec_business_day(local_day):
        return next_sec_business_day(local_day)
    if (local.hour, local.minute, local.second, local.microsecond) >= (
        SEC_ACCEPTANCE_CUTOFF.hour,
        SEC_ACCEPTANCE_CUTOFF.minute,
        0,
        0,
    ):
        return next_sec_business_day(local_day)
    return local_day


def sec_floor(filing_date: date) -> pd.Timestamp:
    """SEC disseminates a filing from 06:00 New York on its SEC filing date."""
    return at(filing_date, SEC_DISSEMINATION_START.hour, SEC_DISSEMINATION_START.minute)


def sec_public(accepted: pd.Timestamp, filing_date: date) -> pd.Timestamp:
    """SEC dates filings accepted after 17:30 or on non-business days to the next
    business day, so the public instant is max(acceptance, 06:00 on the filing date)."""
    return max(accepted, sec_floor(filing_date))


def sec_public_fallback(
    accepted: pd.Timestamp | str, filing_date: date | str | None = None
) -> pd.Timestamp:
    """SEC public instant using ``filing_date`` when present, else the 17:30 ET
    federal-holiday fallback rule."""
    ts = accepted if isinstance(accepted, pd.Timestamp) else clock(accepted)
    if ts is None or ts.tzinfo is None:
        raise ValueError("accepted must be an offset-bearing timestamp")
    if isinstance(filing_date, str):
        effective = (
            day_str(filing_date.strip())
            if filing_date.strip()
            else sec_filing_date_from_acceptance(ts)
        )
    elif filing_date is not None:
        effective = filing_date
    else:
        effective = sec_filing_date_from_acceptance(ts)
    return sec_public(ts, effective)


def _next_midnight(value: Any, zone: str) -> pd.Timestamp | None:
    try:
        following = day(value) + timedelta(days=1)
        return pd.Timestamp(
            datetime.combine(following, time(), ZoneInfo(zone))
        ).tz_convert("UTC")
    except (ValueError, KeyError):
        return None


def public_clock(
    row: Mapping[str, Any],
    zones: Mapping[str, str],
    *,
    holiday_fallback: bool = False,
) -> pd.Timestamp | None:
    """One row's public instant (scalar form of ``public_clocks``)."""
    precision = row.get("public_time_precision")
    if not isinstance(precision, str):
        return None
    source = str(row.get("source", ""))
    contract = SOURCE_CONTRACTS.get(source)
    if precision == "second":
        public = clock(row.get("public_at"))
        if (
            public is not None
            and contract is not None
            and contract.clock == "sec_filing"
        ):
            filed = date_field(row, "filing_date", "filed")
            if filed is not None:
                public = sec_public(public, filed)
            elif holiday_fallback:
                public = sec_public_fallback(public, None)
        return public
    if precision != "date":
        return None
    public_date = row.get("public_date")
    if public_date is None or pd.isna(public_date) or public_date == "":
        return None
    zone = zones.get(source) or (contract.timezone if contract else None)
    return _next_midnight(public_date, zone) if zone else None


# --- vectorized forms -------------------------------------------------------------


def nanos(values: Any) -> np.ndarray:
    """UTC instants (DatetimeIndex-like) as int64 nanoseconds, NaT -> NAT."""
    index = pd.DatetimeIndex(values)
    if index.tz is None:
        index = index.tz_localize("UTC")
    return index.as_unit("ns").asi8.copy()


def utc(values: np.ndarray) -> pd.DatetimeIndex:
    """int64 nanoseconds (NAT for missing) as a UTC DatetimeIndex, without parsing."""
    raw = np.asarray(values, dtype=np.int64).view("M8[ns]")
    return pd.DatetimeIndex(raw).tz_localize("UTC")


def _ns(value: pd.Timestamp | None) -> int:
    return NAT if value is None else int(value.as_unit("ns").value)


def map_unique(values: Any, function: Callable[[Any], int]) -> np.ndarray:
    """Apply a scalar int64 function once per distinct non-null value."""
    codes, uniques = pd.factorize(pd.Series(values, dtype=object))
    mapped = np.fromiter((function(value) for value in uniques), np.int64, len(uniques))
    result = np.full(len(codes), NAT, dtype=np.int64)
    known = codes >= 0
    result[known] = mapped[codes[known]]
    return result


def instants(values: Any) -> np.ndarray:
    """Offset-bearing timestamps as UTC int64 nanoseconds; anything else is NAT."""
    series = pd.Series(values)
    if isinstance(series.dtype, pd.DatetimeTZDtype):
        return nanos(series)
    if pd.api.types.is_datetime64_dtype(series.dtype):
        return np.full(len(series), NAT, dtype=np.int64)
    cells = series.to_numpy(dtype=object)
    text = np.fromiter((isinstance(value, str) for value in cells), bool, len(cells))
    fast = np.zeros(len(cells), dtype=bool)
    if text.any():
        fast[text] = pd.Series(cells[text], dtype=object).str.match(_ISO_INSTANT)
    result = np.full(len(cells), NAT, dtype=np.int64)
    if fast.any():
        result[fast] = nanos(
            pd.to_datetime(cells[fast], utc=True, format="ISO8601", errors="coerce")
        )
    slow = ~fast
    if slow.any():
        result[slow] = map_unique(cells[slow], lambda value: _ns(clock(value)))
    return result


def _first_text(frame: pd.DataFrame, names: Sequence[str]) -> np.ndarray:
    """Per row, the first column among ``names`` holding a non-empty string."""
    chosen = np.full(len(frame), None, dtype=object)
    for name in reversed(names):
        if name in frame.columns:
            cells = frame[name].to_numpy(dtype=object)
            present = np.fromiter(
                (isinstance(value, str) and value != "" for value in cells),
                bool,
                len(cells),
            )
            chosen[present] = cells[present]
    return chosen


def _day_or_none(value: Any) -> date | None:
    try:
        return day_str(value)
    except ValueError:
        return None


def date_ordinals(frame: pd.DataFrame, names: Sequence[str]) -> np.ndarray:
    """``date_field`` per row as a proleptic ordinal, 0 when absent or malformed."""

    def ordinal(value: Any) -> int:
        parsed = _day_or_none(value)
        return 0 if parsed is None else parsed.toordinal()

    result = map_unique(_first_text(frame, names), ordinal)
    result[result == NAT] = 0
    return result


def _sec_floor(value: Any) -> int:
    parsed = _day_or_none(value)
    return NAT if parsed is None else _ns(sec_floor(parsed))


def public_clocks(
    frame: pd.DataFrame,
    zones: Mapping[str, str],
    *,
    holiday_fallback: bool = False,
) -> tuple[np.ndarray, np.ndarray]:
    """Public instants (int64 ns, NAT when unknown) and invalid declared clocks per row.

    Second precision parses ``public_at`` (offset required); SEC-clock sources take
    max(acceptance, 06:00 New York on ``filing_date`` or ``filed``). Date precision is
    the next midnight in the source's zone. A declared precision whose value cannot be
    read is invalid.
    """
    rows = len(frame)
    public = np.full(rows, NAT, dtype=np.int64)
    if rows == 0 or "public_time_precision" not in frame.columns:
        return public, np.zeros(rows, dtype=bool)
    precision = frame["public_time_precision"].to_numpy(dtype=object)
    sources = (
        frame["source"].astype(str).to_numpy(dtype=object)
        if "source" in frame.columns
        else np.full(rows, "", dtype=object)
    )
    second, dated = precision == "second", precision == "date"
    if second.any() and "public_at" in frame.columns:
        public[second] = instants(frame["public_at"].to_numpy(dtype=object)[second])
        sec = second & np.isin(
            sources,
            [
                name
                for name, item in SOURCE_CONTRACTS.items()
                if item.clock == "sec_filing"
            ],
        )
        sec &= public != NAT
        if sec.any():
            filed_text = _first_text(frame.loc[sec], ("filing_date", "filed"))
            floors = map_unique(filed_text, _sec_floor)
            if holiday_fallback:
                missing_floor = floors == NAT
                if missing_floor.any():
                    sec_indices = np.flatnonzero(sec)[missing_floor]
                    public[sec_indices] = np.fromiter(
                        (
                            _ns(
                                sec_public_fallback(
                                    pd.Timestamp(int(val), tz="UTC"), None
                                )
                            )
                            for val in public[sec_indices]
                        ),
                        dtype=np.int64,
                        count=len(sec_indices),
                    )
            public[sec] = np.maximum(public[sec], floors)
    if dated.any() and "public_date" in frame.columns:
        cells = frame["public_date"].to_numpy(dtype=object)[dated]
        zone_of = {
            source: zones.get(source)
            or (
                SOURCE_CONTRACTS[source].timezone
                if source in SOURCE_CONTRACTS
                else None
            )
            for source in set(sources[dated])
        }
        pairs = [
            None
            if value is None
            or value == ""
            or (not isinstance(value, date) and pd.isna(value))
            or not zone_of[source]
            else (value, zone_of[source])
            for value, source in zip(cells, sources[dated])
        ]
        public[dated] = map_unique(
            pairs, lambda pair: _ns(_next_midnight(pair[0], pair[1]))
        )
    invalid = (second | dated) & (public == NAT)
    return public, invalid


def available_at(
    public: np.ndarray,
    invalid: np.ndarray,
    time_policy: str,
    captures: Sequence[np.ndarray] = (),
) -> np.ndarray:
    """When a row may be used: its public clock, or under observed_content
    max(public, each capture - CAPTURE_GRACE), missing when a capture is missing or a
    declared public clock is invalid."""
    if policy(time_policy) == "public_reconstructed":
        return public.copy()
    result = public.copy()
    complete = ~invalid
    for capture in captures:
        complete &= capture != NAT
        result = np.maximum(result, np.where(capture != NAT, capture - GRACE_NS, NAT))
    return np.where(complete, result, NAT)


def wall_instants(days: Sequence[date], wall: time) -> np.ndarray:
    """A New York wall time on each day as UTC int64 nanoseconds."""
    local = np.array(list(days), dtype="datetime64[D]").astype("datetime64[ns]")
    local = local + np.timedelta64(wall.hour * 60 + wall.minute, "m")
    return nanos(pd.DatetimeIndex(local).tz_localize(NEW_YORK))


def local_ordinals(values: np.ndarray, zone: ZoneInfo) -> np.ndarray:
    """Calendar dates (ordinals) of UTC int64 instants in a zone."""
    local = pd.DatetimeIndex(values.astype("datetime64[ns]"), tz="UTC").tz_convert(zone)
    return local.tz_localize(None).as_unit("ns").asi8 // _DAY_NS + _EPOCH_ORDINAL


class Calendar:
    """Frozen sessions, their 06:00 decision instants, opens and closes.

    ``closes`` maps a session to its close ("HH:MM", default 16:00). ``next_session``
    (live use) is a weekday after the last frozen session that gives the last signal a
    decision instant; it is never a signal itself.
    """

    def __init__(
        self,
        sessions: Sequence[Any],
        closes: Mapping[str, str] | None = None,
        next_session: Any = None,
        *,
        infer_early_closes: bool = False,
    ) -> None:
        self.days: list[date] = [day(value) for value in sessions]
        if not self.days or self.days != sorted(set(self.days)):
            raise ValueError(
                "Frozen calendar must contain unique ordered session dates"
            )
        self.next_session = None if next_session is None else day(next_session)
        if self.next_session is not None and (
            self.next_session <= self.days[-1] or self.next_session.weekday() > 4
        ):
            raise ValueError("next_session must be a weekday after the last session")
        self._index = {value: position for position, value in enumerate(self.days)}
        effective_closes: dict[str, str] = (
            nyse_early_closes(self.days) if infer_early_closes else {}
        )
        for key, value in (closes or {}).items():
            effective_closes[str(key)] = str(value)
        self._closes = {
            day(key): time.fromisoformat(value)
            for key, value in effective_closes.items()
        }
        following = [] if self.next_session is None else [self.next_session]
        # decisions[i] = 06:00 New York on session i; one more entry for the session
        # after the last (NAT unless next_session is known).
        self.decisions = wall_instants([*self.days, *following], DECISION_TIME)
        if not following:
            self.decisions = np.append(self.decisions, np.int64(NAT))
        # Label clocks per session: the 09:30 open and the frozen close (16:00 default).
        self.opens = wall_instants(self.days, LABEL_OPEN_TIME)
        self.closes = wall_instants(self.days, LABEL_CLOSE_TIME)
        for value, close in self._closes.items():
            if value in self._index:
                self.closes[self._index[value]] = _ns(
                    at(value, close.hour, close.minute)
                )

    def __len__(self) -> int:
        return len(self.days)

    def index(self, value: Any) -> int:
        try:
            return self._index[day(value)]
        except KeyError:
            raise ValueError(f"{value} is not a frozen session") from None

    def decision_at(self, position: int) -> pd.Timestamp:
        """06:00 New York on session ``position`` (NaT past the known sessions)."""
        value = self.decisions[position] if position < len(self.decisions) else NAT
        return pd.NaT if value == NAT else pd.Timestamp(int(value), tz="UTC")

    def capture_deadline(self, position: int) -> pd.Timestamp:
        """09:00 New York on session ``position``: the latest capture observed_content
        accepts for that decision (NaT past the known sessions)."""
        decision = self.decision_at(position)
        return decision if pd.isna(decision) else decision + CAPTURE_GRACE

    def open_at(self, position: int) -> pd.Timestamp:
        return pd.Timestamp(int(self.opens[position]), tz="UTC")

    def close_at(self, position: int) -> pd.Timestamp:
        return pd.Timestamp(int(self.closes[position]), tz="UTC")

    def positions(self, values: Any) -> np.ndarray:
        """Calendar positions of session dates (date, string or timestamp); a value
        that is not a frozen session raises."""
        codes, uniques = pd.factorize(pd.Series(values, dtype=object))
        found = np.array(
            [self._index.get(day(value), -1) for value in uniques], dtype=np.int64
        )
        if (codes < 0).any() or (found < 0).any():
            bad = "missing" if (codes < 0).any() else uniques[np.argmin(found)]
            raise ValueError(f"{bad} is not a frozen session")
        return found[codes]
