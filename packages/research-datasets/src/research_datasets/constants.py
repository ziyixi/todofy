"""Frozen research dataset constants, schemas, and default fundamental metric maps."""

from __future__ import annotations

__version__ = "1.2.0"
API = "v1"

FIELDS: tuple[str, ...] = (
    "asset_id",
    "symbol",
    "adjustment",
    "date",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "vwap",
    "trade_count",
    "source_asof",
)

SOURCES: tuple[str, ...] = (
    "sec",
    "alpaca_actions",
    "finnhub_news",
    "finnhub_earnings",
)

KEYS: list[str] = ["asset_id", "signal_session"]

DURATION_METRICS: dict[str, str] = {
    "revenue": "USD",
    "gross_profit": "USD",
    "operating_income": "USD",
    "net_income": "USD",
    "operating_cash_flow": "USD",
    "capex": "USD",
    "diluted_eps": "USD/shares",
    "weighted_average_shares_basic": "shares",
    "weighted_average_shares_diluted": "shares",
}

INSTANT_METRICS: dict[str, str] = {
    "cash": "USD",
    "total_assets": "USD",
    "total_liabilities": "USD",
    "equity": "USD",
    "shares_outstanding": "shares",
}

ALL_METRICS: dict[str, str] = {
    **DURATION_METRICS,
    **INSTANT_METRICS,
}

RATIO_METRICS: tuple[str, ...] = (
    "gross_margin",
    "operating_margin",
    "net_margin",
    "free_cash_flow",
    "free_cash_flow_margin",
    "revenue_yoy",
)

DATA_FAMILIES: tuple[str, ...] = (
    "events",
    "event_observations",
    "source_checks",
    "price_coverage",
    "security_history",
    "earnings_observations",
    "fundamentals",
    "financial_checks",
)
