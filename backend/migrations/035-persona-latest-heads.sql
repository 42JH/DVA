LOCK TABLE ai_personas, ai_persona_versions IN SHARE ROW EXCLUSIVE MODE;

-- HEAD는 최신 저장 버전이다. 실제 ACTIVE/PENDING과 적용 요청은 변경하지 않는다.
UPDATE ai_personas p SET head_version_seq=(
 SELECT v.ai_persona_version_seq FROM ai_persona_versions v
 WHERE v.ai_persona_seq=p.ai_persona_seq
 ORDER BY v.version DESC LIMIT 1
);
