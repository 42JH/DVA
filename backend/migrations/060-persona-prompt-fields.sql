SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
LOCK TABLE ai_persona_versions,ai_persona_drafts IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE ai_persona_versions
 ADD COLUMN role_text text NOT NULL DEFAULT '',
 ADD COLUMN personality_text text NOT NULL DEFAULT '',
 ADD COLUMN tone_text text NOT NULL DEFAULT '',
 ADD COLUMN speed_instruction text NOT NULL DEFAULT '',
 ADD COLUMN backchannel_text text NOT NULL DEFAULT '',
 ADD COLUMN interruption_text text NOT NULL DEFAULT '';
ALTER TABLE ai_persona_drafts
 ADD COLUMN role_text text NOT NULL DEFAULT '',
 ADD COLUMN personality_text text NOT NULL DEFAULT '',
 ADD COLUMN tone_text text NOT NULL DEFAULT '',
 ADD COLUMN speed_instruction text NOT NULL DEFAULT '',
 ADD COLUMN backchannel_text text NOT NULL DEFAULT '',
 ADD COLUMN interruption_text text NOT NULL DEFAULT '';

-- 기존 원문은 유지한다. 명시된 제목만 분리하고 분류할 수 없는 장은 역할에 보존한다.
CREATE FUNCTION pg_temp.persona_prompt_fields(source text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
 result jsonb := '{"role":"","personality":"","tone":"","speedInstruction":"","backchannel":"","interruption":""}';
 line text;
 heading text;
 field text := 'role';
 matched text;
 key text;
BEGIN
 FOREACH line IN ARRAY string_to_array(source,E'\n') LOOP
  IF line ~ '^#{1,6}[[:blank:]]+' THEN
   heading := lower(btrim(regexp_replace(line,'^#{1,6}[[:blank:]]+','')));
   matched := CASE
    WHEN heading IN ('역할','identity / 역할') THEN 'role'
    WHEN heading IN ('성격','personality / 성격') THEN 'personality'
    WHEN heading IN ('톤','말투','발화 톤','tone / 발화 톤','말하기와 응대') THEN 'tone'
    WHEN heading IN ('속도','발화 속도','pace / 발화 속도') THEN 'speedInstruction'
    WHEN heading IN ('맞장구','backchannel policy','backchannel policy / 맞장구') THEN 'backchannel'
    WHEN heading IN ('끼어들기','interruption policy') THEN 'interruption'
    ELSE NULL END;
   IF matched IS NOT NULL THEN
    field := matched;
    CONTINUE;
   ELSIF heading IN ('페르소나','발화 스타일','speaking style / 발화 스타일') THEN
    CONTINUE;
   ELSE
    field := 'role';
   END IF;
  END IF;
  result := jsonb_set(result,ARRAY[field],to_jsonb((result->>field)||line||E'\n'));
 END LOOP;
 FOREACH key IN ARRAY ARRAY['role','personality','tone','speedInstruction','backchannel','interruption'] LOOP
  result := jsonb_set(result,ARRAY[key],to_jsonb(btrim(result->>key,E'\r\n')));
 END LOOP;
 IF NOT (result->>'role' ~ '\S') THEN
  result := jsonb_set(result,'{role}',to_jsonb(source));
 END IF;
 RETURN result;
END $$;

WITH fields AS (
 SELECT ai_persona_version_seq,pg_temp.persona_prompt_fields(prompt_text) AS value FROM ai_persona_versions
)
UPDATE ai_persona_versions v SET
 role_text=f.value->>'role',personality_text=f.value->>'personality',tone_text=f.value->>'tone',
 speed_instruction=f.value->>'speedInstruction',backchannel_text=f.value->>'backchannel',
 interruption_text=f.value->>'interruption'
FROM fields f WHERE f.ai_persona_version_seq=v.ai_persona_version_seq;
WITH fields AS (
 SELECT ai_persona_seq,pg_temp.persona_prompt_fields(prompt_text) AS value FROM ai_persona_drafts
)
UPDATE ai_persona_drafts d SET
 role_text=f.value->>'role',personality_text=f.value->>'personality',tone_text=f.value->>'tone',
 speed_instruction=f.value->>'speedInstruction',backchannel_text=f.value->>'backchannel',
 interruption_text=f.value->>'interruption'
FROM fields f WHERE f.ai_persona_seq=d.ai_persona_seq;
DROP FUNCTION pg_temp.persona_prompt_fields(text);

CREATE OR REPLACE FUNCTION guard_persona_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.ai_persona_version_seq,NEW.ai_persona_seq,NEW.version,NEW.name,NEW.prompt_text,
        NEW.voice_id,NEW.speaking_rate,NEW.turn_wait_level,NEW.created_by_admin_user_seq,NEW.created_at,
        NEW.role_text,NEW.personality_text,NEW.tone_text,NEW.speed_instruction,NEW.backchannel_text,NEW.interruption_text)
  IS DISTINCT FROM
    ROW(OLD.ai_persona_version_seq,OLD.ai_persona_seq,OLD.version,OLD.name,OLD.prompt_text,
        OLD.voice_id,OLD.speaking_rate,OLD.turn_wait_level,OLD.created_by_admin_user_seq,OLD.created_at,
        OLD.role_text,OLD.personality_text,OLD.tone_text,OLD.speed_instruction,OLD.backchannel_text,OLD.interruption_text) THEN
  RAISE EXCEPTION 'Create a new persona version instead of overwriting history' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
