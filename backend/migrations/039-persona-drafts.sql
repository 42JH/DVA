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
