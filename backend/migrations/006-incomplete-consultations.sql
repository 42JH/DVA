-- S15P31D109-55: end-of-call analysis, separate from orders and their submission state.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

CREATE TABLE incomplete_consultations (
 incomplete_consultation_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 call_session_seq integer NOT NULL UNIQUE REFERENCES call_sessions(call_session_seq),
 event_id text NOT NULL CHECK (btrim(event_id)<>''),
 ended_at timestamptz NOT NULL,
 end_type text CHECK (end_type IS NULL OR btrim(end_type)<>''),
 system_event text CHECK (system_event IS NULL OR btrim(system_event)<>''),
 order_snapshot jsonb NOT NULL CHECK (jsonb_typeof(order_snapshot)='object'),
 collection_analysis jsonb NOT NULL CHECK (jsonb_typeof(collection_analysis)='object'),
 request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX incomplete_consultations_ended_idx
 ON incomplete_consultations(ended_at DESC,incomplete_consultation_seq DESC);
