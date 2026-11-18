-- Legacy prompts lack per-version settings; retain them without inventing snapshots.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
LOCK TABLE ai_personas, ai_prompt_versions IN ACCESS EXCLUSIVE MODE;
ALTER TABLE ai_personas RENAME TO legacy_ai_personas;
ALTER TABLE ai_prompt_versions RENAME TO legacy_ai_prompt_versions;
ALTER SEQUENCE ai_personas_ai_persona_seq_seq RENAME TO legacy_ai_personas_ai_persona_seq_seq;
ALTER SEQUENCE ai_prompt_versions_ai_prompt_version_seq_seq RENAME TO legacy_ai_prompt_versions_ai_prompt_version_seq_seq;
ALTER INDEX ai_personas_pkey RENAME TO legacy_ai_personas_pkey;
ALTER INDEX ai_personas_code_key RENAME TO legacy_ai_personas_code_key;
CREATE OR REPLACE FUNCTION activate_ai_prompt(target_version integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE persona integer;
BEGIN
 SELECT ai_persona_seq INTO STRICT persona FROM legacy_ai_prompt_versions WHERE ai_prompt_version_seq=target_version;
 PERFORM 1 FROM legacy_ai_personas WHERE ai_persona_seq=persona FOR UPDATE;
 UPDATE legacy_ai_prompt_versions SET is_active=false WHERE ai_persona_seq=persona AND is_active;
 UPDATE legacy_ai_prompt_versions SET is_active=true WHERE ai_prompt_version_seq=target_version;
END $$;
COMMENT ON TABLE legacy_ai_personas IS 'Pre-007 MSA settings preserved verbatim; not a historical full-setting snapshot';
COMMENT ON TABLE legacy_ai_prompt_versions IS 'Pre-007 immutable prompt history; never automatically published as a full-setting version';

-- Latest monolith 013/015/039/045/050: identities and complete immutable versions.
CREATE TABLE ai_personas (
 ai_persona_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 code text NOT NULL UNIQUE
);
CREATE TABLE ai_persona_versions (
 ai_persona_version_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 ai_persona_seq integer NOT NULL REFERENCES ai_personas,
 version integer NOT NULL CHECK (version>0),
 prompt_text text NOT NULL CHECK (btrim(prompt_text)<>''),
 created_by_admin_user_seq integer,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 name text NOT NULL CHECK (name ~ '\S'),
 voice_id text CHECK (voice_id IS NULL OR voice_id ~ '\S'),
 speaking_rate numeric CHECK (speaking_rate IS NULL OR (speaking_rate>0 AND speaking_rate<'Infinity'::numeric)),
 turn_wait_level text NOT NULL CHECK (turn_wait_level IN ('SHORT','NORMAL','LONG')),
 status text NOT NULL DEFAULT 'INACTIVE' CHECK (status IN ('ACTIVE','PENDING','INACTIVE')),
 application_id uuid,
 requested_by_admin_user_seq integer,
 requested_at timestamptz,
 applied_at timestamptz,
 last_notified_at timestamptz,
 apply_error_code text CHECK (apply_error_code IN ('AI_UNAVAILABLE','INVALID_CONFIG','UNSUPPORTED_OPTIONS','APPLY_FAILED')),
 created_by_admin_user_name text,
 previous_active_version_seq integer CONSTRAINT ai_persona_previous_active_fk REFERENCES ai_persona_versions,
 CONSTRAINT ai_persona_previous_active_not_self CHECK (previous_active_version_seq<>ai_persona_version_seq),
 CONSTRAINT ai_persona_application_check CHECK (
  (application_id IS NULL AND requested_by_admin_user_seq IS NULL AND requested_at IS NULL AND status='INACTIVE')
  OR (application_id IS NOT NULL AND requested_by_admin_user_seq IS NOT NULL AND requested_at IS NOT NULL)),
 CONSTRAINT ai_persona_active_check CHECK (status<>'ACTIVE' OR (applied_at IS NOT NULL AND apply_error_code IS NULL)),
 UNIQUE(ai_persona_seq,version)
);
CREATE UNIQUE INDEX ai_persona_live_status_uk ON ai_persona_versions(status) WHERE status IN ('ACTIVE','PENDING');
CREATE UNIQUE INDEX ai_persona_application_uk ON ai_persona_versions(application_id) WHERE application_id IS NOT NULL;
CREATE FUNCTION guard_persona_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.ai_persona_version_seq,NEW.ai_persona_seq,NEW.version,NEW.name,NEW.prompt_text,
        NEW.voice_id,NEW.speaking_rate,NEW.turn_wait_level,NEW.created_by_admin_user_seq,NEW.created_at)
  IS DISTINCT FROM
    ROW(OLD.ai_persona_version_seq,OLD.ai_persona_seq,OLD.version,OLD.name,OLD.prompt_text,
        OLD.voice_id,OLD.speaking_rate,OLD.turn_wait_level,OLD.created_by_admin_user_seq,OLD.created_at) THEN
  RAISE EXCEPTION 'Create a new persona version instead of overwriting history' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_persona_history_guard BEFORE UPDATE ON ai_persona_versions
 FOR EACH ROW EXECUTE FUNCTION guard_persona_history();
-- 유형마다 초안은 하나만 유지한다. 유형·관리자 번호는 논리 참조다.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE TABLE ai_persona_drafts (
 ai_persona_seq integer PRIMARY KEY CHECK (ai_persona_seq>0),
 draft_revision uuid NOT NULL,
 base_version integer NOT NULL CHECK (base_version>0),
 name text NOT NULL CHECK (name ~ '\S'),
 prompt_text text NOT NULL CHECK (prompt_text ~ '\S'),
 voice_id text CHECK (voice_id IS NULL OR voice_id ~ '\S'),
 speaking_rate numeric CHECK (speaking_rate IS NULL OR (speaking_rate>0 AND speaking_rate<'Infinity'::numeric)),
 turn_wait_level text NOT NULL CHECK (turn_wait_level IN ('SHORT','NORMAL','LONG')),
 updated_by_admin_user_seq integer NOT NULL CHECK (updated_by_admin_user_seq>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
