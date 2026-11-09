#!/bin/sh
# Runs only inside the disposable test-monolith container: populated 053 -> 054.
set -eu
ROOT=/tmp/dva129
MIGRATIONS=$ROOT/backend/migrations
DATABASE=recording_retry_upgrade_check
createdb -U dva "$DATABASE"
sql() { psql -X -v ON_ERROR_STOP=1 -U dva -d "$DATABASE" "$@"; }
for migration in "$MIGRATIONS"/*.sql; do
 case "$migration" in */054-*) break ;; esac
 sql -1 -f "$migration" > /dev/null
done
sql <<'SQL'
INSERT INTO call_sessions(provider_call_id,incoming_at) VALUES('recording-retry-fixture',clock_timestamp());
INSERT INTO pbx_webhooks.call_ended_events(recording_id,payload,processing_status,call_session_seq)
SELECT s,jsonb_build_object('fixture',s,'recordingUrl','https://example.invalid/test?signed=test-only'),
 CASE WHEN s='received' THEN 'RECEIVED' WHEN s='processed' THEN 'PROCESSED' ELSE 'FAILED' END,
 CASE WHEN s='unmatched' THEN NULL ELSE (SELECT call_session_seq FROM call_sessions WHERE provider_call_id='recording-retry-fixture') END
FROM unnest(ARRAY['received','processed','failed','unmatched','claimed']) s;
UPDATE pbx_webhooks.call_ended_events SET claim_id='00000000-0000-4000-8000-000000000054',
 claimed_until=clock_timestamp()+interval '5 minutes',last_attempt_at=clock_timestamp() WHERE recording_id='claimed';
INSERT INTO recordings(call_session_seq,object_key)
SELECT call_session_seq,'recordings/recording-retry-fixture' FROM call_sessions WHERE provider_call_id='recording-retry-fixture';
SQL
snapshot() {
 sql -At <<'SQL'
SELECT md5(jsonb_build_object(
 'receipts',(SELECT jsonb_agg(to_jsonb(e)-ARRAY['attempt_count','next_attempt_at','last_error_code','requires_review'] ORDER BY recording_id) FROM pbx_webhooks.call_ended_events e),
 'calls',(SELECT jsonb_agg(to_jsonb(c) ORDER BY call_session_seq) FROM call_sessions c),
 'recordings',(SELECT jsonb_agg(to_jsonb(r) ORDER BY recording_seq) FROM recordings r))::text);
SQL
}
before=$(snapshot)
pg_dump -U dva -d "$DATABASE" -Fc -f "$ROOT/recording-retry-before.dump"
if sql -1 -f "$MIGRATIONS/054-recording-retry-policy.sql" -c 'SELECT 1/0' > "$ROOT/recording-retry-failure.log" 2>&1; then
 echo 'FAIL: post-migration failure was accepted' >&2; exit 1
fi
test "$(snapshot)" = "$before"
test "$(sql -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='pbx_webhooks' AND table_name='call_ended_events' AND column_name='requires_review'")" = 0
sql -1 -f "$MIGRATIONS/054-recording-retry-policy.sql"
test "$(snapshot)" = "$before"
sql <<'SQL'
DO $$
BEGIN
 IF (SELECT count(*) FROM pbx_webhooks.call_ended_events WHERE attempt_count=0 AND next_attempt_at IS NULL)<>5
  OR (SELECT count(*) FROM pbx_webhooks.call_ended_events WHERE requires_review AND last_error_code='LEGACY_FAILURE' AND processing_status='FAILED')<>3
  OR EXISTS(SELECT 1 FROM pbx_webhooks.call_ended_events WHERE processing_status<>'FAILED' AND (requires_review OR last_error_code IS NOT NULL)) THEN
   RAISE EXCEPTION 'Incorrect legacy retry migration'; END IF;
 BEGIN
  UPDATE pbx_webhooks.call_ended_events SET attempt_count=6 WHERE recording_id='received';
  RAISE EXCEPTION 'Attempt upper bound missing';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE pbx_webhooks.call_ended_events SET attempt_count=-1 WHERE recording_id='received';
  RAISE EXCEPTION 'Attempt lower bound missing';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE pbx_webhooks.call_ended_events SET requires_review=true WHERE recording_id='received';
  RAISE EXCEPTION 'Invalid review state accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE pbx_webhooks.call_ended_events SET last_error_code='https://private.invalid/secret' WHERE recording_id='failed';
  RAISE EXCEPTION 'Raw source error accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
SQL
createdb -U dva recording_retry_restore_check
pg_restore --exit-on-error --no-owner -U dva -d recording_retry_restore_check "$ROOT/recording-retry-before.dump"
DATABASE=recording_retry_restore_check
test "$(snapshot)" = "$before"
echo 'PASS: 054 preserves receipts/payloads/leases/calls/recordings, holds only legacy failures, enforces retry constraints, rolls back atomically and restores populated 053 backup'
