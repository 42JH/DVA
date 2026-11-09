SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

ALTER TABLE order_payment_requests ADD COLUMN approval_next_check_at timestamptz;
COMMENT ON COLUMN order_payment_requests.approval_next_check_at IS
 '자동 승인 조회의 다음 선택 시각. NULL은 즉시 조회하며 기존 결제 키·승인 기록은 보존';

DROP INDEX order_payment_reconcile_idx;
CREATE INDEX order_payment_reconcile_idx ON order_payment_requests
 ((COALESCE(approval_next_check_at,approval_started_at)),payment_request_id)
 WHERE provider_payment_key IS NOT NULL AND approval_started_at IS NOT NULL
  AND completed_at IS NULL AND invalidated_at IS NULL;
