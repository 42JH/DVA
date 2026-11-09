-- 주문이 없는 통화도 재전송 키와 통화당 최종 결과를 보존한다. 번호는 논리 참조다.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE TABLE empty_ai_order_results (
 request_id uuid PRIMARY KEY,
 call_session_seq integer NOT NULL UNIQUE,
 actor_admin_user_seq integer,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
