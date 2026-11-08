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
    fundamental_time_policy="public_reconstructed",
)
```
