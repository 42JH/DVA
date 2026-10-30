SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE order_payment_requests
 ADD COLUMN provider_payment_key text UNIQUE CHECK (length(provider_payment_key) BETWEEN 1 AND 200),
 ADD COLUMN provider_approved_at timestamptz,
 ADD COLUMN approval_claim_id uuid,
 ADD COLUMN approval_claimed_until timestamptz,
 ADD COLUMN notification_status text NOT NULL DEFAULT 'PENDING'
  CHECK (notification_status IN ('PENDING','SENDING','SENT','FAILED','UNKNOWN')),
 ADD COLUMN notification_attempted_at timestamptz,
 ADD COLUMN notification_sent_at timestamptz,
 ADD CONSTRAINT payment_approval_claim_pair CHECK ((approval_claim_id IS NULL)=(approval_claimed_until IS NULL));
CREATE INDEX order_payment_notification_pending_idx ON order_payment_requests(created_at)
 WHERE notification_status='PENDING' AND invalidated_at IS NULL AND completed_at IS NULL;
CREATE INDEX order_payment_reconcile_idx ON order_payment_requests(approval_started_at)
 WHERE provider_payment_key IS NOT NULL AND completed_at IS NULL AND invalidated_at IS NULL;
COMMENT ON COLUMN order_payment_requests.provider_payment_key IS '토스 승인 전 저장. 응답 유실·재기동 시 조회로 결과 확인';
COMMENT ON COLUMN order_payment_requests.notification_status IS '결제 안내 발송 결과. UNKNOWN은 자동 재발송하지 않음';
