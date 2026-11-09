-- 외부 저장소 I/O 동안 DB 연결을 점유하지 않는 수신 건별 처리 권한.
ALTER TABLE pbx_webhooks.call_ended_events
  ADD COLUMN claim_id uuid,
  ADD COLUMN claimed_until timestamptz,
  ADD CONSTRAINT call_ended_claim_pair_check
    CHECK ((claim_id IS NULL) = (claimed_until IS NULL));
