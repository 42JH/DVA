BEGIN;
DO $$
DECLARE o integer; second_order integer; p integer; v integer; closed timestamptz;
 request uuid:=gen_random_uuid(); invalid_case text;
BEGIN
 IF NOT valid_parcel_address('{"name":"sender","phoneNumber":"01012345678","roadAddress":"road","jibunAddress":"lot","dongName":"dong","postalCode":"12345"}')
  OR valid_parcel_address('{"name":"sender","phoneNumber":"01012345678","roadAddress":"road","jibunAddress":"lot","dongName":"dong","postalCode":"12345","latitude":37,"longitude":127}') THEN
  RAISE EXCEPTION 'Coordinate retirement differs from source 043'; END IF;
 INSERT INTO orders DEFAULT VALUES RETURNING order_seq INTO o;
 IF (SELECT payment_method_type FROM orders WHERE order_seq=o) IS NOT NULL THEN
  RAISE EXCEPTION 'Undecided payment method was invented'; END IF;
 INSERT INTO order_parcels(order_seq,parcel_position,item_price) VALUES(o,1,0) RETURNING order_parcel_seq INTO p;
 IF (SELECT notified_price FROM order_parcels WHERE order_parcel_seq=p) IS NOT NULL
  OR (SELECT version FROM orders WHERE order_seq=o)<>2 THEN
  RAISE EXCEPTION 'Price defaults or parent version differ'; END IF;
 UPDATE order_parcels SET item_price=item_price WHERE order_parcel_seq=p;
 IF (SELECT version FROM orders WHERE order_seq=o)<>2 THEN RAISE EXCEPTION 'No-op advanced version'; END IF;
 UPDATE order_parcels SET item_price=9007199254740991,notified_price=1 WHERE order_parcel_seq=p;
 UPDATE orders SET payment_method_type='billing',pickup_requested_at=clock_timestamp() WHERE order_seq=o;
 IF (SELECT version FROM orders WHERE order_seq=o)<>4 THEN RAISE EXCEPTION 'Content/header version differs'; END IF;
 UPDATE orders SET status='notPaid',total_amount=1,payment_due_at=clock_timestamp()+interval '10 minutes' WHERE order_seq=o;
 IF (SELECT version FROM orders WHERE order_seq=o)<>4 THEN RAISE EXCEPTION 'Status advanced content version'; END IF;
 BEGIN
  UPDATE order_parcels SET client_comment='forbidden' WHERE order_parcel_seq=p;
  RAISE EXCEPTION 'Finalized snapshot changed';
 EXCEPTION WHEN check_violation THEN NULL; END;
 INSERT INTO orders DEFAULT VALUES RETURNING order_seq INTO second_order;
 BEGIN
  UPDATE order_parcels SET order_seq=second_order WHERE order_parcel_seq=p;
  RAISE EXCEPTION 'Parcel moved to another order';
 EXCEPTION WHEN check_violation THEN NULL; END;
 PERFORM set_config('dva.admin_order_edit',second_order::text,true);
 BEGIN
  UPDATE order_parcels SET client_comment='wrong scope' WHERE order_parcel_seq=p;
  RAISE EXCEPTION 'Another admin scope authorized edit';
 EXCEPTION WHEN check_violation THEN NULL; END;
 PERFORM set_config('dva.admin_order_edit',o::text,true);
 UPDATE order_parcels SET client_comment='verified admin edit' WHERE order_parcel_seq=p;
 BEGIN
  DELETE FROM order_parcels WHERE order_parcel_seq=p;
  RAISE EXCEPTION 'Admin physically removed snapshot';
 EXCEPTION WHEN check_violation THEN NULL; END;
 PERFORM set_config('dva.admin_order_edit','',true);
 UPDATE orders SET status='CANCELLED' WHERE order_seq=o;
 SELECT closed_at,version INTO closed,v FROM orders WHERE order_seq=o;
 IF closed IS NULL OR (SELECT status FROM order_parcels WHERE order_parcel_seq=p)<>'CANCELLED' THEN
  RAISE EXCEPTION 'Cancellation did not close/cancel parcels'; END IF;
 UPDATE orders SET status='COLLECTING',closed_at=clock_timestamp()+interval '1 year',deleted_at=clock_timestamp() WHERE order_seq=o;
 IF (SELECT closed_at FROM orders WHERE order_seq=o) IS DISTINCT FROM closed THEN
  RAISE EXCEPTION 'First closure was extended'; END IF;
 BEGIN
  UPDATE order_parcels SET item_price=1 WHERE order_parcel_seq=p;
  RAISE EXCEPTION 'Cancelled snapshot changed';
 EXCEPTION WHEN check_violation THEN NULL; END;
 UPDATE order_parcels SET item_price=item_price WHERE order_parcel_seq=p;
 IF (SELECT version FROM orders WHERE order_seq=o)<>v THEN RAISE EXCEPTION 'Cancelled no-op advanced version'; END IF;
 PERFORM set_config('dva.retention_order',o::text,true);
 BEGIN
  DELETE FROM order_parcels WHERE order_parcel_seq=p;
  RAISE EXCEPTION 'Live snapshot purged';
 EXCEPTION WHEN check_violation THEN NULL; END;
 INSERT INTO orders(status,closed_at,created_at) VALUES('CANCELLED',clock_timestamp()-interval '6 years',clock_timestamp()-interval '6 years') RETURNING order_seq INTO second_order;
 PERFORM set_config('dva.admin_order_edit',second_order::text,true);
 INSERT INTO order_parcels(order_seq,parcel_position) VALUES(second_order,1);
 PERFORM set_config('dva.admin_order_edit','',true);
 PERFORM set_config('dva.retention_order',second_order::text,true);
 DELETE FROM order_parcels WHERE order_seq=second_order;
 IF EXISTS(SELECT 1 FROM order_parcels WHERE order_seq=second_order) THEN RAISE EXCEPTION 'Expired snapshot not purged'; END IF;

 INSERT INTO order_payment_requests(payment_request_id,order_seq,amount,expires_at)
 VALUES(request,o,1,clock_timestamp()+interval '10 minutes');
 BEGIN
  INSERT INTO order_payment_requests(order_seq,amount,expires_at) VALUES(o,1,clock_timestamp());
  RAISE EXCEPTION 'Two active payment requests';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 FOREACH invalid_case IN ARRAY ARRAY[
  'amount=0','amount=-1','approval_claim_id=gen_random_uuid()',
  'approval_claimed_until=clock_timestamp()', 'completed_at=clock_timestamp()',
  'provider_reference=''uncompleted''', 'provider_reference=''''',
  'provider_payment_key=repeat(''x'',201)', 'notification_status=''INVALID''',
  'completion_notification_status=''INVALID'''
 ] LOOP
  BEGIN
   EXECUTE format('UPDATE order_payment_requests SET %s WHERE payment_request_id=$1',invalid_case) USING request;
   RAISE EXCEPTION 'Invalid payment accepted: %',invalid_case;
  EXCEPTION WHEN check_violation THEN NULL; END;
 END LOOP;
 UPDATE order_payment_requests SET approval_claim_id=gen_random_uuid(),approval_claimed_until=clock_timestamp()+interval '1 minute',
  approval_started_at=clock_timestamp(),provider_payment_key='verified-key',approval_next_check_at=clock_timestamp()+interval '1 minute',
  notification_status='UNKNOWN' WHERE payment_request_id=request;
 UPDATE order_payment_requests SET completed_at=clock_timestamp(),provider_reference='verified-reference',
  completion_notification_status='PENDING',approval_claim_id=NULL,approval_claimed_until=NULL WHERE payment_request_id=request;
 BEGIN
  UPDATE order_payment_requests SET invalidated_at=clock_timestamp() WHERE payment_request_id=request;
  RAISE EXCEPTION 'Completed payment invalidated';
 EXCEPTION WHEN check_violation THEN NULL; END;
 INSERT INTO order_payment_requests(order_seq,amount,expires_at) VALUES(o,2147483647,clock_timestamp());
 INSERT INTO organization_billing_months(organization_seq,billing_month,monthly_amount,group_billing_amount,organization_name)
 VALUES(998877,'2026-11-01',9007199254740991,9007199254740991,'historical company');
 FOREACH invalid_case IN ARRAY ARRAY['monthly_amount=-1','group_billing_amount=9007199254740992','billing_month=''2026-11-02'''] LOOP
  BEGIN
   EXECUTE 'UPDATE organization_billing_months SET '||invalid_case||' WHERE organization_seq=998877';
   RAISE EXCEPTION 'Invalid billing month accepted: %',invalid_case;
  EXCEPTION WHEN check_violation THEN NULL; END;
 END LOOP;
 INSERT INTO order_billing_charges(order_seq,organization_seq,billing_month,payment_method_type,amount,occurred_at)
 VALUES(o,998877,'2026-11-01','groupBilling',2147483647,clock_timestamp());
 FOREACH invalid_case IN ARRAY ARRAY['amount=0','payment_method_type=''billing''','billing_month=''2026-11-02'''] LOOP
  BEGIN
   EXECUTE format('UPDATE order_billing_charges SET %s WHERE order_seq=$1',invalid_case) USING o;
   RAISE EXCEPTION 'Invalid billing charge accepted: %',invalid_case;
  EXCEPTION WHEN check_violation THEN NULL; END;
 END LOOP;
 BEGIN
  INSERT INTO order_billing_charges(order_seq,organization_seq,billing_month,payment_method_type,amount,occurred_at)
  VALUES(-99999,998877,'2026-11-01','credit',1,clock_timestamp());
  RAISE EXCEPTION 'Orphan billing charge accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 INSERT INTO empty_ai_order_results(request_id,call_session_seq) VALUES(request,998877);
 BEGIN
  INSERT INTO empty_ai_order_results(request_id,call_session_seq) VALUES(gen_random_uuid(),998877);
  RAISE EXCEPTION 'Second empty result for one call';
 EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;
ROLLBACK;
