BEGIN;
DO $$
DECLARE c integer; a integer; b integer;
BEGIN
 IF to_regclass('public.customer_preferences') IS NOT NULL THEN
  RAISE EXCEPTION 'Removed preferences table still exists';
 END IF;
 INSERT INTO customers(name,phone_number,status) VALUES('개인 테스트','01000000001','ACTIVE') RETURNING customer_seq INTO c;
 IF EXISTS(SELECT 1 FROM memberships WHERE customer_seq=c) THEN RAISE EXCEPTION 'Personal customer requires no membership'; END IF;
 INSERT INTO organizations(name,status) VALUES('기업 A','ACTIVE') RETURNING organization_seq INTO a;
 INSERT INTO organizations(name,status) VALUES('기업 B','ACTIVE') RETURNING organization_seq INTO b;
 INSERT INTO memberships(customer_seq,organization_seq,employee_no,status) VALUES(c,a,'001','ACTIVE');
 IF (SELECT role FROM memberships WHERE customer_seq=c)<>'MEMBER' THEN
  RAISE EXCEPTION 'Default role must be MEMBER';
 END IF;
 BEGIN
  UPDATE memberships SET role='INVALID' WHERE customer_seq=c;
  RAISE EXCEPTION 'Invalid role accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO memberships(customer_seq,organization_seq,employee_no,role,status) VALUES(c,b,'001','MEMBER','ACTIVE');
  RAISE EXCEPTION 'Multiple company memberships were accepted';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
 INSERT INTO customers(name,phone_number,status) VALUES('동료 테스트','01000000002','ACTIVE') RETURNING customer_seq INTO c;
 INSERT INTO memberships(customer_seq,organization_seq,employee_no,role,status) VALUES(c,a,'002','ORG_ADMIN','ACTIVE');
 IF (SELECT count(*) FROM memberships WHERE organization_seq=a)<>2 THEN
  RAISE EXCEPTION 'Company must allow multiple customers';
 END IF;
 BEGIN
  INSERT INTO memberships(customer_seq,organization_seq,employee_no,role,status)
  VALUES(2147483647,a,'003','MEMBER','ACTIVE');
  RAISE EXCEPTION 'Invalid customer FK accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
 -- Existing customer c belongs to company a with employee number 002.
 BEGIN
  UPDATE memberships SET employee_no='001' WHERE customer_seq=c;
  RAISE EXCEPTION 'Duplicate employee number accepted within a company';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
 BEGIN
  UPDATE memberships SET employee_no=NULL WHERE customer_seq=c;
  RAISE EXCEPTION 'Null employee number accepted';
 EXCEPTION WHEN not_null_violation THEN NULL;
 END;
 BEGIN
  UPDATE memberships SET employee_no='   ' WHERE customer_seq=c;
  RAISE EXCEPTION 'Blank employee number accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  UPDATE customers SET status='SUSPENDED' WHERE customer_seq=c;
  RAISE EXCEPTION 'Suspended customer accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  UPDATE organizations SET status='SUSPENDED' WHERE organization_seq=a;
  RAISE EXCEPTION 'Suspended organization accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=c;
 UPDATE organizations SET status='INACTIVE' WHERE organization_seq=a;
 UPDATE memberships SET status='INACTIVE' WHERE customer_seq=c;
 INSERT INTO customers(name,phone_number,status)
 VALUES('Other company employee','01000000003','ACTIVE') RETURNING customer_seq INTO c;
 INSERT INTO memberships(customer_seq,organization_seq,employee_no,status)
 VALUES(c,b,'001','ACTIVE');
 IF (SELECT employee_no FROM memberships WHERE customer_seq=c)<>'001' THEN
  RAISE EXCEPTION 'Employee number leading zeros were not preserved';
 END IF;
 UPDATE memberships SET employee_no='A001' WHERE customer_seq=c;
END $$;
ROLLBACK;
