-- CheckIfLegit — store discovery via HTTP Archive (BigQuery Sandbox, $0, no card).
-- Run in console.cloud.google.com/bigquery. See README / setup steps.

-- STEP 1 (free, metadata only): find the latest available crawl date.
--   SELECT partition_id
--   FROM `httparchive.all.INFORMATION_SCHEMA.PARTITIONS`
--   WHERE table_name = 'pages'
--   ORDER BY partition_id DESC LIMIT 5;
-- Use the newest value (e.g. 20260501) as the `date` below.

-- STEP 2: Shopify / WooCommerce stores, biased to the long tail (less popular).
-- Check the "This query will process X" estimate is under 1 TB before running,
-- then: Save results -> CSV (local file).
SELECT
  NET.REG_DOMAIN(page) AS domain,
  ANY_VALUE(rank) AS popularity_rank
FROM `httparchive.all.pages`
WHERE date = '2026-05-01'              -- set to latest partition from STEP 1
  AND client = 'mobile'
  AND is_root_page = TRUE
  AND EXISTS (
    SELECT 1 FROM UNNEST(technologies) AS t
    WHERE t.technology IN ('Shopify', 'WooCommerce')
  )
  AND (rank IS NULL OR rank > 100000)  -- long-tail bias: drop the top-100k popular sites
GROUP BY domain
ORDER BY RAND()                         -- sample across the tail, not a skewed slice
LIMIT 14000;
