#!/bin/sh
# 014 -> 015: preserve business rows/names while permitting physical admin deletion.
set -eu
ROOT=/tmp/dva129
MIGRATIONS=$ROOT/backend/migrations
DATABASE=admin_audit_upgrade_check
createdb -U dva "$DATABASE"
sql() { psql -X -v ON_ERROR_STOP=1 -U dva -d "$DATABASE" "$@"; }
for migration in "$MIGRATIONS"/*.sql; do
 case "$migration" in */015-*) break ;; esac
 sql -1 -f "$migration" > /dev/null
done
sql <<'SQL'
INSERT INTO admin_users(login_id,name,password_hash,role,status)
 VALUES('historical','이력 관리자','test','OPERATOR','ACTIVE');
INSERT INTO admin_sessions(session_token_hash,admin_user_seq) VALUES(repeat('a',64),1);
INSERT INTO audit_logs(actor_type,actor_seq,action,target_type,target_seq,request_id,result,metadata)
 VALUES('ADMIN',1,'OLD_CHANGE','ADMIN_USER',1,'00000000-0000-0000-0000-000000000001','SUCCESS','{}'),
       ('ADMIN',999,'MISSING_ACTOR','ADMIN_USER',999,'00000000-0000-0000-0000-000000000002','SUCCESS','{}'),
       ('SYSTEM',NULL,'UNKNOWN_AI_OR_SYSTEM','ORDER',1,'00000000-0000-0000-0000-000000000003','SUCCESS','{}');
INSERT INTO call_sessions(provider_call_id) VALUES('audit-preservation');
INSERT INTO handoff_requests(call_session_seq,reason,status,assigned_admin_user_seq,requested_at)
 VALUES(1,'preserve','CONNECTED',1,now());
INSERT INTO orders DEFAULT VALUES;
INSERT INTO order_parcels(order_seq,parcel_position) VALUES(1,1);
INSERT INTO shipments(order_parcel_seq,tracking_number) VALUES(1,'audit-preservation');
INSERT INTO shipment_status_history(shipment_seq,request_id,to_status,actor_type,actor_admin_user_seq)
 VALUES(1,'00000000-0000-0000-0000-000000000004','notPaid','ADMIN',1);
INSERT INTO ai_personas(code) VALUES('audit-preservation');
INSERT INTO ai_persona_versions(ai_persona_seq,version,name,prompt_text,turn_wait_level,created_by_admin_user_seq,
 status,application_id,requested_by_admin_user_seq,requested_at)
 VALUES(1,1,'persona','prompt','NORMAL',1,'PENDING','00000000-0000-0000-0000-000000000005',1,now());
INSERT INTO faq_entries(question,answer,updated_by_admin_user_seq) VALUES('question','answer',1);
CREATE TABLE preserved_business AS
 SELECT 'handoff' AS source,to_jsonb(h) AS snapshot FROM handoff_requests h
 UNION ALL SELECT 'shipment',to_jsonb(h) FROM shipment_status_history h
 UNION ALL SELECT 'persona',to_jsonb(v) FROM ai_persona_versions v
 UNION ALL SELECT 'faq',to_jsonb(f) FROM faq_entries f;
SQL
cat "$MIGRATIONS/015-admin-deletion-audit.sql" > "$ROOT/admin-audit-failure.sql"
printf '\nSELECT 1/0;\n' >> "$ROOT/admin-audit-failure.sql"
if sql -1 -f "$ROOT/admin-audit-failure.sql" > "$ROOT/admin-audit-failure.log" 2>&1; then
 echo 'FAIL: audit rollback probe succeeded' >&2; exit 1
fi
test "$(sql -Atc "SELECT count(*) FROM information_schema.columns WHERE table_name='audit_logs' AND column_name='actor_name'")" = 0
test "$(sql -Atc "SELECT count(*) FROM pg_constraint WHERE contype='f' AND confrelid='admin_users'::regclass")" = 6
sql -1 -f "$MIGRATIONS/015-admin-deletion-audit.sql"
sql <<'SQL'
DELETE FROM admin_users WHERE admin_user_seq=1;
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM admin_sessions) THEN RAISE EXCEPTION 'Session did not cascade'; END IF;
 IF (SELECT actor_name FROM audit_logs WHERE audit_log_seq=1)<>'이력 관리자'
  OR (SELECT target_admin_name FROM audit_logs WHERE audit_log_seq=1)<>'이력 관리자' THEN
  RAISE EXCEPTION 'Existing admin names were lost'; END IF;
 IF EXISTS(SELECT 1 FROM audit_logs WHERE audit_log_seq=2 AND (actor_name IS NOT NULL OR target_admin_name IS NOT NULL))
  OR (SELECT actor_type FROM audit_logs WHERE audit_log_seq=3)<>'SYSTEM' THEN
  RAISE EXCEPTION 'Migration invented an unknown identity'; END IF;
 IF EXISTS(
  (SELECT source,snapshot FROM preserved_business EXCEPT
   (SELECT 'handoff',to_jsonb(h) FROM handoff_requests h
    UNION ALL SELECT 'shipment',to_jsonb(h) FROM shipment_status_history h
    UNION ALL SELECT 'persona',to_jsonb(v) FROM ai_persona_versions v
    UNION ALL SELECT 'faq',to_jsonb(f) FROM faq_entries f))
  UNION ALL
  ((SELECT 'handoff',to_jsonb(h) FROM handoff_requests h
    UNION ALL SELECT 'shipment',to_jsonb(h) FROM shipment_status_history h
    UNION ALL SELECT 'persona',to_jsonb(v) FROM ai_persona_versions v
    UNION ALL SELECT 'faq',to_jsonb(f) FROM faq_entries f)
   EXCEPT SELECT source,snapshot FROM preserved_business)
 ) THEN RAISE EXCEPTION 'Business data changed during migration/delete'; END IF;
 IF (SELECT count(*) FROM pg_constraint WHERE contype='f' AND confrelid='admin_users'::regclass)<>1
 THEN RAISE EXCEPTION 'Unexpected administrator FK'; END IF;
 BEGIN
  INSERT INTO audit_logs(actor_type,actor_seq,action,target_type,request_id,result,metadata)
   VALUES('AI',1,'INVALID','TEST',gen_random_uuid(),'SUCCESS','{}');
  RAISE EXCEPTION 'AI accepted an administrator identity';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE ai_persona_versions SET prompt_text='overwritten' WHERE ai_persona_version_seq=1;
  RAISE EXCEPTION 'Persona history protection lost';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
INSERT INTO audit_logs(actor_type,actor_name,action,target_type,request_id,result,metadata)
 VALUES('AI','AI','AI_CHECK','TEST',gen_random_uuid(),'SUCCESS','{}');
INSERT INTO admin_users(login_id,name,password_hash,role,status)
 VALUES('inactive','비활성','test','SUPERVISOR','INACTIVE');
SQL
echo 'PASS: admin audit upgrade backfills known names, retains logical history, cascades only sessions and rolls back atomically'
