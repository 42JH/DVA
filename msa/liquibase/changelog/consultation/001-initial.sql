-- Cross-service order/admin IDs are logical references.
CREATE TABLE call_sessions (
 call_session_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 order_seq integer,
 provider_call_id text NOT NULL UNIQUE CHECK (btrim(provider_call_id)<>''),
 caller_phone_number text,
 started_at timestamptz, ended_at timestamptz, end_reason text,
 CHECK ((started_at IS NULL AND ended_at IS NULL AND end_reason IS NULL)
  OR (started_at IS NOT NULL AND ended_at IS NOT NULL AND ended_at>=started_at))
);
CREATE INDEX calls_order_idx ON call_sessions(order_seq,started_at,call_session_seq);

-- CallModule: call metadata and dialogue share one module; exclude authentication segments before persistence.
-- CallModule: dialogue storage; implementation fragment, not a separate module.
CREATE TABLE call_utterances (
 call_utterance_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 call_session_seq integer NOT NULL REFERENCES call_sessions,
 utterance_order integer NOT NULL CHECK (utterance_order>0),
 speaker text NOT NULL CHECK (speaker IN ('CUSTOMER','AI')),
 utterance_text text NOT NULL CHECK (length(utterance_text)>0),
 last_sentence_seq integer NOT NULL CHECK (last_sentence_seq>0),
 received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(call_session_seq,utterance_order)
);
CREATE INDEX utterances_pending_retention_idx ON call_utterances(received_at,call_session_seq);

-- Notify after commit. Send row identifiers only; authenticated backend fetches/streams the content.
CREATE FUNCTION notify_transcript_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('transcript_changed',jsonb_build_object('callSessionSeq',NEW.call_session_seq,
  'utteranceSeq',NEW.call_utterance_seq,'utteranceOrder',NEW.utterance_order)::text);
 RETURN NEW;
END $$;
CREATE TRIGGER transcript_change_notification AFTER INSERT OR UPDATE OF utterance_text ON call_utterances
 FOR EACH ROW EXECUTE FUNCTION notify_transcript_change();


-- RecordingModule: references to successfully stored original audio files.
CREATE TABLE recordings (
 recording_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 call_session_seq integer NOT NULL REFERENCES call_sessions,
 object_key text NOT NULL UNIQUE CHECK (object_key !~ '(^/|\.\.|://)'),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX recordings_call_idx ON recordings(call_session_seq,recording_seq);
CREATE INDEX recordings_retention_idx ON recordings(created_at,recording_seq);

-- HandoffModule: reported transfer outcome, not backend-owned PBX queue state.
CREATE TABLE handoff_requests (
 handoff_request_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 call_session_seq integer NOT NULL UNIQUE REFERENCES call_sessions,
 reason text NOT NULL,
 status text NOT NULL CHECK (status IN ('REQUESTED','CONNECTED','FAILED')),
 assigned_admin_user_seq integer,
 summary_text text,
 requested_at timestamptz NOT NULL
);
CREATE INDEX handoff_queue_idx ON handoff_requests(status,requested_at);
-- Calendar-month policy in Korean operating time. Duration is passed by runtime configuration.
CREATE FUNCTION retention_deadline(ended_at timestamptz,months integer) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
 IF months<=0 THEN RAISE EXCEPTION 'Invalid retention months' USING ERRCODE='22023'; END IF;
 RETURN ((ended_at AT TIME ZONE 'Asia/Seoul')+make_interval(months=>months)) AT TIME ZONE 'Asia/Seoul';
END $$;
CREATE INDEX calls_retention_idx ON call_sessions(ended_at,provider_call_id);

-- Infrastructure template, included once per participating service database.
-- A separate row per destination permits independent acknowledgements.
CREATE TABLE outbox_events (
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 destination text NOT NULL CHECK (btrim(destination)<>''),
 event_type text NOT NULL CHECK (btrim(event_type)<>''),
 aggregate_seq integer NOT NULL,
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
 occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 delivered_at timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox_events(occurred_at,event_id) WHERE delivered_at IS NULL;
CREATE TABLE inbox_events (
 event_id uuid PRIMARY KEY,
 source text NOT NULL CHECK (btrim(source)<>''),
 event_type text NOT NULL CHECK (btrim(event_type)<>''),
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
 processed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Insert inbox + business changes in ONE transaction. Compare payload/source/type on duplicates.
-- Receiver ACKs only committed processing; sender marks delivered_at only after ACK.
-- Relay and authenticated transport remain application work; this DDL is not a running worker.

