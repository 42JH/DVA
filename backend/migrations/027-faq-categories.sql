SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE public.faq_entries IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.faq_entries ADD COLUMN category text;

-- 분류만 보완하므로 기존 질문·답변의 수정 시각과 AI 변경 신호를 보존한다.
ALTER TABLE public.faq_entries DISABLE TRIGGER faq_entry_timestamp;
ALTER TABLE public.faq_entries DISABLE TRIGGER faq_change_notification;

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
ALTER TABLE public.faq_entries ENABLE TRIGGER faq_change_notification;
ALTER TABLE public.faq_entries ALTER COLUMN category SET NOT NULL;
ALTER TABLE public.faq_entries ADD CONSTRAINT faq_category_check
 CHECK(category IN ('접수','수거 일정','물품·박스','포장·파손','배송·운송장','주소','변경·취소','요금·결제','이용 안내','기타'));
COMMENT ON COLUMN public.faq_entries.category IS '관리자 FAQ 분류. 전체는 조회 조건이며 저장하지 않음. AI 조회에는 제공하지 않음';
