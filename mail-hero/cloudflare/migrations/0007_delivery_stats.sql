-- Range aggregation reads completed attempt outcomes by UTC finish time.
CREATE INDEX delivery_attempts_finished_idx ON delivery_attempts(finished_at,outcome,event_id)
 WHERE finished_at IS NOT NULL;
