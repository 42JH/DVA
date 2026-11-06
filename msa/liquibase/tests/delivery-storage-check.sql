BEGIN;
DO $$
DECLARE s integer; invalid_case text; request uuid:=gen_random_uuid();
BEGIN
 -- Only the monolith has the foreign-owner parcel table and its physical FK.
 IF to_regclass('public.order_parcels') IS NOT NULL THEN
  INSERT INTO orders(order_seq) OVERRIDING SYSTEM VALUE VALUES(998877);
  INSERT INTO order_parcels(order_parcel_seq,order_seq,parcel_position)
  OVERRIDING SYSTEM VALUE VALUES(998877,998877,1);
 END IF;
 INSERT INTO shipments(order_parcel_seq,tracking_number,status) VALUES(998877,'DVA-storage-check','paid') RETURNING shipment_seq INTO s;
 INSERT INTO shipment_status_history(shipment_seq,request_id,to_status,actor_type) VALUES(s,request,'paid','SYSTEM');
 INSERT INTO shipment_status_history(shipment_seq,request_id,from_status,to_status,actor_type)
 VALUES(s,gen_random_uuid(),'notPaid','canceled','AI');
 FOREACH invalid_case IN ARRAY ARRAY[
  'actor_type=''ADMIN'',actor_admin_user_seq=NULL', 'actor_type=''ADMIN'',actor_admin_user_seq=0',
  'actor_type=''AI'',actor_admin_user_seq=1', 'actor_type=''SYSTEM'',actor_admin_user_seq=1',
  'actor_type=''UNKNOWN''', 'from_status=''UNKNOWN''', 'to_status=''UNKNOWN'''
 ] LOOP
  BEGIN
   EXECUTE format('UPDATE shipment_status_history SET %s WHERE request_id=$1',invalid_case) USING request;
   RAISE EXCEPTION 'Invalid shipment history accepted: %',invalid_case;
  EXCEPTION WHEN check_violation THEN NULL; END;
 END LOOP;
 UPDATE shipment_status_history SET actor_type='ADMIN',actor_admin_user_seq=998877 WHERE request_id=request;
 BEGIN
  INSERT INTO shipment_status_history(shipment_seq,request_id,to_status,actor_type) VALUES(s,request,'paid','SYSTEM');
  RAISE EXCEPTION 'Duplicate shipment command';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
  INSERT INTO shipment_status_history(shipment_seq,request_id,to_status,actor_type) VALUES(-99999,gen_random_uuid(),'paid','SYSTEM');
  RAISE EXCEPTION 'Orphan shipment history';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN
  INSERT INTO shipments(order_parcel_seq,tracking_number) VALUES(998877,'another');
  RAISE EXCEPTION 'Second shipment for one parcel';
 EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;
ROLLBACK;
