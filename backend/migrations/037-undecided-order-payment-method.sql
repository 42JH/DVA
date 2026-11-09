-- 미수집 결제수단은 미정으로 보존하며 기존 결제·접수 이력은 변경하지 않는다.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

ALTER TABLE orders
 ALTER COLUMN payment_method_type DROP DEFAULT,
 ALTER COLUMN payment_method_type DROP NOT NULL;

ALTER TABLE orders ADD CONSTRAINT orders_payment_method_required_check
 CHECK (payment_method_type IS NOT NULL OR status IN ('COLLECTING','CANCELLED'));
