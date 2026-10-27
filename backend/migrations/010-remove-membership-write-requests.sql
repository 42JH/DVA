-- S15P31D109-37: 구성원 등록·CSV는 업무 고유 제약과 트랜잭션으로 처리한다.
-- 009 원본과 적용 이력은 보존하고 불필요한 요청 처리 기록만 제거한다.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

DROP TABLE api_idempotency.membership_writes;
-- 다른 객체가 의존하면 CASCADE 없이 실패하여 전체 마이그레이션을 롤백한다.
DROP SCHEMA api_idempotency;
