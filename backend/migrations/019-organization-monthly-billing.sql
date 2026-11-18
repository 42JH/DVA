CREATE TABLE organization_billing_months (
 organization_seq integer NOT NULL REFERENCES organizations(organization_seq),
 billing_month date NOT NULL CHECK (extract(day FROM billing_month)=1),
 monthly_amount bigint NOT NULL DEFAULT 0 CHECK (monthly_amount BETWEEN 0 AND 9007199254740991),
 group_billing_amount bigint NOT NULL DEFAULT 0 CHECK (group_billing_amount BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY (organization_seq,billing_month)
);
CREATE TABLE order_billing_charges (
 order_seq integer PRIMARY KEY REFERENCES orders(order_seq),
 organization_seq integer NOT NULL REFERENCES organizations(organization_seq),
 billing_month date NOT NULL CHECK (extract(day FROM billing_month)=1),
 payment_method_type text NOT NULL CHECK (payment_method_type IN ('credit','groupBilling')),
 amount integer NOT NULL CHECK (amount>0),
 occurred_at timestamptz NOT NULL
);
CREATE INDEX billing_charge_month_idx ON order_billing_charges(organization_seq,billing_month);

-- A deployment from 018 may already contain settled orders. Charge each exactly once.
INSERT INTO order_billing_charges(order_seq,organization_seq,billing_month,payment_method_type,amount,occurred_at)
 SELECT order_seq,billing_organization_seq,date_trunc('month',paid_at AT TIME ZONE 'Asia/Seoul')::date,
  payment_method_type,total_amount,paid_at FROM orders
 WHERE paid_at IS NOT NULL AND billing_organization_seq IS NOT NULL AND payment_method_type IN ('credit','groupBilling');
INSERT INTO organization_billing_months(organization_seq,billing_month,monthly_amount,group_billing_amount)
 SELECT organization_seq,billing_month,coalesce(sum(amount) FILTER(WHERE payment_method_type='credit'),0),
  coalesce(sum(amount) FILTER(WHERE payment_method_type='groupBilling'),0)
 FROM order_billing_charges GROUP BY organization_seq,billing_month;
INSERT INTO audit_logs(actor_type,action,target_type,target_seq,request_id,result,metadata)
 SELECT 'SYSTEM','BILLING_MONTH_INITIALIZED','ORGANIZATION',b.organization_seq,gen_random_uuid(),'SUCCESS',
  jsonb_build_object('billingMonth',to_char(b.billing_month,'YYYY-MM'),'paymentMethodType',p.method,'amountBefore',0,'amountAfter',0)
 FROM organization_billing_months b CROSS JOIN (VALUES('credit'),('groupBilling')) p(method);
INSERT INTO audit_logs(actor_type,action,target_type,target_seq,request_id,result,metadata)
 SELECT 'SYSTEM','BILLING_AMOUNT_INCREASED','ORGANIZATION',organization_seq,gen_random_uuid(),'SUCCESS',
  jsonb_build_object('billingMonth',to_char(billing_month,'YYYY-MM'),'paymentMethodType',payment_method_type,
   'amountBefore',0,'amountAfter',sum(amount))
 FROM order_billing_charges GROUP BY organization_seq,billing_month,payment_method_type;
