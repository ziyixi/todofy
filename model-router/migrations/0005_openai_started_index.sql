-- Partial index for Store.openaiMonthlyCost (model-router/worker/src/store.ts): SQLite's query planner
-- selects requests_openai_started only because model GLOB 'openai/*' is a literal predicate matching this
-- WHERE clause, and changing it to a bound parameter would silently fall back to scanning requests_started.
CREATE INDEX IF NOT EXISTS requests_openai_started ON requests(started_ms) WHERE model GLOB 'openai/*';
