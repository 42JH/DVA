\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.expect_error(command text, expected_state text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 BEGIN
  EXECUTE command;
 EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE=expected_state THEN RETURN; END IF;
  RAISE;
 END;
 RAISE EXCEPTION 'Expected SQLSTATE %, but command succeeded: %',expected_state,command;
END $$;

DO $$
DECLARE n integer;
BEGIN
 SELECT count(*) INTO n FROM pg_tables WHERE schemaname='public';
 IF n<>19 THEN RAISE EXCEPTION 'Expected 19 public tables, got %',n; END IF;
 SELECT count(*) INTO n FROM pg_constraint c JOIN pg_namespace s ON s.oid=c.connamespace
 WHERE s.nspname='public' AND c.contype='f';
 IF n<>18 THEN RAISE EXCEPTION 'Expected 18 foreign keys, got %',n; END IF;
 SELECT count(*) INTO n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
 JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='public' AND NOT t.tgisinternal;
 IF n<>9 THEN RAISE EXCEPTION 'Expected 9 business triggers, got %',n; END IF;
 IF NOT EXISTS(SELECT 1 FROM pbx_webhooks.call_ended_events WHERE recording_id='migration-preservation-test') THEN
  RAISE EXCEPTION 'Existing PBX receipt was lost'; END IF;
END $$;

DO $$
DECLARE customer_id integer; other_customer integer; company_id integer; other_company integer;
 pin_id integer; order_id integer; parcel_id integer; call_id integer; admin_id integer;
 shipment_id integer; persona_id integer; prompt_id integer; faq_id integer;
 current_version integer; before_time timestamptz;
 address jsonb := '{"name":"Recipient","phoneNumber":"01012345678","roadAddress":"Road 1","jibunAddress":"Lot 1","detailAddress":"101","dongName":"Dong","postalCode":"12345","latitude":37.5,"longitude":127.0}';
BEGIN
 INSERT INTO customers(name,phone_number,status) VALUES('Test','01000000001','ACTIVE') RETURNING customer_seq INTO customer_id;
 INSERT INTO customers(name,phone_number,status) VALUES('Other','01000000002','ACTIVE') RETURNING customer_seq INTO other_customer;
 INSERT INTO organizations(name,status) VALUES('Company','ACTIVE') RETURNING organization_seq INTO company_id;
 INSERT INTO organizations(name,status) VALUES('Other company','ACTIVE') RETURNING organization_seq INTO other_company;
 PERFORM pg_temp.expect_error($q$INSERT INTO customers(name,phone_number,status) VALUES('X','01000000003','SUSPENDED')$q$,'23514');
 PERFORM pg_temp.expect_error($q$INSERT INTO organizations(name,status) VALUES('X','SUSPENDED')$q$,'23514');
 INSERT INTO memberships(customer_seq,organization_seq,employee_no,role,status)
 VALUES(customer_id,company_id,'001A','MEMBER','ACTIVE');
 PERFORM pg_temp.expect_error(format('INSERT INTO memberships(customer_seq,organization_seq,employee_no,role,status) VALUES(%s,%s,%L,%L,%L)',other_customer,company_id,'001A','MEMBER','ACTIVE'),'23505');
 PERFORM pg_temp.expect_error(format('INSERT INTO memberships(customer_seq,organization_seq,employee_no,role,status) VALUES(%s,%s,%L,%L,%L)',other_customer,other_company,'  ','MEMBER','ACTIVE'),'23514');
 PERFORM pg_temp.expect_error(format('INSERT INTO memberships(customer_seq,organization_seq,employee_no,role,status) VALUES(%s,%s,NULL,%L,%L)',other_customer,other_company,'MEMBER','ACTIVE'),'23502');
 INSERT INTO memberships(customer_seq,organization_seq,employee_no,role,status)
 VALUES(other_customer,other_company,'001A','ORG_ADMIN','ACTIVE');

 IF valid_parcel_address('{}'::jsonb) OR valid_parcel_address(jsonb_set(address,'{latitude}','91'))
  OR valid_parcel_address(jsonb_set(address,'{phoneNumber}','"bad"')) THEN
  RAISE EXCEPTION 'Address validation failed'; END IF;
 INSERT INTO personal_pins(customer_seq,label,address_data) VALUES(customer_id,'Home',address) RETURNING personal_pin_seq INTO pin_id;
 IF (SELECT search_text FROM personal_pins WHERE personal_pin_seq=pin_id) NOT LIKE '%home%recipient%' THEN
  RAISE EXCEPTION 'Generated pin search text failed'; END IF;
 PERFORM pg_temp.expect_error(format('INSERT INTO personal_pins(customer_seq,address_data) VALUES(%s,%L::jsonb)',customer_id,jsonb_set(address,'{name}','" recipient "')::text),'23505');
 UPDATE personal_pins SET label='Office' WHERE personal_pin_seq=pin_id;
 IF (SELECT version FROM personal_pins WHERE personal_pin_seq=pin_id)<>2 THEN RAISE EXCEPTION 'Pin version failed'; END IF;
 PERFORM pg_temp.expect_error(format('UPDATE personal_pins SET customer_seq=%s WHERE personal_pin_seq=%s',other_customer,pin_id),'23514');
 INSERT INTO company_pins(organization_seq,department_name,address_data) VALUES(company_id,' Sales ',address);
 PERFORM pg_temp.expect_error(format('INSERT INTO company_pins(organization_seq,department_name,address_data) VALUES(%s,%L,%L::jsonb)',company_id,'sales',address::text),'23505');
 INSERT INTO company_pins(organization_seq,department_name,address_data) VALUES(company_id,'Support',address);

 INSERT INTO orders(customer_seq) VALUES(customer_id) RETURNING order_seq INTO order_id;
 IF (SELECT creation_source FROM orders WHERE order_seq=order_id)<>'UNKNOWN' THEN
  RAISE EXCEPTION 'Unspecified source must remain UNKNOWN'; END IF;
 PERFORM pg_temp.expect_error(format('UPDATE orders SET creation_source=%L WHERE order_seq=%s','OTHER',order_id),'23514');
 PERFORM pg_temp.expect_error(format('UPDATE orders SET creation_source=NULL WHERE order_seq=%s',order_id),'23502');
 UPDATE orders SET creation_request_id='00000000-0000-4000-8000-000000000055' WHERE order_seq=order_id;
 PERFORM pg_temp.expect_error($q$INSERT INTO orders(creation_request_id) VALUES('00000000-0000-4000-8000-000000000055')$q$,'23505');
 INSERT INTO order_parcels(order_seq,parcel_position) VALUES(order_id,1) RETURNING order_parcel_seq INTO parcel_id;
 IF (SELECT version FROM orders WHERE order_seq=order_id)<>2 THEN RAISE EXCEPTION 'Order content version failed'; END IF;
 UPDATE orders SET pickup_requested_at=CURRENT_TIMESTAMP WHERE order_seq=order_id;
 IF (SELECT version FROM orders WHERE order_seq=order_id)<>3 THEN RAISE EXCEPTION 'Order header version failed'; END IF;
 PERFORM pg_temp.expect_error(format('INSERT INTO order_parcels(order_seq,parcel_position) VALUES(%s,1)',order_id),'23505');
 PERFORM pg_temp.expect_error(format('UPDATE order_parcels SET origin_pin_scope=%L WHERE order_parcel_seq=%s','PERSONAL',parcel_id),'23514');
 PERFORM pg_temp.expect_error(format('UPDATE orders SET status=%L WHERE order_seq=%s','ACCEPTED',order_id),'23514');
 UPDATE orders SET status='SUBMITTING' WHERE order_seq=order_id;
 IF (SELECT version FROM orders WHERE order_seq=order_id)<>3 THEN RAISE EXCEPTION 'Submission changed content version'; END IF;
 UPDATE orders SET status='ACCEPTED',parcel_no='TEST0001',dver_received_at=CURRENT_TIMESTAMP WHERE order_seq=order_id;
 PERFORM pg_temp.expect_error(format('UPDATE order_parcels SET origin_name=%L WHERE order_parcel_seq=%s','Changed',parcel_id),'23514');

 INSERT INTO admin_users(login_id,password_hash,role,status,name) VALUES('testAdmin','test-only-hash','SYSTEM_ADMIN','ACTIVE','Test Admin') RETURNING admin_user_seq INTO admin_id;
 PERFORM pg_temp.expect_error($q$INSERT INTO admin_users(login_id,password_hash,role,status,name) VALUES('disabled','x','OPERATOR','INACTIVE','Test Admin')$q$,'23514');
 INSERT INTO call_sessions(order_seq,provider_call_id) VALUES(order_id,'test-call') RETURNING call_session_seq INTO call_id;
 UPDATE call_sessions SET incoming_at='2026-10-27T01:00:00Z' WHERE call_session_seq=call_id;
 IF NOT EXISTS(SELECT 1 FROM call_sessions WHERE call_session_seq=call_id AND incoming_at IS NOT NULL AND started_at IS NULL AND ended_at IS NULL) THEN
  RAISE EXCEPTION 'Incoming event timestamp must be independent of PBX call times'; END IF;
 INSERT INTO pbx_webhooks.call_ended_events(recording_id,payload,call_session_seq,last_attempt_at)
 VALUES('correlation-check','{}',call_id,CURRENT_TIMESTAMP);
 PERFORM pg_temp.expect_error($q$INSERT INTO pbx_webhooks.call_ended_events(recording_id,payload,call_session_seq) VALUES('missing-call-check','{}',2147483647)$q$,'23503');
 INSERT INTO call_utterances(call_session_seq,utterance_order,speaker,utterance_text,last_sentence_seq) VALUES(call_id,1,'CUSTOMER','Hello',1);
 PERFORM pg_temp.expect_error(format('UPDATE call_sessions SET ended_at=CURRENT_TIMESTAMP WHERE call_session_seq=%s',call_id),'23514');
 UPDATE call_sessions SET started_at=CURRENT_TIMESTAMP,ended_at=CURRENT_TIMESTAMP,end_reason='NORMAL' WHERE call_session_seq=call_id;
 INSERT INTO recordings(call_session_seq,object_key) VALUES(call_id,'recordings/test.mp3');
 PERFORM pg_temp.expect_error(format('INSERT INTO recordings(call_session_seq,object_key) VALUES(%s,%L)',call_id,'https://example.invalid/test.mp3'),'23514');
 INSERT INTO handoff_requests(call_session_seq,reason,status,assigned_admin_user_seq,requested_at) VALUES(call_id,'Help','CONNECTED',admin_id,CURRENT_TIMESTAMP);
 INSERT INTO shipments(order_parcel_seq,tracking_number) VALUES(parcel_id,'DVA-TEST') RETURNING shipment_seq INTO shipment_id;
 PERFORM pg_temp.expect_error(format('INSERT INTO shipments(order_parcel_seq,tracking_number) VALUES(%s,%L)',parcel_id,'DVA-OTHER'),'23505');
 PERFORM pg_temp.expect_error($q$INSERT INTO shipments(order_parcel_seq,tracking_number) VALUES(2147483647,'DVA-ORPHAN')$q$,'23503');
 INSERT INTO shipment_status_history(shipment_seq,request_id,to_status,actor_type) VALUES(shipment_id,'00000000-0000-0000-0000-000000000001','notPaid','SYSTEM');
 PERFORM pg_temp.expect_error(format('INSERT INTO shipment_status_history(shipment_seq,request_id,to_status,actor_type) VALUES(%s,%L,%L,%L)',shipment_id,'00000000-0000-0000-0000-000000000002','paid','ADMIN'),'23514');

 INSERT INTO ai_personas(code,name) VALUES('test','Test persona') RETURNING ai_persona_seq INTO persona_id;
 INSERT INTO ai_prompt_versions(ai_persona_seq,version,prompt_text,is_active,created_by_admin_user_seq) VALUES(persona_id,1,'First',true,admin_id) RETURNING ai_prompt_version_seq INTO prompt_id;
 PERFORM pg_temp.expect_error(format('INSERT INTO ai_prompt_versions(ai_persona_seq,version,prompt_text,is_active) VALUES(%s,2,%L,true)',persona_id,'Second'),'23505');
 PERFORM pg_temp.expect_error(format('UPDATE ai_prompt_versions SET prompt_text=%L WHERE ai_prompt_version_seq=%s','Overwrite',prompt_id),'23514');
 INSERT INTO faq_entries(question,answer,updated_by_admin_user_seq) VALUES('Question','Answer',admin_id) RETURNING faq_entry_seq INTO faq_id;
 SELECT updated_at INTO before_time FROM faq_entries WHERE faq_entry_seq=faq_id;
 UPDATE faq_entries SET answer='Updated' WHERE faq_entry_seq=faq_id;
 IF (SELECT updated_at FROM faq_entries WHERE faq_entry_seq=faq_id)<=before_time THEN RAISE EXCEPTION 'FAQ timestamp failed'; END IF;
 PERFORM pg_temp.expect_error($q$INSERT INTO audit_logs(actor_type,action,target_type,request_id,result,metadata) VALUES('SYSTEM','TEST','TEST','00000000-0000-0000-0000-000000000003','SUCCESS','[]')$q$,'23514');
 RAISE NOTICE 'PASS: schema, preservation, customer states, employee identity, PINs, order versions/snapshots, calls, recordings, delivery FK/history, prompts, FAQ and audit checks';
END $$;
DO $$
DECLARE first_id integer; second_id integer;
BEGIN
 INSERT INTO admin_users(login_id,password_hash,role,status,name)
 VALUES('sessionOne','test-only','OPERATOR','ACTIVE','First') RETURNING admin_user_seq INTO first_id;
 INSERT INTO admin_users(login_id,password_hash,role,status,name)
 VALUES('sessionTwo','test-only','OPERATOR','ACTIVE','Second') RETURNING admin_user_seq INTO second_id;
 PERFORM pg_temp.expect_error($q$INSERT INTO admin_users(login_id,password_hash,role,status)
 VALUES('missingName','x','OPERATOR','PENDING')$q$,'23502');
 PERFORM pg_temp.expect_error(format('UPDATE admin_users SET name=%L WHERE admin_user_seq=%s','',first_id),'23514');
 PERFORM pg_temp.expect_error(format('UPDATE admin_users SET name=%L WHERE admin_user_seq=%s',E' \t\n',first_id),'23514');
 INSERT INTO admin_sessions(session_token_hash,admin_user_seq) VALUES(repeat('a',64),first_id),(repeat('b',64),first_id),(repeat('c',64),second_id);
 IF EXISTS(SELECT 1 FROM admin_sessions WHERE expires_at-created_at<>INTERVAL '9 hours') THEN
  RAISE EXCEPTION 'Session expiry default incorrect'; END IF;
 PERFORM pg_temp.expect_error(format('INSERT INTO admin_sessions(session_token_hash,admin_user_seq) VALUES(%L,%s)',repeat('a',64),first_id),'23505');
 PERFORM pg_temp.expect_error(format('INSERT INTO admin_sessions(session_token_hash,admin_user_seq) VALUES(%L,%s)','invalid',first_id),'23514');
 PERFORM pg_temp.expect_error(format('INSERT INTO admin_sessions(session_token_hash,admin_user_seq,expires_at) VALUES(%L,%s,CURRENT_TIMESTAMP)',repeat('d',64),first_id),'23514');
 PERFORM pg_temp.expect_error(format('INSERT INTO admin_sessions(session_token_hash,admin_user_seq) VALUES(%L,2147483647)',repeat('e',64)),'23503');
 DELETE FROM admin_sessions WHERE admin_user_seq=first_id;
 IF (SELECT count(*) FROM admin_sessions WHERE admin_user_seq=second_id)<>1 THEN RAISE EXCEPTION 'Other sessions lost'; END IF;
 DELETE FROM admin_users WHERE admin_user_seq=second_id;
 IF EXISTS(SELECT 1 FROM admin_sessions WHERE admin_user_seq=second_id) THEN RAISE EXCEPTION 'Session cascade failed'; END IF;
 RAISE NOTICE 'PASS: admin names, session uniqueness, expiry, FK, scoped deletion and cascade';
END $$;
ROLLBACK;
