-- Derive only missing estimates from reported metadata. Prompts, answers and tokens stay unchanged.
-- Sol totals can span SDK calls. Use the documented Standard reference valuation.
WITH unpriced AS (
 SELECT id, model,
  COALESCE(json_extract(generation_json,'$.generation.usage'),json_extract(generation_json,'$.usage')) AS usage,
  CASE WHEN json_type(generation_json,'$.generation') = 'object'
   THEN '$.generation.usage.estimated_cost_microusd' ELSE '$.usage.estimated_cost_microusd' END AS cost_path
 FROM requests WHERE model IN ('gpt-6.1-sol','gemini-3.5-flash-lite')
), priced AS (
 SELECT id, cost_path,
  CAST(
   (COALESCE(json_extract(usage,'$.input_tokens'),0)-COALESCE(json_extract(usage,'$.cached_input_tokens'),0))
    * CASE model WHEN 'gpt-6.1-sol' THEN 2 ELSE 0.3 END
   + COALESCE(json_extract(usage,'$.cached_input_tokens'),0)
    * CASE model WHEN 'gpt-6.1-sol' THEN 0.1 ELSE 0.03 END
   + COALESCE(json_extract(usage,'$.output_tokens'),0)
    * CASE model WHEN 'gpt-6.1-sol' THEN 10 ELSE 2.5 END
   + 0.999999 AS INTEGER) AS cost
 FROM unpriced
 WHERE json_extract(usage,'$.available') = 1
  AND json_extract(usage,'$.estimated_cost_microusd') IS NULL
  AND COALESCE(json_extract(usage,'$.cache_write_tokens'),0) = 0
  AND COALESCE(json_extract(usage,'$.input_tokens'),0) >= COALESCE(json_extract(usage,'$.cached_input_tokens'),0)
)
UPDATE requests SET generation_json = json_set(generation_json,
 (SELECT cost_path FROM priced WHERE priced.id = requests.id),
 (SELECT cost FROM priced WHERE priced.id = requests.id))
WHERE id IN (SELECT id FROM priced WHERE cost BETWEEN 0 AND 2147483647);
