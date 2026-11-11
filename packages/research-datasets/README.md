# Research datasets

Install directly into Google Colab or any Python 3.11+ environment:

```bash
pip install -q "https://github.com/ziyixi/todofy/archive/6b3b98a045d19af3bde99e795e9a63bde13f0177.zip#subdirectory=packages/research-datasets"
```

This command pins the reviewed source commit. The archive installation needs no GitHub login.
The client reads immutable datasets and verifies downloaded parts against their frozen manifest.

Provide your complete read endpoint, dataset UUID and bearer key. The endpoint and UUID below are synthetic.

```python
import research_datasets
from getpass import getpass

ds = research_datasets.load(
    "00000000-0000-4000-8000-000000000001",
    base_url="https://dataset.example.test/read/v1",
    key=getpass("Read key: "),
)

# Inspect security coverage and point-in-time check integrity.
audit = ds.audit(symbols=["AAPL", "MSFT", "GOOG", "GOOGL"], strict=True)

# Read frozen data families as pandas DataFrames.
bars = ds.prices(["AAPL", "MSFT"], start="2025-12-01", end="2026-10-30", adjusted="both")
close_wide = ds.prices(["AAPL", "MSFT"], wide="close")
quarterly_facts = ds.fundamentals(
    ["GOOG", "GOOGL"],
    period_kind="quarter",
    active_only=True,
    by_asset=True,
)

# Build point-in-time panels with your own train/validation/test split policy.
panel = ds.panel(
    symbols=["AAPL", "MSFT", "GOOG", "GOOGL"],
    start="2025-12-01",
    end="2026-10-30",
    benchmark="SPY",
    horizons=(1, 5),
    time_policy="public_reconstructed",
)
```

### 2.0 reading rules

- `time_policy` is required: `public_reconstructed` (training and live) or `observed_content` (audit).
- A row `(asset, signal session T)` is decided at 06:00 America/New_York on the entry session t. Information
  public at or before that instant is available; the event window is (06:00 on T, 06:00 on t]. SEC filings are
  public at max(acceptance, 06:00 America/New_York on the SEC filing date). `observed_content` also requires each
  capture by 09:00 America/New_York on t.
- Under `public_reconstructed`, event links come from each event's latest saved version (a later removal applies
  to the whole history) and coverage comes from saved check windows regardless of when they ran. Coverage labels:
  `checked`, `empty`, `read_complete` (countable), `mapping_missing` (identity could not prove the ticker or
  issuer), `not_listed`, `partial`, `unknown`; `{source}_coverage_basis` says `observed` or `reconstructed`.
  Counts are missing, never 0, unless every day of the window is countable.
- Count sources: `sec` (forms 8-K, 10-K, 10-Q, 6-K, 20-F and amendments; the latest named form decides),
  `alpaca_news` (articles of one story within 72 h count once per security, among the articles still linked to it),
  `finnhub_news`. Rows of unknown sources are skipped and counted in `run["skipped_sources"]`.
  `{source}_events_21d` sums 21 one-session windows (missing unless all are countable). `{source}_events_rank_21d`
  is the percentile of that sum among the universe's non-benchmark securities on the same signal session; it is
  missing unless the selection includes all of them (`run["rank_population"]` says whether it was computed). Pass
  `benchmark=` to `daily_features` to keep that security out of the ranking; `panel` and `prepare` exclude their
  benchmark automatically.
- Default quarterly columns omit operating cash flow, capex and free cash flow (10-Q cash flows are
  year-to-date); request them explicitly if needed.
- `ds.family(name, symbols, start, end, columns=...)` reads any registered family; `ds.family("events", ...)`
  filters events by security and date like `ds.events()`. A dataset that needs a newer SDK raises
  `CLIENT_TOO_OLD`; reinstall the SDK at the commit the console shows.
