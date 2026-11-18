SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE public.faq_entries IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.faq_entries ADD COLUMN category text;

-- 분류만 보완하므로 기존 질문·답변의 수정 시각과 AI 변경 신호를 보존한다.
ALTER TABLE public.faq_entries DISABLE TRIGGER faq_entry_timestamp;
ALTER TABLE public.faq_entries DISABLE TRIGGER faq_entry_changed;

WITH assignments(question,category) AS (VALUES
 ('택배 접수는 어떻게 하나요?','접수'),
 ('한 번에 몇 개까지 접수할 수 있나요?','접수'),
 ('이용 가능 시간은 언제인가요?','이용 안내'),
 ('비회원도 접수할 수 있나요?','접수'),
 ('자주 쓰는 주소를 등록할 수 있나요?','주소'),
 ('수거는 언제 오나요?','수거 일정'),
 ('접수 후 내용을 바꾸고 싶어요.','변경·취소'),
 ('서류도 택배로 보낼 수 있나요?','물품·박스'),
 ('어떤 물품을 보낼 수 있나요?','물품·박스'),
 ('물품 종류는 어떻게 구분하나요?','물품·박스'),
 ('물품 가격은 왜 물어보나요?','포장·파손'),
 ('포장은 직접 해야 하나요?','포장·파손'),
 ('포장은 어떻게 하면 되나요?','포장·파손'),
 ('포장이 제대로 안 되어 있으면 어떻게 되나요?','포장·파손'),
 ('분실·파손되면 보상받을 수 있나요?','포장·파손'),
 ('요금은 얼마인가요?','요금·결제'),
 ('제주나 섬 지역도 보낼 수 있나요?','배송·운송장'),
 ('추가 요금이 붙는 경우가 있나요?','요금·결제'),
 ('결제 방법은 무엇이 있나요?','요금·결제'),
 ('착불도 되나요?','요금·결제'),
 ('월정산은 어떻게 신청하나요?','요금·결제'),
 ('법인카드도 쓸 수 있나요?','요금·결제'),
 ('영수증이나 거래명세서를 받을 수 있나요?','요금·결제'),
 ('배송은 얼마나 걸리나요?','배송·운송장'),
 ('운송장 번호는 언제 확인할 수 있나요?','배송·운송장'),
 ('서비스 지역은 어디인가요?','이용 안내'),
 ('어느 택배사로 가나요?','배송·운송장'),
 ('반품도 신청할 수 있나요?','변경·취소'),
 ('주문 상태는 어떻게 나뉘나요?','접수'),
 ('주문 취소는 언제까지 가능한가요?','변경·취소'),
 ('취소하면 환불은 어떻게 되나요?','요금·결제'),
 ('고객센터 번호는 어떻게 되나요?','이용 안내')
)
UPDATE public.faq_entries f SET category=a.category FROM assignments a
 WHERE normalize(btrim(f.question),NFC)=normalize(a.question,NFC);

DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.faq_entries WHERE category IS NULL) THEN
  RAISE EXCEPTION 'Unmapped FAQ rows require reviewed category assignments before 027' USING ERRCODE='23514';
 END IF;
END $$;

ALTER TABLE public.faq_entries ENABLE TRIGGER faq_entry_timestamp;
ALTER TABLE public.faq_entries ENABLE TRIGGER faq_entry_changed;
ALTER TABLE public.faq_entries ALTER COLUMN category SET NOT NULL;
ALTER TABLE public.faq_entries ADD CONSTRAINT faq_category_check
 CHECK(category IN ('접수','수거 일정','물품·박스','포장·파손','배송·운송장','주소','변경·취소','요금·결제','이용 안내','기타'));
COMMENT ON COLUMN public.faq_entries.category IS '관리자 FAQ 분류. 전체는 조회 조건이며 저장하지 않음. AI 조회에는 제공하지 않음';

ALTER TABLE faq_entries ADD COLUMN deleted_at timestamptz;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE public.faq_entries IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE duplicate_ids jsonb;
BEGIN
 SELECT jsonb_agg(ids ORDER BY ids[1]) INTO duplicate_ids
 FROM (
  SELECT array_agg(faq_entry_seq ORDER BY faq_entry_seq) AS ids
  FROM public.faq_entries
  GROUP BY lower(btrim(regexp_replace(normalize(question,NFC),'[[:space:]]+',' ','g')))
  HAVING count(*)>1
 ) duplicates;
 IF duplicate_ids IS NOT NULL THEN
  RAISE EXCEPTION 'Duplicate FAQ question IDs: %',duplicate_ids USING ERRCODE='23505';
 END IF;
END $$;

-- 고정 길이 키로 1,000자 한글을 지원한다. bytea 변환 전 역슬래시를 이스케이프해 원문 바이트를 보존한다.
CREATE UNIQUE INDEX faq_entries_question_identity_uq ON public.faq_entries
 (sha256(replace(lower(btrim(regexp_replace(normalize(question,NFC),'[[:space:]]+',' ','g'))),
  chr(92),chr(92)||chr(92))::bytea)) WHERE deleted_at IS NULL;

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

CREATE OR REPLACE FUNCTION notify_faq_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry_id integer; operation text;
BEGIN
 IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
 IF TG_OP='DELETE' AND OLD.deleted_at IS NOT NULL THEN RETURN NULL; END IF;
 entry_id=CASE WHEN TG_OP='DELETE' THEN OLD.faq_entry_seq ELSE NEW.faq_entry_seq END;
 operation=TG_OP;
 IF TG_OP='UPDATE' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN operation='DELETE'; END IF;
 PERFORM pg_notify('faq_changed',jsonb_build_object('faqEntrySeq',entry_id,'operation',operation)::text);
 RETURN NULL;
END $$;


SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE TABLE public.faq_question_examples (
 faq_question_example_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 faq_entry_seq integer NOT NULL REFERENCES public.faq_entries(faq_entry_seq) ON DELETE CASCADE,
 event_id uuid NOT NULL,
 question_text text NOT NULL CHECK (length(btrim(question_text))>0 AND length(question_text)<=20000),
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at)),
 UNIQUE (faq_entry_seq,event_id)
);
CREATE INDEX faq_question_examples_recent_idx ON public.faq_question_examples
 (faq_entry_seq,occurred_at DESC,faq_question_example_seq DESC);
CREATE INDEX faq_question_examples_retention_idx ON public.faq_question_examples
 (occurred_at,faq_question_example_seq);

CREATE FUNCTION public.reset_faq_question_examples() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM public.faq_question_examples WHERE faq_entry_seq=NEW.faq_entry_seq;
 RETURN NULL;
END $$;
CREATE TRIGGER faq_question_examples_reset AFTER UPDATE ON public.faq_entries
 FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION public.reset_faq_question_examples();

COMMENT ON TABLE public.faq_question_examples IS 'FAQ별 최신 10개 고객 질문 스냅샷. 응대 발생 후 5년 폐기. FAQ 수정·삭제 시 정리하며 통화 삭제와 독립';
COMMENT ON COLUMN public.faq_question_examples.event_id IS '원본 FAQ_ANSWERED UUID의 논리 참조. 원본 통화·이벤트 물리 삭제 뒤에도 스냅샷을 유지하므로 FK 없음';
COMMENT ON COLUMN public.faq_question_examples.question_text IS '수집 시 검증된 고객 발화 원문 복사. 같은 문장의 서로 다른 발생도 각각 저장';
COMMENT ON COLUMN public.faq_question_examples.occurred_at IS 'FAQ_ANSWERED.occurredAt. 최신 10개와 5년 보존의 공통 기준. 재전송으로 연장하지 않음';

CREATE INDEX faq_entries_retention_idx ON faq_entries(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX faq_notifications_retention_idx ON faq_change_notifications(sent_at) WHERE sent_at IS NOT NULL;
