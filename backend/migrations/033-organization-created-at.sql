-- 과거 등록일은 성공한 생성 감사 이력으로만 복원하고, 이력이 없으면 NULL로 남긴다.
ALTER TABLE organizations ADD COLUMN created_at timestamptz;
ALTER TABLE departments ADD COLUMN created_at timestamptz;

UPDATE organizations o SET created_at=a.created_at
FROM (
 SELECT target_seq,min(occurred_at) AS created_at FROM audit_logs
 WHERE target_type='ORGANIZATION' AND action='ORGANIZATION_CREATED' AND result='SUCCESS'
 GROUP BY target_seq
) a WHERE o.organization_seq=a.target_seq;

UPDATE departments d SET created_at=a.created_at
FROM (
 SELECT target_seq,min(occurred_at) AS created_at FROM audit_logs
 WHERE target_type='DEPARTMENT' AND action='DEPARTMENT_CREATED' AND result='SUCCESS'
 GROUP BY target_seq
) a WHERE d.department_seq=a.target_seq;

-- DEFAULT는 복원이 끝난 뒤 설정하여 기존 행에 migration 시각을 채우지 않는다.
ALTER TABLE organizations ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE departments ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;

COMMENT ON COLUMN organizations.created_at IS '기업 등록 시각. migration 033 이전 생성 감사 이력이 없는 행은 NULL.';
COMMENT ON COLUMN departments.created_at IS '부서 등록 시각. migration 033 이전 생성 감사 이력이 없는 행은 NULL.';
