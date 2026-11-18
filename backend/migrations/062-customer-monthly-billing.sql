ALTER TABLE order_billing_charges
 ALTER COLUMN organization_seq DROP NOT NULL,
 ADD COLUMN customer_seq integer,
 ADD CONSTRAINT order_billing_charge_target CHECK (
  (organization_seq IS NOT NULL AND customer_seq IS NULL)
  OR (organization_seq IS NULL AND customer_seq IS NOT NULL AND payment_method_type='credit')
 );

CREATE INDEX billing_charge_customer_month_idx
 ON order_billing_charges(customer_seq,billing_month) WHERE customer_seq IS NOT NULL;
