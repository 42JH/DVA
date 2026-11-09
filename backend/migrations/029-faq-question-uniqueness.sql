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
  chr(92),chr(92)||chr(92))::bytea));
