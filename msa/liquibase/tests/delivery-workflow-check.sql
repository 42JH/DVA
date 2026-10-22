BEGIN;
DO $$
DECLARE msg uuid:=gen_random_uuid(); cmd uuid:=gen_random_uuid(); s integer; h integer;
BEGIN
 PERFORM receive_accepted_order(msg,'{"orderSeq":1,"orderParcelSeqs":[11,12]}');
 PERFORM receive_accepted_order(msg,'{"orderSeq":1,"orderParcelSeqs":[11,12]}');
 IF (SELECT count(*) FROM shipments)<>2 OR (SELECT count(*) FROM shipment_status_history)<>2 THEN
  RAISE EXCEPTION 'Duplicate event created extra shipments/history'; END IF;
 BEGIN
  PERFORM receive_accepted_order(msg,'{"orderSeq":1,"orderParcelSeqs":[13]}');
  RAISE EXCEPTION 'Conflicting event accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 SELECT shipment_seq INTO STRICT s FROM shipments WHERE order_parcel_seq=11;
 h=change_shipment_status(s,1,'paid',cmd,1);
 IF change_shipment_status(s,1,'paid',cmd,1)<>h THEN RAISE EXCEPTION 'Retry not idempotent'; END IF;
 BEGIN
  PERFORM change_shipment_status(s,1,'received',gen_random_uuid(),1);
  RAISE EXCEPTION 'Stale shipment version accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  PERFORM change_shipment_status(s,2,'INVALID',gen_random_uuid(),1);
  RAISE EXCEPTION 'Invalid shipment status accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 IF (SELECT version FROM shipments WHERE shipment_seq=s)<>2 OR
    (SELECT count(*) FROM shipment_status_history WHERE shipment_seq=s)<>2 THEN
  RAISE EXCEPTION 'Rejected request left partial changes'; END IF;
 BEGIN
  PERFORM receive_accepted_order(gen_random_uuid(),'{"orderSeq":2,"orderParcelSeqs":[15,12]}');
  RAISE EXCEPTION 'Duplicate parcel accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 IF EXISTS(SELECT 1 FROM shipments WHERE order_parcel_seq=15) OR (SELECT count(*) FROM inbox_events)<>1 THEN
  RAISE EXCEPTION 'Failed event was partially committed'; END IF;
END $$;
ROLLBACK;
