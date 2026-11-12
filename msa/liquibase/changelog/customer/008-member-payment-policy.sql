ALTER TABLE organizations ALTER COLUMN monthly_billing_enabled SET DEFAULT true;
ALTER TABLE memberships
 ADD COLUMN monthly_billing_enabled boolean NOT NULL DEFAULT true,
 ADD COLUMN group_billing_enabled boolean NOT NULL DEFAULT false;

UPDATE memberships m SET group_billing_enabled=d.group_billing_enabled
 FROM departments d WHERE d.department_seq=m.department_seq;
