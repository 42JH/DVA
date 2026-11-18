-- payment_card_seq references the customer-owned payment_cards table.
ALTER TABLE order_payment_requests
 ADD COLUMN payment_card_seq integer,
 ADD COLUMN card_payment_order_id uuid NOT NULL DEFAULT gen_random_uuid(),
 ADD COLUMN card_payment_failed boolean NOT NULL DEFAULT false;
CREATE INDEX payment_card_requests_pending ON order_payment_requests(created_at)
 WHERE payment_card_seq IS NOT NULL AND completed_at IS NULL AND invalidated_at IS NULL AND NOT card_payment_failed;
