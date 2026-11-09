SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- Orders and drafts allocate from the same sequence; a reservation is not an order row.
ALTER TABLE order_parcel_drafts ADD COLUMN reserved_order_seq integer NOT NULL
  DEFAULT nextval('orders_order_seq_seq'::regclass) CHECK(reserved_order_seq>0);
COMMENT ON COLUMN order_parcel_drafts.reserved_order_seq IS
  '실제 주문과 같은 시퀀스의 예약번호. 재개 사본은 원본 번호를 이어 쓰며 여러 READY 배송은 대표 번호 하나로 주문을 생성한다.';

-- RESUMED rows keep their old number for history; only one current draft owns it.
CREATE UNIQUE INDEX order_parcel_drafts_reserved_order_key
  ON order_parcel_drafts(reserved_order_seq) WHERE status<>'RESUMED';
