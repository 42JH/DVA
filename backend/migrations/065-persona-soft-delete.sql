SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

ALTER TABLE ai_personas ADD COLUMN deleted_at timestamptz;
ALTER TABLE ai_persona_versions ADD COLUMN deleted_at timestamptz,
 ADD CONSTRAINT ai_persona_deleted_inactive_check CHECK (deleted_at IS NULL OR status='INACTIVE');
ALTER TABLE ai_persona_drafts ADD COLUMN deleted_at timestamptz;

COMMENT ON COLUMN ai_personas.deleted_at IS '분류 삭제 시 모든 버전·초안도 같은 트랜잭션에서 soft delete. ACTIVE 분류 삭제 금지';
COMMENT ON COLUMN ai_persona_versions.deleted_at IS '관리·publish에서는 제외하되 과거 통화 분석 참조는 보존';
