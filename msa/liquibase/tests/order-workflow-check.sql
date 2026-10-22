BEGIN;
DO $$
DECLARE o integer; v integer; outcome text;
BEGIN
 INSERT INTO orders(pickup_requested_at) VALUES(CURRENT_TIMESTAMP) RETURNING order_seq INTO o;
 BEGIN
  PERFORM prepare_submission(o);
  RAISE EXCEPTION 'Empty order accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 INSERT INTO order_parcels(order_seq,parcel_position,
 origin_name,origin_phone_number,origin_road_address,origin_jibun_address,origin_dong_name,origin_postal_code,origin_latitude,origin_longitude,
 destination_name,destination_phone_number,destination_road_address,destination_jibun_address,destination_dong_name,destination_postal_code,destination_latitude,destination_longitude,
 small_box_count,item_price)
 VALUES(o,1,'sender','01000000001','road','jibun','dong','12345',37,127,
 'recipient','01000000002','road','jibun','dong','12345',37,127,1,10000);
 SELECT version INTO v FROM orders WHERE order_seq=o;
 IF v<>2 THEN RAISE EXCEPTION 'Detail did not increment order version'; END IF;
 BEGIN
  PERFORM prepare_submission(o,v-1);
  RAISE EXCEPTION 'Stale order version accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 PERFORM prepare_submission(o,v);
 BEGIN
  UPDATE order_parcels SET small_box_count=2 WHERE order_seq=o;
  RAISE EXCEPTION 'Submitted detail changed';
 EXCEPTION WHEN check_violation THEN NULL; END;
 outcome=finish_submission(o,200,'{"ok":true,"parcelNo":"K7P3Q9XM","receivedAt":"2026-10-21T12:00:00+09:00"}');
 IF outcome<>'ACCEPTED' THEN RAISE EXCEPTION 'Valid response rejected'; END IF;
 IF to_regclass('shipments') IS NOT NULL THEN
  IF (SELECT count(*) FROM shipments s JOIN order_parcels p USING(order_parcel_seq) WHERE p.order_seq=o)<>1 THEN
   RAISE EXCEPTION 'Monolith shipment not created'; END IF;
 ELSE
  IF (SELECT count(*) FROM outbox_events WHERE event_type='OrderAccepted' AND aggregate_seq=o)<>1 THEN
   RAISE EXCEPTION 'Accepted event not stored'; END IF;
 END IF;
END $$;
ROLLBACK;
