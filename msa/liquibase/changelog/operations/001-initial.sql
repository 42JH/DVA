CREATE TABLE admin_users (
 admin_user_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 login_id text NOT NULL UNIQUE, password_hash text NOT NULL,
 role text NOT NULL CHECK (role IN ('OPERATOR','SUPERVISOR','SYSTEM_ADMIN')),
 status text NOT NULL CHECK (status IN ('ACTIVE','PENDING','INACTIVE')),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 last_login_at timestamptz
);

CREATE TABLE audit_logs (
 audit_log_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_type text NOT NULL CHECK (actor_type IN ('ADMIN','SYSTEM')), actor_seq integer,
 CHECK ((actor_type='ADMIN' AND actor_seq IS NOT NULL AND actor_seq>0) OR (actor_type='SYSTEM' AND actor_seq IS NULL)),
 action text NOT NULL, target_type text NOT NULL, target_seq integer,
 request_id uuid NOT NULL, result text NOT NULL CHECK (result IN ('SUCCESS','DENIED','FAILED')),
 metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata)='object'),
 occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX audits_target_idx ON audit_logs(target_type,target_seq,occurred_at DESC);
CREATE TABLE ai_personas (
 ai_persona_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 code text NOT NULL UNIQUE,
 name text NOT NULL,
 is_enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE ai_prompt_versions (
 ai_prompt_version_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 ai_persona_seq integer NOT NULL REFERENCES ai_personas,
 version integer NOT NULL CHECK (version > 0),
 prompt_text text NOT NULL CHECK (btrim(prompt_text) <> ''),
 is_active boolean NOT NULL DEFAULT false,
 created_by_admin_user_seq integer REFERENCES admin_users,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(ai_persona_seq,version)
);
CREATE UNIQUE INDEX ai_one_active_prompt_uk ON ai_prompt_versions(ai_persona_seq) WHERE is_active;
CREATE FUNCTION guard_prompt_text() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.ai_persona_seq<>OLD.ai_persona_seq OR NEW.version<>OLD.version
  OR NEW.prompt_text<>OLD.prompt_text OR NEW.created_by_admin_user_seq IS DISTINCT FROM OLD.created_by_admin_user_seq THEN
  RAISE EXCEPTION 'Create a new prompt version instead of overwriting history' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_prompt_history_guard BEFORE UPDATE ON ai_prompt_versions FOR EACH ROW EXECUTE FUNCTION guard_prompt_text();
CREATE FUNCTION activate_ai_prompt(target_version integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE persona integer;
BEGIN
 SELECT ai_persona_seq INTO STRICT persona FROM ai_prompt_versions WHERE ai_prompt_version_seq=target_version;
 PERFORM 1 FROM ai_personas WHERE ai_persona_seq=persona FOR UPDATE;
 UPDATE ai_prompt_versions SET is_active=false WHERE ai_persona_seq=persona AND is_active;
 UPDATE ai_prompt_versions SET is_active=true WHERE ai_prompt_version_seq=target_version;
END $$;
INSERT INTO ai_personas(code,name) VALUES('fast','빠른 접수형'),('friendly','친절 안내형');
-- Starter personas are editing templates, not a complete operational agent prompt.
INSERT INTO ai_prompt_versions(ai_persona_seq,version,prompt_text,is_active)
SELECT ai_persona_seq,1,CASE code
 WHEN 'fast' THEN '택배 접수를 짧고 자연스럽게 진행한다. 한 번에 받은 정보를 활용하고 불명확할 때만 되묻는다. 마지막에 주문 내용을 요약해 확인한다. 주소는 백엔드 검색 결과를 사용한다.'
 ELSE '택배 정보를 차근차근 질문하고 받은 내용을 확인한다. 수거 방식과 다음 절차를 간단히 안내하며 느린 발화를 기다린다. 주소는 백엔드 검색 결과를 사용한다.' END,true FROM ai_personas;

-- Shared monolith/MSA operations changes. Apply after existing operations tables.
-- Unknown engine-specific voice IDs/rates are not fabricated; NULL means unconfigured.
ALTER TABLE ai_personas
 ADD COLUMN voice_id text CHECK (voice_id IS NULL OR btrim(voice_id)<>''),
 ADD COLUMN turn_wait_level text NOT NULL DEFAULT 'NORMAL'
   CHECK (turn_wait_level IN ('SHORT','NORMAL','LONG')),
 ADD COLUMN speaking_rate numeric CHECK (speaking_rate IS NULL OR
   (speaking_rate>0 AND speaking_rate<'Infinity'::numeric));

CREATE TABLE faq_entries (
 faq_entry_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 question text NOT NULL CHECK (btrim(question)<>''),
 answer text NOT NULL CHECK (btrim(answer)<>''),
 updated_by_admin_user_seq integer NOT NULL REFERENCES admin_users,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE FUNCTION touch_faq_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN NEW.updated_at=CURRENT_TIMESTAMP; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER faq_entry_timestamp BEFORE UPDATE ON faq_entries
 FOR EACH ROW EXECUTE FUNCTION touch_faq_entry();

-- Notification is a wake-up signal, not a durable event log; consumers fetch current DB/API data.
-- After LISTEN is committed, reconcile all FAQ IDs/content (including deleted index entries).
CREATE FUNCTION notify_faq_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry_id integer;
BEGIN
 IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
 IF TG_OP='DELETE' THEN entry_id=OLD.faq_entry_seq;
 ELSE entry_id=NEW.faq_entry_seq; END IF;
 PERFORM pg_notify('faq_changed', jsonb_build_object(
   'faqEntrySeq',entry_id,'operation',TG_OP)::text);
 RETURN NULL;
END $$;
CREATE TRIGGER faq_entry_changed AFTER INSERT OR UPDATE OR DELETE ON faq_entries
 FOR EACH ROW EXECUTE FUNCTION notify_faq_change();
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

