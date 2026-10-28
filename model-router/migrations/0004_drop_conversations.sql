-- The first rollout's context table is unused: contexts live in the engine's Durable Object storage, and its
-- expired bookkeeping rows were already due for deletion one day after expiry. Request history stays unchanged.
DROP TABLE IF EXISTS conversations;
