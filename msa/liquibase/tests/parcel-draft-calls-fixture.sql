BEGIN;
SET LOCAL session_replication_role='replica';
INSERT INTO call_sessions(call_session_seq,provider_call_id,order_seq,caller_phone_number,customer_seq,incoming_at,started_at,ended_at,deleted_at,registered_at)
 OVERRIDING SYSTEM VALUE VALUES
 (200,'draft-one',100,'01011112222',999,'2030-01-01Z','2030-01-01Z','2030-01-02Z',NULL,'2030-01-01Z'),
 (201,'draft-many-a',101,'01022223333',321,'2030-01-01Z',NULL,NULL,NULL,NULL),
 (202,'draft-many-b',101,'01033334444',321,'2030-01-01Z',NULL,NULL,'2030-01-03Z',NULL),
 (203,'draft-null-phone',102,NULL,321,'2030-01-01Z',NULL,NULL,NULL,NULL),
 (204,'draft-expired-deleted',103,'old unrestricted phone text',321,'2000-01-01Z',NULL,NULL,'2030-01-03Z',NULL),
 (205,'draft-not-collecting',106,'01044445555',321,'2030-01-01Z',NULL,NULL,NULL,NULL);
COMMIT;
