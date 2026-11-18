CREATE TABLE faq_change_notifications (
 faq_change_notification_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 operation text NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
 faq_entry_seqs integer[] NOT NULL CHECK (
  cardinality(faq_entry_seqs) BETWEEN 1 AND 100 AND array_ndims(faq_entry_seqs)=1
  AND array_lower(faq_entry_seqs,1)=1 AND array_position(faq_entry_seqs,NULL) IS NULL
  AND 0<ALL(faq_entry_seqs)
 ),
 request_id uuid NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 claim_id uuid,
 claimed_until timestamptz,
 sent_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (operation<>'UPDATE' OR cardinality(faq_entry_seqs)=1),
 CHECK ((claim_id IS NULL)=(claimed_until IS NULL)),
 CHECK (sent_at IS NULL OR claim_id IS NULL)
);
CREATE INDEX faq_change_notifications_pending_idx
 ON faq_change_notifications(faq_change_notification_seq) WHERE sent_at IS NULL;

COMMENT ON TABLE faq_change_notifications IS 'FAQ 변경과 함께 저장하는 AI 알림 대기. 동일 event_id로 재전송';
COMMENT ON COLUMN faq_change_notifications.faq_entry_seqs IS '삭제된 FAQ 번호도 보존하는 논리 참조. FAQ 삭제에 연쇄 삭제하지 않음';
COMMENT ON COLUMN faq_change_notifications.sent_at IS 'AI의 HTTP 202 수신 확인 시각. 검색 데이터 반영 완료를 뜻하지 않음';
