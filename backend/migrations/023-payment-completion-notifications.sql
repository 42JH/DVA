-- S15P31D109-140: durable payment completion notices, separate from payment links.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE order_payment_requests
 ADD COLUMN completion_notification_status text NOT NULL DEFAULT 'WAITING'
  CHECK (completion_notification_status IN ('WAITING','PENDING','SENDING','SENT','FAILED','UNKNOWN')),
 ADD COLUMN completion_notification_attempted_at timestamptz,
 ADD COLUMN completion_notification_sent_at timestamptz;

-- Include verified payments made before completion notices were introduced.
UPDATE order_payment_requests SET completion_notification_status='PENDING'
 WHERE completed_at IS NOT NULL;
CREATE INDEX order_payment_completion_pending_idx ON order_payment_requests(completed_at)
 WHERE completion_notification_status IN ('WAITING','PENDING') AND completed_at IS NOT NULL;
COMMENT ON COLUMN order_payment_requests.completion_notification_status IS
 '결제 완료 안내 발송 상태. WAITING은 미결제, UNKNOWN은 자동 재발송하지 않음';
