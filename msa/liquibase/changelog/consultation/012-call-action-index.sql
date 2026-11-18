SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

CREATE INDEX call_insight_events_action_order_idx ON public.call_insight_events(call_session_seq, event_order, event_id) WHERE kind='AI_ACTION';
