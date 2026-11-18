-- Stop incompatible apps/workers and back up legacy rows before applying.
-- Order address snapshots/references and shared personal PIN functions remain intact.
DROP TABLE public.company_pins;
