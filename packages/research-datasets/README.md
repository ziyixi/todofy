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
bars = ds.prices(
    ["AAPL", "MSFT"], start="2025-12-01", end="2026-10-30", adjusted="both"
)
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
  is the percentile of that sum among the universe's non-benchmark securities on the same signal session, for any
  selection (`run["rank_population"]` records the population). Pass `benchmark=` to `daily_features` to keep that
  security out of the ranking; `panel` and `prepare` exclude their benchmark automatically.
- Default quarterly columns omit operating cash flow, capex and free cash flow (10-Q cash flows are
  year-to-date); request them explicitly if needed.
- `ds.family(name, symbols, start, end, columns=...)` reads any registered family; `ds.family("events", ...)`
  filters events by security and date like `ds.events()`. A dataset that needs a newer SDK raises
  `CLIENT_TOO_OLD`; reinstall the SDK at the commit the console shows.

### 2.0 modules and columns

- `research_datasets.clocks.Calendar(sessions, closes=None, next_session=None)` gives each session's decision
  instant (06:00 America/New_York); `clocks.public_clocks(frame, zones)` computes public instants in bulk;
  `Calendar(...).capture_deadline(i)` is 09:00 New York on session `i`.
- Event features per source `s`: `s_events_1d` (missing unless the window is countable and every event has a
  clock; old name `s_new_event_count`), `s_observed_events_1d` (old name `s_observed_new_event_count`),
  `s_events_5d`, `s_events_21d`, `s_events_63d`, `s_events_rank_21d`, `s_coverage`, `s_coverage_basis`,
  `s_clock_missing`, `s_public_clock_missing`, and per row `info_regime` (`observed`, `reconstructed`, `mixed`).
  Coverage columns are categorical.
- `daily_features(..., specs=[EventSpec(name, source, where={column: {...}}, items_any={...})])` (also
  `ds.daily_features`) replaces the default one-per-source counts. `where` filters a version attribute (a version
  without a value keeps its event's latest earlier value; `form` ignores "/A"), `items_any` keeps SEC filings listing
  any of the items. Versions without a filtered column are refused (`CAPABILITY_MISSING`). Coverage of a spec is the
  coverage of its source; the run record lists the specs under `parameters.event_specs`.
- `undatable_events` counts events without clock or date that link a selected security.
- `research_datasets.asof_join(samples, table, by=..., columns=[...])` joins the latest row available at or before
  each decision; evaluation-only families are refused. Clocks without a UTC offset are treated as missing, and
  categorical keys match.
- `run["code_sha256"]` = `research_datasets.code_digest()`, a digest over every SDK module; `daily_features` and
  `panel` provenance carry the same run record (package version, code digest, environment, limitations).
- `ds.event_observations(columns=[...])` reads only the listed columns the version has.

### Candidates and labels

- `ds.candidates(symbols=None, start=..., end=..., sampling="daily"|"weekly"|"monthly", universe="pit")` gives
  `(asset_id, signal_session)` rows with `decision_at` (06:00 New York on the entry session), `entry_session`,
  `label_start`, `in_universe` and `is_benchmark`. Weekly/monthly keep the last session of each completed week or
  month. Without symbols, benchmarks and non-common securities are left out. `next_session=` gives the last frozen
  session a live decision.
- Membership is monthly: a row is in the universe when the latest membership of its entry session's month says so
  (`universe="pit"` uses the default rule; a rule version such as `"pit-liquid-v1"` picks another, which must exist in
  the version). A month whose latest observation is a warm-up row is unknown (NA). Non-members are dropped unless
  `keep_non_members=True`.
- Live panels: when `next_session` falls in the month right after the last frozen membership month, its rows use
  that month and set `membership_carried` (the run record names the month). A later month is not carried: live
  rows have unknown membership (dropped unless `keep_non_members`) and the run record says so.
- `ds.forward_returns(...)`, `ds.panel(...)` and `prepare(...)` refuse a version without membership
  (`UNIVERSE_NOT_PIT`); `allow_static_universe=True` accepts the frozen securities and records
  `universe_basis="static"` (survivorship-biased). `forward_returns(candidates)` labels under the candidates'
  universe rule; passing another `universe` raises.
- Labels run from the entry session's open to the close H sessions after the signal, for any H (default horizons
  5, 21, 63, 126). With `daily_returns` they are total returns (`return_basis="total_return"`), else vendor-adjusted.
  Interior sessions without a close are counted (`interior_missing_sessions`); a missing entry or exit price masks the
  label. An exit inside the window ends the security's leg at its terminal value: cash is held flat, stock follows
  the successor when it is frozen (else flat, `post_exit_basis="cash_proxy"`); a cash-and-stock exit without a usable
  cash amount is held flat and unreliable. The benchmark leg spans the whole window. Exits without a stored value use
  `terminal_policy`, keyed by exit type (`cash_merger`, `stock_merger`, `stock_and_cash_merger`, `worthless`,
  `performance`, `merger_terms_unknown`, `unknown`): performance delistings -30 % from the last close by default,
  unknown exits masked as `terminal_unknown`. Assumed values set `return_reliable=False`.
- `trainable_{H}d` = both legs valid, a universe member, a known exit value and no disputed session in the window;
  `disputed_sessions` counts disputed sessions of the asset, of the successor it follows after an exit and of the
  benchmark. Run records count each mask (`masks`; `masks.not_in_universe` includes rows dropped before labelling)
  and record `label_overlap` (H over the sampling step).
- `prepare(..., train_end=..., validation_end=..., embargo_sessions=E)` purges rows whose label ends at or after the
  next split's first decision and embargoes the E sessions before it. `split_membership` purges every split against
  all later splits (an empty validation split still protects the test period) and accepts ISO date strings;
  `prepare` refuses splits the point-in-time filter leaves empty.
- `neutralize=["size"]` (or a samples column / universe field) adds `excess_return_{H}d_{group}`, demeaned within
  signal session and group over trainable non-benchmark rows (session mean below five members). Neutralizing by a
  universe field adds a limitation: the field is current, not point-in-time.

### 2.0.0

- Fundamental joins (`fundamental_features`, `fundamental_ratios`, `prepare_fundamental_features`,
  `prepare_fundamental_ratios`) evaluate each decision against an index of the facts' availability intervals; the
  values, statuses and provenance are those of the per-row join. SEC facts are public at max(acceptance, 06:00
  America/New_York on the SEC filing date). `provenance=False` returns only `{metric}_value` and a categorical
  `{metric}_status` (ratios: values and categorical statuses).
- `panel(...)` fundamental and ratio columns are value and categorical status by default;
  `provenance_columns=True` adds the selected facts' provenance and the ratio inputs.
- `tests/bench_panel.py` times event features, fundamentals and weekly/daily panels on synthetic data
  (`python -m tests.bench_panel [securities] [sessions]`).
- Upgrading from 1.x: pass `time_policy`; decisions are 06:00 New York on the entry session; labels default to
  horizons 5, 21, 63, 126 with total returns when the version has them; versions without point-in-time membership need
  `allow_static_universe=True` for labels.

### 2.1.0

- Derived point-in-time fundamentals (`ds.fundamental_states`, `ds.derived_fundamentals`, `ds.fiscal_quarters`,
  `ds.fundamental_factors`): single fiscal quarters (`_q`, derived from 3-month, YTD differences, or annual minus 9-month
  filings), trailing twelve months (`_ttm`), fiscal-year (`_fy`), point-in-time instant (`_inst`), and 52/53-week YoY
  growth (`_yoy`), with concept-specific staleness flags and quality/leverage/cash-flow factors. `ds.panel(...)` defaults
  to `fundamentals="derived"` (`"legacy"` retains the 2.0 per-period selector; `"none"` omits fundamental and ratio
  blocks).
- Valuation and industry (`ds.valuation`, `ds.industry`): issuer-level and security-level market value (resolving
  multi-class issuers via `share_classes` when available), enterprise value, and book/earnings/FCF/sales/EBITDA yields;
  SIC division, major group, and Fama-French 12 classification (`sic_pit=False` flags non-PIT SIC metadata; supported in
  `neutralize=["ff12"]`).
- Valuation intervals crossing a stock dividend with an unknown share ratio use a factor of 1 for that action and
  flag market value as `split_unverified`. In `actions-v1` freezes, positive fractional rates below 1 keep their
  stored ratios, and rates of 1 or more or missing rates are unverified. An unverified issuer market value leaves
  `buyback_authorized_365d_to_mcap` missing when the market-cap status is supplied.
- Corporate actions and total-return families (`ds.corporate_actions`, `ds.total_returns`, `ds.return_reconciliation`)
  plus issuer metadata (`ds.issuer_profiles`, `ds.share_classes`, `ds.share_class_checks`).
- Typed SEC filing events and earnings features (`ds.sec_event_specs`, `typed_event_features`,
  `ds.earnings_announcements`, `earnings_features`, `sue_features`, `ds.earnings_calendar(asof=...)`,
  `label_announcement_flags`): manifest-driven SEC event kind counts and bulk-filer guards (`sec_kind_*`), point-in-time
  earnings timing and volume-confirmed abnormal returns (`earn_*`), split-invariant seasonal-random-walk SUE
  (`earn_sue_*`), and ex-post label window diagnostics (`label_has_earnings_{H}d`, `label_primary_earnings_{H}d`).
- Calendar holiday and half-day helpers (`us_federal_holidays`, `nyse_holidays`, `nyse_early_closes`,
  `is_sec_business_day`, `next_sec_business_day`, `sec_public_fallback`) provide deterministic SEC business-day and NYSE
  13:00 early-close rules when a manifest omits explicit close times.

### 2.2.0

- Reference and alternative feature builders (`extra_features`, `ds.extra_features`, and per-group functions
  `reference_features`, `market_etf_features`, `insider_features`, `short_interest_features`, `text_change_features`,
  and opt-in `borrow_features`) align to candidate decisions at 06:00 America/New_York under `time_policy`:
  - `reference`: `ref_rf_3m`, `ref_term_10y_3m`, `ref_term_10y_2y`, `ref_real_10y`, `ref_breakeven_10y`,
    `ref_credit_baa`, `ref_vix`, `ref_vix_term`, `ref_d10y_21d`, `ref_dvix_21d`, `ref_usd_ret_21d`, `ref_oil_ret_21d`,
    `ref_age_days` (one-session publication lag; inputs older than 10 calendar days become `NaN`).
  - `market_etf`: `etf_mkt_ret_21d`, `etf_mkt_ret_63d`, `etf_size_ret_63d`, `etf_breadth_ret_63d`, `etf_value_ret_63d`
    from frozen total-return or adjusted closes through signal session T across `REFERENCE_ETFS`.
  - `insider`: Form 4 open-market purchase/sale counts, dollar totals, net ratios, market-cap-scaled net value, officer
    purchase flags (`ins_*_{90d,180d}`), and `ins_coverage` (`covered` requires at least 95 % weekday check coverage).
  - `short_interest`: `si_shares`, `si_days_to_cover`, `si_pct_shares`, `si_change`, `si_age_sessions`,
    `si_split_flag`, and `si_coverage` (`covered`, `stale`, `unlinked`, `before_archive`; unverified symbol links are
    excluded unless `allow_unverified_links=True`).
  - `text_change`: year-over-year 10-K/10-Q similarity and length-change features (`txt_sim_full`, `txt_jac_full`,
    `txt_sim_rf`, `txt_sim_mdna`, `txt_len_change_full`, `txt_age_days`, `txt_form`, `txt_status`, `txt_sim_full_10k`).
  - `borrow` (opt-in, excluded from `DEFAULT_EXTRA_GROUPS`): `brw_shortable`, `brw_easy_to_borrow`, `brw_observed`
    within a 3-day observation window.
  - `ranks=True` adds cross-sectional session percentiles (`_rank`) over in-universe non-benchmark rows for
    `si_pct_shares`, `si_days_to_cover`, `ins_net_ratio_180d`, and `txt_sim_full`. Missing families produce no columns
    and are listed in `df.attrs["extra_missing"]`.
- `panel(..., include_extra=True)` (and `ds.panel`) accepts `bool` or a sequence from `EXTRA_GROUPS`, wires derived
  share counts and issuer market value into `extra_features`, records `provenance["extra"]`, and adds zero columns on
  dataset versions without extra families.
- Evaluation helpers: `factor_matrix` (`ds.factor_matrix`) pivots `factor_returns` into a `date x factor` table while
  `asof_join` refuses `evaluation_only` families; `risk_free_daily` (`ds.risk_free_daily`) compounds
  `(1 + y/100)^(1/252) - 1` at each session's 06:00 America/New_York decision instant.
- Universe readers and reused-symbol resolution: `ds.universe_membership(rule_version=None)`, `ds.delistings()`, and
  `ds.index_holdings()` read frozen universe and exit tables; when a reused ticker matches multiple securities and
  exactly one is `active`, `ds.resolve()` emits a `UserWarning` and selects the active holder (zero or multiple active
  matches still raise `SYMBOL_AMBIGUOUS`).

### 2.3.0

- Earnings-release document and structured extraction families (`release_documents`, `extraction_results`,
  `extraction_facts`) join `FAMILY_SPECS` and `Dataset` (`ds.release_documents`, `ds.extraction_results`,
  `ds.extraction_facts`), keyed by CIK with `accepted_at` / `recorded_at` partition clocks.
- `release_features` (`ds.release_features`) builds point-in-time release headline, guidance, buyback, and dividend
  features (`RELEASE_COLUMNS`) from `validation_status == "valid"` facts of one explicit `extractor_version`
  (defaulting to `manifest["extraction"]["default_extractor_version"]`). When no `extractor_version` is active or the
  release families are absent, zero columns are emitted.
- `panel(..., include_release=False)` keeps release extraction features off by default until a production extractor
  version is published in the manifest, and accepts `True` or an explicit `extractor_version` string.
