BEGIN;
SET LOCAL session_replication_role='replica';
INSERT INTO orders(order_seq,customer_seq,status,payment_method_type,created_by_admin_user_seq,version,total_amount,created_at,updated_at,deleted_at)
 OVERRIDING SYSTEM VALUE
 SELECT n,321,CASE WHEN n=106 THEN 'CANCELLED' ELSE 'COLLECTING' END,NULL,77,23,10000,
 CASE WHEN n=103 THEN '2000-01-01Z'::timestamptz ELSE '2030-01-01Z'::timestamptz END,'2030-02-01Z',
 CASE WHEN n=103 THEN '2030-03-01Z'::timestamptz END FROM generate_series(100,106) n;
INSERT INTO order_parcels(order_parcel_seq,order_seq,parcel_position,status,origin_name,origin_phone_number,
 origin_road_address,origin_jibun_address,origin_detail_address,origin_dong_name,origin_postal_code,origin_pin_scope,origin_pin_seq,
 destination_name,destination_phone_number,destination_road_address,destination_jibun_address,destination_detail_address,destination_dong_name,destination_postal_code,
 document_count,small_box_count,medium_box_count,big_box_count,other_item_description,client_comment,item_price,notified_price)
 OVERRIDING SYSTEM VALUE SELECT n*10,n,1,'ACTIVE','보존 출발','01012345678','도로','지번','상세','동','01234','PERSONAL',99,
 '보존 도착','01087654321','도로2','지번2','상세2','동2','54321',1,2,3,4,'기타 물품','과거 메모',100000,10000
 FROM generate_series(100,104) n;
INSERT INTO order_parcels(order_parcel_seq,order_seq,parcel_position,status,document_count,other_item_description,client_comment)
 OVERRIDING SYSTEM VALUE VALUES(1001,100,2,'CANCELLED',0,'','');
COMMIT;
