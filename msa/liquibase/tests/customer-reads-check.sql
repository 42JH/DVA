BEGIN;
DO $$
DECLARE c integer; o integer; other_company integer; d integer; m integer;
BEGIN
 INSERT INTO customers(name,phone_number,status) VALUES('read check','01080000000','ACTIVE') RETURNING customer_seq INTO c;
 IF (SELECT monthly_billing_enabled OR address_data IS NOT NULL OR deleted_at IS NOT NULL FROM customers WHERE customer_seq=c) THEN
  RAISE EXCEPTION 'Customer defaults differ'; END IF;
 UPDATE customers SET address_data='{"roadAddress":"Road","jibunAddress":"Lot","dongName":"Dong","postalCode":"01234"}' WHERE customer_seq=c;
 BEGIN
  UPDATE customers SET address_data=address_data||'{"latitude":37}' WHERE customer_seq=c;
  RAISE EXCEPTION 'Retired customer coordinates accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 INSERT INTO organizations(name,status) VALUES('read company','ACTIVE') RETURNING organization_seq INTO o;
 INSERT INTO organizations(name,status) VALUES('other company','ACTIVE') RETURNING organization_seq INTO other_company;
 IF (SELECT created_at IS NULL OR NOT monthly_billing_enabled OR deleted_at IS NOT NULL FROM organizations WHERE organization_seq=o) THEN
  RAISE EXCEPTION 'Organization defaults differ'; END IF;
 INSERT INTO departments(organization_seq,name) VALUES(o,'Team') RETURNING department_seq INTO d;
 INSERT INTO memberships(customer_seq,organization_seq,employee_no,status) VALUES(c,o,'001','ACTIVE') RETURNING membership_seq INTO m;
 IF (SELECT department_seq IS NOT NULL FROM memberships WHERE membership_seq=m) THEN RAISE EXCEPTION 'Department must remain optional'; END IF;
 UPDATE memberships SET department_seq=d WHERE membership_seq=m;
 BEGIN
  UPDATE memberships SET organization_seq=other_company WHERE membership_seq=m;
  RAISE EXCEPTION 'Cross-company department accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 UPDATE memberships SET deleted_at=clock_timestamp() WHERE membership_seq=m;
 INSERT INTO memberships(customer_seq,organization_seq,employee_no,status) VALUES(c,o,'001','ACTIVE');
 UPDATE customers SET deleted_at=clock_timestamp() WHERE customer_seq=c;
 INSERT INTO customers(name,phone_number,status) VALUES('new identity','01080000000','ACTIVE');
 UPDATE departments SET deleted_at=clock_timestamp() WHERE department_seq=d;
 INSERT INTO departments(organization_seq,name) VALUES(o,'Team');
 IF (SELECT count(*) FROM customers WHERE phone_number='01080000000')<>2 THEN RAISE EXCEPTION 'Soft-delete history lost'; END IF;
END $$;
ROLLBACK;
