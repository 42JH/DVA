BEGIN;
DO $$
DECLARE id uuid := gen_random_uuid(); tx uuid := gen_random_uuid();
BEGIN
 INSERT INTO order_audit_preparations(event_id,transaction_id,audit) VALUES(id,tx,'{"original":true}');
 IF NOT EXISTS(SELECT 1 FROM order_audit_preparations WHERE event_id=id AND NOT aborted AND prepared_at IS NOT NULL) THEN
  RAISE EXCEPTION 'Order audit preparation missing'; END IF;
 BEGIN
  INSERT INTO order_audit_preparations(event_id,transaction_id,audit) VALUES(id,tx,'{}');
  RAISE EXCEPTION 'Duplicate preparation accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
  INSERT INTO order_audit_preparations(event_id,transaction_id,audit) VALUES(gen_random_uuid(),tx,NULL);
  RAISE EXCEPTION 'Empty active preparation accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE order_audit_preparations SET aborted=true WHERE event_id=id;
  RAISE EXCEPTION 'Aborted audit retained private payload';
 EXCEPTION WHEN check_violation THEN NULL; END;
 UPDATE order_audit_preparations SET audit=NULL,aborted=true WHERE event_id=id;
 IF NOT EXISTS(SELECT 1 FROM order_audit_preparations WHERE event_id=id AND aborted AND audit IS NULL) THEN
  RAISE EXCEPTION 'Abort proof missing'; END IF;
END $$;
ROLLBACK;
