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
 INSERT INTO memberships(customer_seq,organization_seq,status) VALUES(c,a,'ACTIVE');
 IF (SELECT role FROM memberships WHERE customer_seq=c)<>'MEMBER' THEN
  RAISE EXCEPTION 'Default role must be MEMBER';
 END IF;
 BEGIN
  UPDATE memberships SET role='INVALID' WHERE customer_seq=c;
  RAISE EXCEPTION 'Invalid role accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO memberships(customer_seq,organization_seq,role,status) VALUES(c,b,'MEMBER','ACTIVE');
  RAISE EXCEPTION 'Multiple company memberships were accepted';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
 INSERT INTO customers(name,phone_number,status) VALUES('동료 테스트','01000000002','ACTIVE') RETURNING customer_seq INTO c;
 INSERT INTO memberships(customer_seq,organization_seq,role,status) VALUES(c,a,'ORG_ADMIN','ACTIVE');
 IF (SELECT count(*) FROM memberships WHERE organization_seq=a)<>2 THEN
  RAISE EXCEPTION 'Company must allow multiple customers';
 END IF;
 BEGIN
  INSERT INTO memberships(customer_seq,organization_seq,role,status)
  VALUES(2147483647,a,'MEMBER','ACTIVE');
  RAISE EXCEPTION 'Invalid customer FK accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
END $$;
ROLLBACK;
