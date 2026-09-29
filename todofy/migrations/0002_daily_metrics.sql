-- Daily operating metrics for the owner UI's 30-day trends (runtime/metrics.py).
-- The coordinator writes one finished UTC day at a time, shortly after midnight: a
-- dozen or so rows (keys in worker/todofy/core/metrics.py), so the table adds a few
-- dozen D1 rows written per day including its primary-key index and the expiry.
-- A day is recorded only when it was counted completely; `mails_received` is
-- always written for such a day (0 included), so a day without rows is "not
-- recorded", never "nothing happened".
CREATE TABLE daily_metrics (
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 96),
  value INTEGER NOT NULL CHECK (value >= 0),
  PRIMARY KEY (day, key)
);
