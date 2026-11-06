# PostgreSQL 이벤트 전달 기반

[S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)의 첫 MR이다. Node.js 24의 HTTP·crypto·fetch와 기존 서비스의 `pg` Pool을 사용하며 런타임 외부 의존성은 없다. 테스트에서만 저장소와 같은 pg 8.23.1을 사용한다.

customer와 operations의 감사 이벤트에 연결했다. 나머지 서비스는 해당 이식 MR에서 기존 API·인증·업무 SQL·워커와 연결한다. 패키지만 배포해 업무 API나 이벤트가 자동으로 실행되지는 않는다.

## 트랜잭션과 사용 계약

`enqueue(client, { destination, eventType, aggregateSeq, payload })`는 이미 BEGIN한 같은 PoolClient로 업무 변경 뒤 호출하고 함께 COMMIT한다. 커밋 전 전달하지 않으며 반환한 UUID는 outbox에 영구 저장된다. 같은 수신처·업무 식별자의 작성자를 advisory transaction lock으로 직렬화한 뒤 순번을 발급한다. 여러 업무를 한 트랜잭션에서 작성하면 수신처·식별자 순서로 잠금을 획득한다. 직접 outbox INSERT는 이 작성 순서 보호를 우회하므로 새 publisher는 enqueue를 사용한다.

`createReceiver({ pool, sources, handlers })`는 `receive(event, authorization)`를 반환한다. sources는 서비스 이름별 32~256자 비밀 토큰이며 handlers는 `source:EventType`별 `(client, event)` 함수다. source별 토큰을 timingSafeEqual로 검사하고 등록하지 않은 종류를 거절한다. payload 업무 검증과 SQL은 해당 핸들러가 책임진다. 핸들러는 전달받은 client만 사용하고 외부 호출이나 다른 DB 쓰기를 같은 함수 안에서 실행하지 않는다. inbox 기록·업무 변경은 함께 커밋하며 실패하면 함께 롤백한다.

동일 eventId/source/eventType/payload의 재수신은 기존 결과를 재반영하지 않고 ACK한다. 같은 ID의 다른 값은 409다. JSON 객체 키 순서는 차이로 보지 않는다. 최초 수신·중복 모두 DB COMMIT 이후 `{ eventId, status: 'processed' | 'duplicate' }`를 반환한다. 기존 delivery SQL의 `receive_accepted_order`는 자체 inbox를 소유하므로 이 핸들러 안에서 그대로 호출하면 안 된다. 배송 이식 시 모놀리식의 최신 배송 생성·취소 규칙과 함께 변경한다.

`eventHttpHandler(receive)`는 기존 앱에 장착할 수 있는 Node HTTP 핸들러다. 경로는 외부 업무 API와 구분되는 내부 전용 `POST /internal/events`이며 1MiB JSON 한도를 적용한다. 프론트·AI가 이 엔드포인트를 호출하지 않는다. 내부 라우트는 공개 Ingress에 추가하지 않으며 토큰은 환경/Secret으로 주입한다.

`createRelay({ pool, source, destinations, timeoutMs })`는 이벤트 한 건을 처리하는 비동기 함수를 반환한다. destinations는 고정 서비스별 `{ url, token }`이다. URL의 자격정보·query·fragment·HTTP(S) 외 스킴과 리다이렉트를 거절한다. 내부 HTTP 또는 외부 HTTPS를 사용할 수 있으며 토큰은 로그에 기록하지 않는다.

`sendEvent(url, token, event)`는 같은 입력·URL·5초 제한·4KiB 정확 ACK 검증으로 제어 이벤트 한 건을 직접 전송한다. 영속 저장이나 재시도는 하지 않는다. customer 감사 준비/결정 조회처럼 호출자가 별도 트랜잭션·outbox·복구 규칙을 가진 경우에만 사용한다. 업무 확정 이벤트는 기존 enqueue/relay를 사용한다. TypeScript 선언도 패키지에 포함한다.

릴레이는 같은 수신처·업무 식별자의 앞선 미전달 이벤트를 추월하지 않는다. 다른 업무의 이벤트는 SKIP LOCKED로 병렬 처리한다. HTTP 응답 본문을 읽는 동안에도 기본 5초(최대 30초) 제한을 적용하며 응답은 4KiB 이내의 정확한 이벤트 ACK여야 한다. 성공 ACK 후에만 delivered_at을 기록한다. 타임아웃·잘못된 ACK·인증/업무 오류·미등록 수신처는 DB 대기를 남기고 250ms부터 최대 60초 간격으로 재시도한다. 영구 오류도 자동 삭제하거나 성공 처리하지 않으며 attempt_count·next_attempt_at·last_http_status로 진단한다.

릴레이의 DB 행 잠금은 HTTP 요청이 끝날 때까지 유지된다. 전달은 at-least-once이며 수신 멱등성이 필수다. 장착하는 앱의 기존 워커가 반환 함수를 반복 실행하고 종료 시 진행 중 요청이 끝나도록 기다려야 한다. 업무 성공을 반환하는 API의 완료·즉시 조회 경계는 개별 기능에서 별도로 구현·검증한다.

## 통화 범위 요청/응답

`@dva/events/call-scope.cjs`는 고객 주소 수정·개인 PIN의 고정된 네 operation에만 사용한다. 기존 두 서비스 토큰과 정확한 origin, 리다이렉트 거절·시간 제한·JSON/이벤트 ID/결과 형태·응답 16MiB 제한을 검사한다. 원본 공개 요청의 100KiB 제한은 유지하며 내부 경로만 256KiB envelope를 허용한다. 외부 클라이언트에 새 API나 헤더를 요구하지 않는다.

consultation이 통화를 소유하고 customer의 실제 업무·감사 ACK 동안 쓰기 행 잠금을 유지한다. customer는 내부 쓰기의 정렬된 입력 해시와 결과 식별자/버전만 자기 inbox에 업무와 함께 저장한다. 같은 이벤트/다른 명령은 충돌로 거절하고 동일 명령은 재반영하지 않는다. 조회는 같은 이벤트라도 최신 페이지를 읽으며 개인정보 응답을 저장하지 않는다. 이 요청/응답 함수는 자체 큐나 자동 재시도를 추가하지 않는다. 감사 결정은 기존 outbox/relay로 전달한다.

## 주문 조회 이벤트

`@dva/events/order-read.cjs`는 기존 공개 GET 4개의 통화/고객 범위 확인에 사용한다. `OrderReadRequested`의 고정 operation은 `OrdersListed`, `OrderDetailRead`, `OrderAddressesListed`다. AI는 order → consultation → customer → order, 관리자 이전 주소 조회는 order → customer → order 순서로 요청/응답한다. 관리자 주문 목록/상세는 order DB만 읽는다.

consultation은 삭제/보관/종료 조건을 확인한 통화를, customer는 현재 발신번호의 활성 고객 또는 관리자 조회 고객을 공유 잠금으로 보호한 동안 order가 로컬 REPEATABLE READ 스냅샷을 읽는다. 원격 대기 중 order DB 연결을 보유하지 않아 callback이 자기 연결 풀을 기다리는 순환을 피한다. 같은 이벤트 재수신도 현재 상태를 다시 검사하며 개인정보 응답·inbox/outbox 업무 행을 저장하지 않는다. 쓰기/영속 이벤트의 ACK 규칙은 유지한다.

기존 두 서비스 토큰과 설정된 origin만 사용한다. source/type/command/결과 필드와 ACK ID를 검증하고 리다이렉트를 거절한다. 요청 단계별 timeout은 15/10/5초로 안쪽부터 해제한다. 원본이 모든 저장 상세를 반환하므로 응답 크기/상세 수를 새로 제한하지 않는다. 장애/잘못된 ACK는 공개 503이며 관리자 로컬 조회는 상담 의존 장애 중에도 동작한다. 분리 DB에는 전역 MVCC 스냅샷이 없으므로 접근 범위의 소유 행 잠금과 order 스냅샷으로 한 시점의 일관된 결과를 만든다. 동시 통화 종료/고객 수정은 조회 동안 대기할 수 있다.

## DB 적용과 호환

각 서비스에 후속 Liquibase changeset만 추가한다. 기존 outbox/inbox 행과 적용 이력을 보존하고 outbox 순번·시도 횟수·다음 시각·마지막 HTTP 상태·조회 인덱스를 추가한다. customer에도 같은 메시지 테이블 2개를 추가한다. 적용 전부터 있던 행의 순번은 업그레이드 시 부여되며, 과거 작성 순서를 소급 보장하지 않는다. 기존 이벤트 테이블은 자동 삭제·TTL 정리하지 않는다.

새 publisher/relay보다 migration을 먼저 적용한다. 기존 앱은 추가 컬럼을 무시할 수 있다. 원래 Liquibase changeset은 수정하지 않는다.

## 검증

```sh
# 저장소 루트, Python 3 + 기존 Docker
python3 msa/shared/events/verify.py
# 5개 서비스 신규/기존 DB·기존 업무 함수·migration 실패 원자성
python3 msa/liquibase/verify.py
```

첫 명령은 호스트 포트 없는 임시 내부 네트워크와 PostgreSQL 17.11, Node.js 24 검증 이미지만 만든다. 실제 PG 트랜잭션·실제 HTTP·SIGKILL 후 재시작을 검사하며 생성한 자원 라벨을 확인한 뒤 해당 자원만 정리한다. 토큰·DB 비밀번호는 일회성 테스트 값이다. 운영 DB·Jenkins·k3s에 접속하지 않는다.

외부 API 전체 동등성과 실제 서비스 장착·운영 장애 복구는 아직 미검증이다. [전체 계획](../../../docs/msa-parity-plan.md)을 따른다.

## 주문 삭제의 조회와 영속 감사

`OrderDeletionCheckRequested`는 order가 consultation의 `/internal/order-deletion-check`로 보내는 고정 조회다. payload는 양수 int32 `orderSeq` 하나, 응답은 같은 eventId·processed와 `{blocked:boolean}`뿐이다. 기존 CUSTOMER_AUTH_TOKEN, 설정된 consultation origin, 5초 제한·리다이렉트 거절·엄격한 UTF-8/JSON·4KiB ACK 검사를 사용한다. source/type/추가 필드는 거절한다. 원본 SQL처럼 연결된 미삭제/미종료 통화가 있으면 true이며 통화 보관 기산일은 필터하지 않는다. 같은 이벤트도 현재 상태를 읽고 inbox/outbox나 개인정보 응답을 저장하지 않는다.

order의 쓰기 감사는 기존 `AuditPrepared`/`AuditCommitted`/`AuditAborted`를 사용한다. order 전용 준비 테이블과 source allowlist를 추가하고 업무 변경과 outbox를 같은 order 트랜잭션에 저장한다. 성공 응답 전 operations ACK를 확인하며 생산자 종료는 기존 advisory lock 증명과 `/internal/audit/flush`로 복구한다. 조회 ACK와 업무 확정 ACK를 혼동하지 않는다. 분리 DB의 전역 원자 트랜잭션을 주장하지 않는다.
