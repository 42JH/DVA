# 고객 수정·개인 PIN 이식

Jira [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160), !300 병합 `5cefb2e`, backend 트리 `a86433ae1728c2a4681a3fce35cfc33fd3eee335`, 작업 브랜치 `feature/msa-customer-pins`를 기준으로 한다. backend·프론트·AI는 읽기 전용이다. 추적 수정은 msa/infra/docs로 한정하고 별도 프론트/AI API·Redis·브로커를 추가하지 않는다.

## 구현 범위

1. 기존 PATCH `/api/customers/:id`, GET/POST `/api/customers/:id/pins`, PATCH `/api/pins/:id`를 원본 Controller/DTO/Service/SQL 계약으로 이식한다. customer 공개 API는 22/23개가 된다. 기업 청구 GET과 자동 청구 워커는 주문·청구 단계에서 연결한다.
2. 이름 단독 AI 수정·관리자 세션/Origin·상태/월결제 관리자 전용·탈퇴 복구 거절·내 주소 null/전체 교체를 유지한다. AI 기본 주소는 진행 중 본인 통화만 허용한다. PIN 조회는 진행 중 통화만, 쓰기는 종료 후에도 허용하며 삭제/5년 보관 만료·다른 고객/전화번호 재사용은 거절한다.
3. PIN의 NFC/문자열/11자리 전화번호·완성 주소 검증, 리터럴 검색/페이지/total_count·삭제 숨김, DB 정규화 주소 중복, 지정 필드만 변경·호환 expectedVersion 무시·실제 변경 버전 증가·소유권/기존 주문 스냅샷 보존을 유지한다. 기존 customer 006까지의 함수/트리거/인덱스를 재사용하고 적용 changeset은 수정하지 않는다.
4. 공개 인증/검증을 마친 AI 요청은 인증 이벤트로 consultation에 통화 범위 처리를 요청한다. consultation은 원본처럼 통화를 읽고 쓰기에는 FOR SHARE를 유지한 채 customer의 고정 내부 실행 경로에 위임한다. customer가 자기 DB/감사 결정을 커밋하고 감사 ACK를 확인할 때까지 통화 잠금을 유지한다. 교차 DB 쿼리·HTTP 너머로 SQL 클라이언트 전달·세션 복제는 하지 않는다.
5. 내부 실행은 원본 업무 서비스에 통화 스냅샷을 주입한다. 쓰기의 동일 이벤트는 업무·감사와 같은 트랜잭션의 customer inbox로 중복 방지하며 입력은 해시, 결과는 식별자/버전만 보관한다. 조회 결과/주소/전화번호를 메시지 수신 기록에 저장하지 않는다. 기존 준비/확정/중단·SIGKILL 감사 복구를 재사용하고 operations의 customer 허용 목록에 해당 감사 action/target만 추가한다.
6. 모든 호출자·내부 토큰/경로·Swagger·Ingress·Docker/CI·배포 fixture·문서·테스트를 함께 확인한다. 추가 공개 경로나 도구/런타임 앱은 만들지 않는다.

## 검증 순서

- 원본 고객/PIN 통합 테스트를 수정 없이 모놀리식에서 실행한다. 동일 HTTP/초기 데이터를 실제 customer/consultation/operations 분리 DB에 보내 네 API와 참조 DTO, 응답/오류/쿠키/메타·매 요청 후 고객/PIN/감사 전체 업무 행을 비교한다.
- 이름/상태/주소와 PIN 생성/검색/부분 수정·버전·중복·삭제/탈퇴·통화 번호/종료/삭제/만료·전화번호 재사용·현재 관리자 권한/세션 회수·입력 검증/오류 우선순위를 확인한다. 기존 주문 주소 스냅샷을 건드리지 않는 원본 SQL과 독립 DB 소유권도 확인한다.
- 실제 PG 잠금으로 통화 종료 앞/뒤 경합을 재현하고, 동시 PIN 부분 수정/중복 생성·감사 실패 rollback·내부 동일 이벤트/변조/잘못된 토큰·성공 응답 유실/생산자 종료 복구를 확인한다. 모의 장애와 실제 프로세스/DB 장애를 구분해 보고한다.
- Linux lint/build/단위/E2E, 기존 customer/consultation/operations·이벤트·DB·배포 회귀를 수행한다. production PBX/읽기와 NODE_ENV=test 전경 업무를 구분하며 전체 자동 워커 동등성으로 확대하지 않는다.
- 계획 → 구현 → 검증 결과를 작업 단위로 커밋하고 같은 Jira Task에 연결한 MR → develop-backend를 생성한다. 직접 승인/병합·자동 병합·이슈 상태 변경은 하지 않는다. 사용자 병합 확인 후 다음 MR을 시작한다.

실제 운영 Jenkins/HTTPS·실제 PBX/S3·전체 95개 API/자동 워커·모든 분산 장애는 후속 검증이다. 기술 수신 기록의 전체 보관 정책은 기존 보관 워커 이식 단계에서 연결한다.

## 검증 기록 (2026-11-05)

- 최신 원격 기준은 `5cefb2e`, backend 트리는 `a86433ae1728c2a4681a3fce35cfc33fd3eee335`다. backend/프론트/AI는 수정하지 않았다. 원본 고객 통합 16개·PIN 18개·고객 확인 13개·PBX 7개와 동일 워커 SQL 6개가 모놀리식에서 모두 통과했다(합계 60개). PBX/워커 13개는 MSA에서도 통과했다. 원본 테스트는 실행 시 그대로 복사하며 테스트 기대값을 바꾸지 않았다.
- 실제 customer/consultation/operations 분리 DB와 모놀리식에 동일 HTTP 115건씩 전송했다. 네 OpenAPI operation과 참조 DTO 15개, 매 응답 후 고객 업무 6개 테이블·통화·감사 전체 행/현행 업무 필드가 일치했다. 개인 PIN의 생성 검색 값·소유권·버전·삭제 시각도 비교했다. 행을 걸러내지 않았으며 업무 ID·입력 시각·주소·감사 요청 ID를 유지하고 생성 감사 시각만 범위를 검증한 뒤 정규화했다. 로그인 만료는 9시간 TTL을 확인한 뒤 정규화했다.
- 이름/상태/월결제/주소의 권한·null/전체 교체·탈퇴 복구 거절, PIN 생성/조회/검색/빈 페이지/total_count·중복·soft delete/활성 주소 재사용·부분 수정·stale expectedVersion·실제 변경 버전·타인/전화번호 재사용·통화 종료/삭제/만료·관리자 세 역할/Origin/잘못된 쿠키/세션 회수·오류 우선순위를 확인했다. 같은 Idempotency-Key로 다른 PIN 주소를 생성하고 다른 키의 같은 주소는 거절하는 원본 계약도 유지했다. JSON 400, 100KiB 초과 413, 내부 envelope가 커지는 100,500자 주소 요청도 비교했다.
- 실제 PG 잠금으로 두 요청의 같은 주소 INSERT를 경합시켜 201/409와 단일 PIN·성공 감사를 비교했다. 첫 성공 감사의 대기를 제어해 생성자를 고정했고 중복 INSERT의 실제 유일 키 대기를 확인했다. 동시 부분 수정은 실제 PIN 행 잠금 대기로 순서를 고정해 별칭과 주소가 모두 남고 감사 요청 ID도 일치하는지 확인했다. 통화 종료가 선행하면 기다리던 고객 주소 변경을 409로 거절하며, PIN 저장 중에는 통화 FOR SHARE가 유지돼 종료가 대기하는 두 경합도 통과했다.
- 감사 INSERT를 실제로 실패시키면 고객/PIN 값·버전·성공 감사가 롤백되고 복구 후 성공했다. 내부 쓰기 동일 재수신은 한 번만 반영됐으며 입력 변조·서비스 토큰/source/actor 추가는 거절됐다. inbox에는 해시와 식별자/버전만 있고 원문은 없었다. 조회 재수신은 변경된 최신 페이지를 반환하며 양쪽 inbox에 응답을 저장하지 않았다.
- 실제 내부 성공 응답을 받은 뒤 같은 이벤트를 다시 전송하는 모의 유실에서 중복 반영이 없었다. 실제 compiled customer Scope/PIN/감사 코드를 실행한 자식 프로세스를 준비 감사 후 SIGKILL해 미커밋 PIN·수신 기록 롤백과 고아 준비 감사 중단을 확인했다. 같은 이벤트 재시도 두 번에서 버전 증가와 성공 감사는 한 번이었다. 물리 TCP 응답 유실이나 consultation 잠금 소유 프로세스/DB 연결 종료와 customer 작업의 복합 장애 전부를 재현한 것은 아니다. 통화 잠금은 consultation DB 연결 수명에 따른다.
- 비교 드라이버 111단계 통과. 기존 test 고객 확인 59건·등록 SSE/응답 유실/생산자 종료, production PBX 19건·OpenAPI 3개·SSE/구독 복구/heartbeat/세션 회수도 통과했다. 새 115건은 NODE_ENV=test의 전경 업무 검증으로, 아직 이식하지 않은 자동 월별 청구/보관 워커를 제외한다. 원본 PIN의 주문 스냅샷 보존 테스트는 원본에서 통과했으며 MSA 주문 서비스 전체 동등성을 의미하지 않는다.
- Linux Node.js 24에서 세 서비스 lint/build·단위 각 1개, customer E2E 8개, consultation E2E 6개, operations E2E 7개 통과. 기존 customer production 조회/인증 77건 + test 쓰기/조회/감사 54건·복구, operations 원본 인증 40개씩·production 11개 API 및 probe도 통과했다. customer/consultation checks 14개/27개도 유지했다. 새 의존성은 없으며 운영 이미지 npm audit은 세 서비스 모두 0건이었다.
- 새 DDL/changeset 없이 기존 customer 006·consultation 004·operations 006의 함수/제약/인덱스를 재사용했다. PostgreSQL 17.11/Liquibase 5.0.4 신규 설치·재적용·업그레이드/이력/이벤트/주소·소유권·버전 보존 및 실패 rollback 291단계를 통과했다. public 42개와 PBX 비공개 1개 테이블을 유지한다.
- 공통 이벤트 단위 7개·실제 PG/HTTP 15개·현재 95개 기준 목록 1개, Linux 배포/선택/복구 59개 통과. Python 1개·Bash 13개·Jenkins shell 3개·XML 5개 구문과 문서 링크를 확인했다. 기존 통화 원본 테스트 3개는 Git blob과 LF 기준 SHA-256이 같다. 추가한 원본 테스트의 잔여 관리자 fixture가 PBX 비교와 충돌하던 문제는 각 비교 시작 시 독립 초기화해 해결했고 기존 assertion을 유지했다.
- 격리 k3s v1.35.5+k3s1에서 세 서비스의 최초 배포·정상 교체·의도적 readiness 실패 후 이전 리소스/이미지 복구를 통과했다. HTTP customer 489건·consultation 488건·operations 466건, 합계 1,443건 중 실패 0건이었다. 새 `/api/pins` Ingress manifest도 적용했다. 운영 kubeconfig는 사용하지 않았다. 검증 컨테이너·네트워크는 소유 라벨을 확인해 정리했다.

남은 customer 1개는 기업 월 청구 GET이다. 주문·청구·나머지 상담/AI/운영 기능과 전체 자동/보관 워커, 실제 운영 Jenkins/공개 HTTPS·PBX/S3·전체 동등성은 후속 MR이다. 이 단계의 완료를 전체 이식 완료로 보고하지 않는다.
