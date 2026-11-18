-- Preserve legacy rows and old-pod compatibility during DB-first rolling deployments.
COMMENT ON TABLE public.company_pins IS 'Retired legacy archive. Current customer APIs do not read or write this table.';
