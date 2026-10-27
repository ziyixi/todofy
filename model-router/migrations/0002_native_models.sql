-- Normalize only the history index. Original retained requests and historical model reports stay intact.
UPDATE requests SET model = CASE
 WHEN COALESCE(json_extract(generation_json,'$.reported_model'),'') != '' THEN json_extract(generation_json,'$.reported_model')
 WHEN model = 'models/sol-6-1' THEN 'gpt-6.1-sol'
 WHEN model = 'models/claude-opus-5-5' THEN 'claude-opus-5-5'
 WHEN model = 'models/claude-haiku-5-5' THEN 'claude-haiku-5-5'
 WHEN model = 'models/gemini-3-8-flash' THEN 'gemini-3.8-flash'
 WHEN model = 'models/gemini-3-7-flash' THEN 'gemini-3.7-flash'
 WHEN model = 'models/gemini-3-5-flash-lite' THEN 'gemini-3.5-flash-lite'
 WHEN model = 'models/bge-m3' THEN '@cf/baai/bge-m3'
 WHEN model IN ('models/gemini-email','models/gemini-report') THEN ''
 ELSE model END;

-- The new reference valuation uses standard short-context Sol API token rates, never a subscription bill.
-- Old records with incomplete usage, cache writes or an unsupported context size remain unpriced.
UPDATE requests SET generation_json = json_set(generation_json,'$.usage.estimated_cost_microusd',
 CAST((json_extract(generation_json,'$.usage.input_tokens') - COALESCE(json_extract(generation_json,'$.usage.cached_input_tokens'),0)) * 2
 + COALESCE(json_extract(generation_json,'$.usage.cached_input_tokens'),0) * 0.1
 + json_extract(generation_json,'$.usage.output_tokens') * 10 + 0.999999 AS INTEGER))
 WHERE model = 'gpt-6.1-sol' AND json_extract(generation_json,'$.usage.available') = 1
 AND json_extract(generation_json,'$.usage.input_tokens') <= 272000
 AND json_extract(generation_json,'$.usage.input_tokens') >= COALESCE(json_extract(generation_json,'$.usage.cached_input_tokens'),0)
 AND COALESCE(json_extract(generation_json,'$.usage.cache_write_tokens'),0) = 0
 AND json_type(generation_json,'$.usage.estimated_cost_microusd') IS NULL;
