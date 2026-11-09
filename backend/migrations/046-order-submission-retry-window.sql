SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

ALTER TABLE orders ADD COLUMN submission_first_attempt_at timestamptz,
 ADD COLUMN submission_last_attempt_at timestamptz;
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
 'COLLECTING','notPaid','PAID','SUBMITTING','SUBMITTING_FAILED','ACCEPTED','SUBMISSION_FAILED','CANCELLED'));

-- A migration or restart must not grant an old submission another ten minutes.
ALTER TABLE orders DISABLE TRIGGER order_header_timestamp;
UPDATE orders o SET submission_first_attempt_at=LEAST(o.updated_at,COALESCE((
 SELECT min(a.occurred_at) FROM audit_logs a WHERE a.target_type='ORDER' AND a.target_seq=o.order_seq
  AND a.action IN ('ORDER_SUBMISSION_STARTED','ORDER_RESUBMISSION_STARTED') AND a.result='SUCCESS'),o.paid_at,o.created_at)),
 submission_last_attempt_at=o.updated_at WHERE o.status IN ('SUBMITTING','SUBMISSION_FAILED');
UPDATE orders SET status='SUBMITTING_FAILED' WHERE status='SUBMISSION_FAILED'
 AND submission_first_attempt_at>statement_timestamp()-interval '10 minutes';
ALTER TABLE orders ENABLE TRIGGER order_header_timestamp;

CREATE INDEX orders_submission_retry_idx ON orders(submission_last_attempt_at,order_seq)
 WHERE deleted_at IS NULL AND status IN ('PAID','SUBMITTING','SUBMITTING_FAILED');

COMMENT ON COLUMN orders.submission_first_attempt_at IS '최초 디버 전송 시각. 자동 재시도 10분 기한은 재호출·재시작으로 연장하지 않음';
COMMENT ON COLUMN orders.submission_last_attempt_at IS '마지막 디버 전송 시작 시각. 10초 응답 제한·1분 재시도 간격·이전 시도 응답 차단 기준';
