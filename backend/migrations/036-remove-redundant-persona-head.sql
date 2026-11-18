-- HEAD는 유형별 최신 저장 버전으로 조회하므로 별도 복사본을 유지하지 않는다.
ALTER TABLE ai_personas DROP COLUMN head_version_seq;
