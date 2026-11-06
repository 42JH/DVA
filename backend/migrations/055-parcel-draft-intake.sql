SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

CREATE TABLE order_parcel_drafts (
 draft_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 call_session_seq integer CHECK (call_session_seq>0),
 customer_seq integer CHECK (customer_seq>0),
 created_by_admin_user_seq integer CHECK (created_by_admin_user_seq>0),
 client_parcel_id uuid NOT NULL,
 creation_payload jsonb NOT NULL CHECK (jsonb_typeof(creation_payload)='object'),
 parcel_data jsonb NOT NULL CHECK (jsonb_typeof(parcel_data)='object'),
 status text NOT NULL CHECK (status IN ('READY','EDITING','INCOMPLETE','CONVERTED','CANCELLED','RESUMED')),
 version integer NOT NULL DEFAULT 1 CHECK (version>0),
 source_draft_seq integer CHECK (source_draft_seq>0 AND source_draft_seq<>draft_seq),
 order_seq integer CHECK (order_seq>0),
 order_parcel_seq integer CHECK (order_parcel_seq>0),
 legacy_order_seq integer CHECK (legacy_order_seq>0),
 legacy_order_parcel_seq integer CHECK (legacy_order_parcel_seq>0),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 retention_started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 deleted_at timestamptz,
 CONSTRAINT parcel_draft_owner_check CHECK (call_session_seq IS NOT NULL OR created_by_admin_user_seq IS NOT NULL OR legacy_order_seq IS NOT NULL),
 CONSTRAINT parcel_draft_conversion_check CHECK ((status='CONVERTED')=(order_parcel_seq IS NOT NULL) AND (order_seq IS NULL)=(order_parcel_seq IS NULL)),
 CONSTRAINT parcel_draft_legacy_check CHECK (legacy_order_parcel_seq IS NULL OR legacy_order_seq IS NOT NULL)
);
CREATE UNIQUE INDEX parcel_draft_client_key ON order_parcel_drafts(call_session_seq,client_parcel_id) NULLS NOT DISTINCT;
CREATE UNIQUE INDEX parcel_draft_source_key ON order_parcel_drafts(source_draft_seq) WHERE source_draft_seq IS NOT NULL;
CREATE UNIQUE INDEX parcel_draft_converted_key ON order_parcel_drafts(order_parcel_seq) WHERE order_parcel_seq IS NOT NULL;
CREATE UNIQUE INDEX parcel_draft_legacy_key ON order_parcel_drafts(legacy_order_seq,legacy_order_parcel_seq) NULLS NOT DISTINCT WHERE legacy_order_seq IS NOT NULL;
CREATE INDEX parcel_draft_customer_idx ON order_parcel_drafts(customer_seq,status,created_at DESC,draft_seq DESC) WHERE deleted_at IS NULL;
CREATE INDEX parcel_draft_created_idx ON order_parcel_drafts(created_at DESC,draft_seq DESC) WHERE deleted_at IS NULL;
CREATE INDEX parcel_draft_retention_idx ON order_parcel_drafts(retention_started_at,draft_seq);

ALTER TABLE call_sessions
 ADD COLUMN order_intake_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN order_intake_version integer NOT NULL DEFAULT 1 CHECK (order_intake_version>0),
 ADD COLUMN order_completion_received_at timestamptz,
 ADD COLUMN order_completion_payload jsonb,
 ADD COLUMN order_finalized_at timestamptz,
 ADD COLUMN order_finalization_result jsonb,
 ADD COLUMN order_finalization_error_code text,
 ADD COLUMN order_finalization_attempted_at timestamptz,
 ADD CONSTRAINT call_order_completion_check CHECK ((order_completion_received_at IS NULL)=(order_completion_payload IS NULL)
  AND (order_completion_payload IS NULL OR jsonb_typeof(order_completion_payload)='object')),
 ADD CONSTRAINT call_order_finalization_check CHECK ((order_finalized_at IS NULL)=(order_finalization_result IS NULL)
  AND (order_finalization_result IS NULL OR (order_completion_received_at IS NOT NULL AND ended_at IS NOT NULL AND jsonb_typeof(order_finalization_result)='object')));
ALTER TABLE call_sessions ALTER COLUMN order_intake_enabled SET DEFAULT true;
CREATE INDEX call_order_finalization_idx ON call_sessions(order_finalization_attempted_at NULLS FIRST,call_session_seq)
 WHERE order_intake_enabled AND order_completion_received_at IS NOT NULL AND order_finalized_at IS NULL AND deleted_at IS NULL;

-- Copy historical partial snapshots; never infer confirmation or charge a legacy order.
INSERT INTO order_parcel_drafts(call_session_seq,customer_seq,created_by_admin_user_seq,client_parcel_id,
 creation_payload,parcel_data,status,legacy_order_seq,legacy_order_parcel_seq,created_at,updated_at,retention_started_at,deleted_at)
SELECT (SELECT CASE WHEN count(*)=1 THEN min(c.call_session_seq) END FROM call_sessions c WHERE c.order_seq=o.order_seq),
 o.customer_seq,o.created_by_admin_user_seq,gen_random_uuid(),'{}'::jsonb,
 jsonb_build_object(
  'origin',jsonb_build_object('name',p.origin_name,'phoneNumber',p.origin_phone_number,'roadAddress',p.origin_road_address,
   'jibunAddress',p.origin_jibun_address,'detailAddress',p.origin_detail_address,'dongName',p.origin_dong_name,'postalCode',p.origin_postal_code),
  'destination',jsonb_build_object('name',p.destination_name,'phoneNumber',p.destination_phone_number,'roadAddress',p.destination_road_address,
   'jibunAddress',p.destination_jibun_address,'detailAddress',p.destination_detail_address,'dongName',p.destination_dong_name,'postalCode',p.destination_postal_code),
  'originPin',CASE WHEN p.origin_pin_seq IS NULL THEN NULL ELSE jsonb_build_object('scope',p.origin_pin_scope,'pinSeq',p.origin_pin_seq) END,
  'documentCount',COALESCE(p.document_count,0),'smallBoxCount',COALESCE(p.small_box_count,0),
  'mediumBoxCount',COALESCE(p.medium_box_count,0),'bigBoxCount',COALESCE(p.big_box_count,0),
  'otherItemDescription',COALESCE(p.other_item_description,''),'clientComment',COALESCE(p.client_comment,''),
  'itemPrice',p.item_price,'notifiedPrice',p.notified_price),
 CASE WHEN p.status='CANCELLED' THEN 'CANCELLED' ELSE 'INCOMPLETE' END,
 o.order_seq,p.order_parcel_seq,o.created_at,o.updated_at,o.created_at,o.deleted_at
FROM orders o LEFT JOIN order_parcels p ON p.order_seq=o.order_seq WHERE o.status='COLLECTING';

COMMENT ON TABLE order_parcel_drafts IS '배송 단건 초안·미완료·재개 이력. 모든 seq 참조는 논리 참조이며 원본 삭제와 독립적으로 스냅샷 보관';
COMMENT ON COLUMN order_parcel_drafts.version IS '이 초안 행의 동시 수정 방지 버전. 변경 이력을 별도 행으로 생성하지 않음';
COMMENT ON COLUMN order_parcel_drafts.source_draft_seq IS '재개 전 원본 초안의 논리 참조. 원본 폐기 후에도 번호 보존';
COMMENT ON COLUMN order_parcel_drafts.creation_payload IS '동일 client_parcel_id의 생성 재전송 본문 비교용. 현행 parcel_data와 별도로 보존';
COMMENT ON COLUMN order_parcel_drafts.retention_started_at IS '최초 생성 기준 5년. 재개 사본은 원본 기준을 상속하며 수정·삭제로 연장하지 않음';
COMMENT ON COLUMN call_sessions.order_intake_enabled IS '055 이전 통화 false, 이후 등록 true. 신규 AI는 초안·완료 신호 계약 사용';
