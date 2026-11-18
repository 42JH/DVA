-- Preserve literal substring semantics; index only active customer names.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX customers_live_name_trgm_idx ON customers USING gin(lower(name) gin_trgm_ops) WHERE deleted_at IS NULL;
-- Partial-index expression statistics do not estimate whole-table selectivity.
CREATE STATISTICS customers_name_search_stats ON (lower(name)) FROM customers;
ANALYZE customers;
