-- MSA: order_parcel_seq and actor_admin_user_seq are logical references.
-- Shared delivery table design; external references are logical in MSA.
-- Status vocabulary approved; cancellation eligibility/backward transitions are not yet specified.
CREATE TABLE shipments (
 shipment_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 order_parcel_seq integer NOT NULL UNIQUE,
 tracking_number text NOT NULL UNIQUE CHECK (btrim(tracking_number)<>''),
 status text NOT NULL DEFAULT 'notPaid' CHECK (status IN ('notPaid','paid','received','waiting','sent','canceling','canceled')),
 version integer NOT NULL DEFAULT 1 CHECK (version>0),
 status_changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE shipment_status_history (
 shipment_status_history_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 shipment_seq integer NOT NULL REFERENCES shipments,
 request_id uuid NOT NULL UNIQUE,
 from_status text CHECK (from_status IN ('notPaid','paid','received','waiting','sent','canceling','canceled')),
 to_status text NOT NULL CHECK (to_status IN ('notPaid','paid','received','waiting','sent','canceling','canceled')),
 actor_type text NOT NULL CHECK (actor_type IN ('ADMIN','SYSTEM')),
 actor_admin_user_seq integer,
 occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ((actor_type='ADMIN' AND actor_admin_user_seq IS NOT NULL AND actor_admin_user_seq>0)
     OR (actor_type='SYSTEM' AND actor_admin_user_seq IS NULL))
);
CREATE INDEX shipment_history_lookup_idx
 ON shipment_status_history(shipment_seq,occurred_at,shipment_status_history_seq);

-- Application implementation must atomically create shipment + initial history,
-- and atomically update state/version/time + append history on each transition.
-- Authenticate the actor server-side; compare repeated request IDs with their original payload.
-- Trusted backend only: authenticate/authorize the actor before calling these functions.
-- MSA caller must verify an accepted order via its committed OrderAccepted event.
CREATE FUNCTION create_shipment(parcel_id integer, command_id uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE shipment_id integer; previous shipment_status_history%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(command_id::text,0));
 SELECT * INTO previous FROM shipment_status_history WHERE request_id=command_id;
 IF FOUND THEN
  IF previous.from_status IS NOT NULL OR previous.to_status<>'notPaid'
    OR previous.actor_type<>'SYSTEM' OR NOT EXISTS
    (SELECT 1 FROM shipments WHERE shipment_seq=previous.shipment_seq AND order_parcel_seq=parcel_id) THEN
   RAISE EXCEPTION 'Request ID reused with different payload' USING ERRCODE='23514';
  END IF;
  RETURN previous.shipment_seq;
 END IF;
 INSERT INTO shipments(order_parcel_seq,tracking_number)
 VALUES(parcel_id,'DVA-'||gen_random_uuid()::text) RETURNING shipment_seq INTO shipment_id;
 INSERT INTO shipment_status_history(shipment_seq,request_id,from_status,to_status,actor_type)
 VALUES(shipment_id,command_id,NULL,'notPaid','SYSTEM');
 RETURN shipment_id;
END $$;

CREATE FUNCTION change_shipment_status(target_shipment integer, expected_version integer,
 next_status text, command_id uuid, admin_id integer) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE current_row shipments%ROWTYPE; previous shipment_status_history%ROWTYPE;
BEGIN
 IF command_id IS NULL OR expected_version IS NULL OR admin_id IS NULL OR admin_id<=0 THEN
  RAISE EXCEPTION 'Missing command/version/admin' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(command_id::text,0));
 SELECT * INTO STRICT current_row FROM shipments WHERE shipment_seq=target_shipment FOR UPDATE;
 SELECT * INTO previous FROM shipment_status_history WHERE request_id=command_id;
 IF FOUND THEN
  IF previous.shipment_seq<>target_shipment OR previous.to_status IS DISTINCT FROM next_status
    OR previous.from_status IS NULL OR previous.actor_type<>'ADMIN' OR previous.actor_admin_user_seq<>admin_id THEN
   RAISE EXCEPTION 'Request ID reused with different payload' USING ERRCODE='23514'; END IF;
  RETURN previous.shipment_status_history_seq;
 END IF;
 IF current_row.version<>expected_version THEN
  RAISE EXCEPTION 'Stale shipment version' USING ERRCODE='23514'; END IF;
 IF current_row.status IS NOT DISTINCT FROM next_status THEN
  RAISE EXCEPTION 'Shipment already has this status' USING ERRCODE='23514'; END IF;
 -- shortcut: allowed state pairs await business policy; currently enforce only the approved vocabulary.
 UPDATE shipments SET status=next_status,version=version+1,status_changed_at=clock_timestamp()
 WHERE shipment_seq=target_shipment;
 INSERT INTO shipment_status_history(shipment_seq,request_id,from_status,to_status,actor_type,actor_admin_user_seq,occurred_at)
 VALUES(target_shipment,command_id,current_row.status,next_status,'ADMIN',admin_id,clock_timestamp())
 RETURNING shipment_status_history_seq INTO previous.shipment_status_history_seq;
 RETURN previous.shipment_status_history_seq;
END $$;
-- Infrastructure template, included once per participating service database.
-- A separate row per destination permits independent acknowledgements.
CREATE TABLE outbox_events (
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 destination text NOT NULL CHECK (btrim(destination)<>''),
 event_type text NOT NULL CHECK (btrim(event_type)<>''),
 aggregate_seq integer NOT NULL,
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
 occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 delivered_at timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox_events(occurred_at,event_id) WHERE delivered_at IS NULL;
CREATE TABLE inbox_events (
 event_id uuid PRIMARY KEY,
 source text NOT NULL CHECK (btrim(source)<>''),
 event_type text NOT NULL CHECK (btrim(event_type)<>''),
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
 processed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Insert inbox + business changes in ONE transaction. Compare payload/source/type on duplicates.
-- Receiver ACKs only committed processing; sender marks delivered_at only after ACK.
-- Relay and authenticated transport remain application work; this DDL is not a running worker.
-- Only an authenticated Order-service delivery route may call this function.
CREATE FUNCTION receive_accepted_order(message_id uuid, message_body jsonb) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE previous inbox_events%ROWTYPE; parcel jsonb;
BEGIN
 IF message_id IS NULL OR jsonb_typeof(message_body) IS DISTINCT FROM 'object'
  OR jsonb_typeof(message_body->'orderSeq') IS DISTINCT FROM 'number'
  OR (message_body->>'orderSeq') !~ '^[1-9][0-9]*$'
  OR jsonb_typeof(message_body->'orderParcelSeqs') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'Invalid accepted-order event' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(message_body->'orderParcelSeqs')=0 THEN
  RAISE EXCEPTION 'Empty parcel list' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(message_id::text,0));
 SELECT * INTO previous FROM inbox_events WHERE event_id=message_id;
 IF FOUND THEN
  IF previous.source<>'order' OR previous.event_type<>'OrderAccepted' OR previous.payload<>message_body THEN
   RAISE EXCEPTION 'Event ID reused with different payload' USING ERRCODE='23514'; END IF;
  RETURN;
 END IF;
 INSERT INTO inbox_events(event_id,source,event_type,payload) VALUES(message_id,'order','OrderAccepted',message_body);
 FOR parcel IN SELECT value FROM jsonb_array_elements(message_body->'orderParcelSeqs') LOOP
  IF jsonb_typeof(parcel)<>'number' OR parcel::text !~ '^[1-9][0-9]*$' THEN
   RAISE EXCEPTION 'Invalid parcel ID' USING ERRCODE='22023'; END IF;
  PERFORM create_shipment((parcel::text)::integer,gen_random_uuid());
 END LOOP;
END $$;

