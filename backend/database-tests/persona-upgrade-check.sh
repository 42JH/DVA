#!/bin/sh
set -eu
ROOT=/tmp/dva129
MIGRATIONS=$ROOT/backend/migrations
DATABASE=persona_upgrade_check
createdb -U dva "$DATABASE"
sql() { psql -X -v ON_ERROR_STOP=1 -U dva -d "$DATABASE" "$@"; }
for file in "$MIGRATIONS"/0*.sql; do
 case "$file" in */013-*) break ;; esac
 sql -1 -f "$file" > /dev/null
done
sql <<'SQL'
INSERT INTO ai_personas(code,name,voice_id,speaking_rate) VALUES('existing','기존 이름','existing-voice',1.2);
INSERT INTO ai_prompt_versions(ai_persona_seq,version,prompt_text,is_active)
 SELECT ai_persona_seq,1,'기존 본문',true FROM ai_personas;
SQL
before=$(sql -Atc 'SELECT jsonb_agg(to_jsonb(v)) FROM ai_prompt_versions v')
if sql -1 -f "$MIGRATIONS/013-ai-persona-versions.sql" > "$ROOT/persona-upgrade.log" 2>&1; then
 echo 'FAIL: legacy settings were guessed' >&2; exit 1
fi
test "$(sql -Atc 'SELECT jsonb_agg(to_jsonb(v)) FROM ai_prompt_versions v')" = "$before"
test "$(sql -Atc "SELECT voice_id='existing-voice' AND speaking_rate=1.2 FROM ai_personas")" = t
test "$(sql -Atc "SELECT to_regclass('public.ai_persona_versions') IS NULL")" = t
echo 'PASS: persona migration refuses ambiguous legacy snapshots without losing original history'
