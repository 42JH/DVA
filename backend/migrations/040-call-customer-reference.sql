-- 고객 등록 여부와 무관하게 통화를 보존하고, 확인된 고객 번호는 논리 참조로 고정한다.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

ALTER TABLE call_sessions ADD COLUMN customer_seq integer CHECK (customer_seq > 0);

-- shortcut: 기존 문의는 현재 번호 연결만 복원하며, 과거 연결 정정에는 별도 전화번호 이력이 필요하다.
UPDATE call_sessions c SET customer_seq=COALESCE(
 (SELECT o.customer_seq FROM orders o WHERE o.order_seq=c.order_seq),
 (SELECT u.customer_seq FROM customers u WHERE u.phone_number=c.caller_phone_number)
);
