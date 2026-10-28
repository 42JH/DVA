-- 이전 프롬프트에는 당시 음성 설정이 없다. 이력이 있으면 임의로 복원하지 않는다.
LOCK TABLE ai_personas, ai_prompt_versions IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM ai_prompt_versions) OR EXISTS(SELECT 1 FROM ai_personas) THEN
  RAISE EXCEPTION 'Existing AI persona data requires an explicit snapshot migration before 013';
 END IF;
END $$;

DROP TRIGGER ai_prompt_history_guard ON ai_prompt_versions;
DROP FUNCTION guard_prompt_history();
DROP INDEX ai_one_active_prompt_uk;
ALTER TABLE ai_prompt_versions RENAME TO ai_persona_versions;
ALTER TABLE ai_persona_versions RENAME COLUMN ai_prompt_version_seq TO ai_persona_version_seq;
ALTER TABLE ai_persona_versions DROP COLUMN is_active;
ALTER TABLE ai_persona_versions
 ADD COLUMN name text NOT NULL CHECK (name ~ '\S'),
 ADD COLUMN voice_id text CHECK (voice_id IS NULL OR voice_id ~ '\S'),
 ADD COLUMN speaking_rate numeric CHECK (speaking_rate IS NULL OR (speaking_rate>0 AND speaking_rate<'Infinity'::numeric)),
 ADD COLUMN turn_wait_level text NOT NULL CHECK (turn_wait_level IN ('SHORT','NORMAL','LONG')),
 ADD COLUMN status text NOT NULL DEFAULT 'INACTIVE' CHECK (status IN ('ACTIVE','PENDING','INACTIVE')),
 ADD COLUMN application_id uuid,
 ADD COLUMN requested_by_admin_user_seq integer REFERENCES admin_users(admin_user_seq),
 ADD COLUMN requested_at timestamptz,
 ADD COLUMN applied_at timestamptz,
 ADD COLUMN last_notified_at timestamptz,
 ADD COLUMN apply_error_code text CHECK (apply_error_code IN ('AI_UNAVAILABLE','INVALID_CONFIG','UNSUPPORTED_OPTIONS','APPLY_FAILED')),
 ADD CONSTRAINT ai_persona_application_check CHECK (
  (application_id IS NULL AND requested_by_admin_user_seq IS NULL AND requested_at IS NULL AND status='INACTIVE')
  OR (application_id IS NOT NULL AND requested_by_admin_user_seq IS NOT NULL AND requested_at IS NOT NULL)
 ),
 ADD CONSTRAINT ai_persona_active_check CHECK (status<>'ACTIVE' OR (applied_at IS NOT NULL AND apply_error_code IS NULL));

-- 전체 서비스에서 ACTIVE와 PENDING은 각각 하나만 존재한다.
CREATE UNIQUE INDEX ai_persona_live_status_uk ON ai_persona_versions(status)
 WHERE status IN ('ACTIVE','PENDING');
CREATE UNIQUE INDEX ai_persona_application_uk ON ai_persona_versions(application_id)
 WHERE application_id IS NOT NULL;
ALTER TABLE ai_personas DROP COLUMN name, DROP COLUMN is_enabled, DROP COLUMN voice_id,
 DROP COLUMN speaking_rate, DROP COLUMN turn_wait_level;

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
