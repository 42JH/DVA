-- 목록의 실제 정렬과 고객 범위. 기존 이력·FK·검색 총건수 계약은 바꾸지 않는다.
CREATE INDEX call_sessions_started_list_idx
  ON call_sessions(started_at DESC NULLS LAST,call_session_seq DESC);
CREATE INDEX orders_customer_created_list_idx
  ON orders(customer_seq,created_at DESC,order_seq DESC);
