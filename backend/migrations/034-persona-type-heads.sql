LOCK TABLE ai_personas, ai_persona_versions IN SHARE ROW EXCLUSIVE MODE;

-- 동일 유형의 불변 버전을 가리키는 논리 참조. API에서 소속과 동시 수정을 검증한다.
ALTER TABLE ai_personas
 ADD COLUMN head_version_seq integer CHECK (head_version_seq > 0);

-- 기존 진행 중인 적용은 이어가고, 나머지는 마지막 적용 성공 버전을 복원한다.
UPDATE ai_personas p SET head_version_seq=(
 SELECT v.ai_persona_version_seq
 FROM ai_persona_versions v
 LEFT JOIN LATERAL (
   SELECT occurred_at,audit_log_seq FROM audit_logs
   WHERE target_type='AI_PERSONA_VERSION' AND target_seq=v.ai_persona_version_seq
     AND action='PERSONA_APPLIED' AND result='SUCCESS'
   ORDER BY audit_log_seq DESC LIMIT 1
 ) applied ON true
 WHERE v.ai_persona_seq=p.ai_persona_seq
   AND (v.status IN ('ACTIVE','PENDING') OR v.applied_at IS NOT NULL OR applied.audit_log_seq IS NOT NULL)
 ORDER BY CASE v.status WHEN 'PENDING' THEN 0 WHEN 'ACTIVE' THEN 1 ELSE 2 END,
   COALESCE(applied.occurred_at,v.applied_at) DESC NULLS LAST,
   applied.audit_log_seq DESC NULLS LAST,v.ai_persona_version_seq DESC
 LIMIT 1
);
