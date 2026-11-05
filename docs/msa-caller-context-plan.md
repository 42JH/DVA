# 고객 확인·통화 등록 단계

Jira [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160), 기준 !293 병합 `198dc54`, 작업 브랜치 `feature/msa-caller-context`. 작업 중 병합된 최신 `04b7346`과 backend 트리 `a86433ae1728c2a4681a3fce35cfc33fd3eee335`를 반영한다. 기존 고객·구성원 입력과 고객 확인의 11자리 휴대전화 규칙도 같은 기준으로 갱신한다. backend·프론트·AI는 읽기 전용이며 변경은 msa/infra/docs만 허용한다.

## 범위와 순서

1. 기존 `POST /api/customers/context` 한 개의 조회·통화 등록 계약을 완전히 연결한다. call 없는 조회는 업무 데이터를 저장하지 않는다. call이 있으면 최초 번호·수신 시각과 providerCallId를 유지하고 같은 통화를 재사용한다. 고객·주문을 임의 생성하지 않는다.
2. customer가 기존 공개 경로·인증·DTO를 유지하고 call이 있는 요청을 consultation에 등록 이벤트로 위임한다. consultation이 통화 트랜잭션을 소유한다. customer에 서비스 인증을 거친 조회 이벤트로 현재 고객·소속·결제 자격·개인 PIN을 조회한다. 조회 이벤트는 재시도마다 새 스냅샷을 읽으며 개인정보 응답을 inbox/outbox에 복제하지 않는다. 프론트/AI의 요청·응답·인증 계약은 변경하지 않는다.
3. PBX와 같은 발신번호 잠금·미연결 종료 매칭, 유일 통화·중복/충돌·5년/삭제 경계를 유지한다. 후속 consultation 004로 고객 논리 참조를 추가하며 과거 연결은 추정하지 않는다. 고객 조회 실패는 통화·PBX 매칭을 롤백한다.
4. 성공 CALL_STARTED 감사는 기존 customer의 준비/확정/중단·생산자 종료 복구 방식을 consultation에도 적용한다. operations는 서비스별 허용 action·인증·준비 테이블을 분리하며 consultation의 토큰으로 customer 감사를 조작할 수 없게 한다. customer 006은 원본 045의 개인 PIN soft delete·활성 주소 유일성을 추가하며 기존 주소·버전·소유권을 보존한다. operations 006은 별도 준비 테이블만 추가하고 기존 customer 감사/이력은 보존한다.
5. 후속 SQL·시작 스키마 검사·Secret·정확한 Ingress 경로·배포 의존 순서·Docker context·Jenkins 비교 검증과 모든 호출자를 함께 연결한다. 통화 트랜잭션/감사 ACK 전에 성공 응답하지 않는다.

## 검증

- 입력/인증·OpenAPI operation과 참조 DTO, 등록/미등록/탈퇴·소속/결제/PIN·정규화·중복/충돌·삭제/만료·통화 재사용을 원본과 동일 HTTP/실제 분리 DB로 비교한다.
- PBX 선도착·진행 통화 수·고객 참조·한 번만 생성되는 감사, 동시 요청과 실패/재시작/응답 유실·직후 감사 조회를 검사한다. 고객 조회/감사 준비 실패가 통화나 성공 감사를 남기지 않는지 확인한다.
- 조회 이벤트의 토큰/형식·리다이렉트/잘못된 응답·서비스별 감사 권한, 기존 customer/consultation/operations와 이벤트·배포·DB 이관/rollback을 회귀 검증한다.
- 실제 운영 Jenkins/HTTPS·외부 PBX/S3 및 전체 95개 API 동등성과 구분해 결과를 기록한다.

고객 PATCH·개인 PIN 3개·기업 청구 및 나머지 상담/주문/운영 기능·전체 보관 워커는 후속 MR이다. 별도 프론트/AI API나 Redis/브로커를 추가하지 않는다. 개인정보 조회의 서비스 경계와 외부 의존성 장애를 숨기지 않는다.

## 검증 기록 (2026-11-05)

- 원격 develop-backend `04b7346`, backend 트리 `a86433ae1728c2a4681a3fce35cfc33fd3eee335`와 비교했다. 원본 고객 확인 테스트 13개는 변경 없이 모놀리식에서 실행했고, 원본 PBX 7개와 같은 워커/SQL 시나리오 6개는 양쪽에서 각각 통과했다. 원본 조회/저장/집계 테스트 3개는 Git blob과 LF 기준 SHA-256이 같다. Windows 체크아웃의 CRLF 차이는 테스트 내용 변경과 구분했다.
- customer·consultation·operations 독립 DB와 변경하지 않은 모놀리식에 동일 HTTP 59건을 각각 전송했다. 입력·인증·쿠키/Origin·메타·후행 슬래시/메서드·원본 11자리 전화번호·등록/미등록/탈퇴·소속/결제·121개 전체 개인 PIN과 삭제/다른 고객 PIN 숨김을 포함한다. 1개 OpenAPI operation과 참조 DTO 15개, 매 응답 후 고객 업무 6개 테이블·통화/녹취/PBX·감사 전체 행의 현행 업무 필드가 일치했다. 업무 ID·입력 시각·주소·감사 요청 ID는 그대로 비교하고 생성된 등록/관측/감사/수신 시각만 범위를 검증한 뒤 정규화했다.
- 실제 등록으로 SSE가 0→1→2로 변경되는 것과 직후 REST 집계를 확인했다. 같은 통화 10개 동시 요청은 양쪽에서 한 건만 생성했다. 테스트 잠금으로 최초 생성 요청을 고정해 감사 요청 ID까지 동일하게 검증했다. PBX 선도착 즉시 종료·삭제/5년 경계·미래 시각 보존·고객 조회/감사 준비 실패의 통화/연결/성공 감사 롤백도 확인했다.
- 명령 동일 재수신·본문 변조 거절, 조회 이벤트 재사용 시 현재 스냅샷/응답 미저장, 서비스별 감사 action/result/actor/target·준비 테이블 격리를 실제 PG/HTTP로 검사했다. 실제 consultation HTTP/DB 커밋 후 성공 응답을 소비자에서 버리는 모의 유실에서 compiled customer client/service의 503·재시도·통화/감사 단일성을 확인했다. 실제 생산자 자식 프로세스 SIGKILL 후 통화/명령 수신 기록 롤백·미확정 감사 중단·재시도도 통과했다. DB COMMIT 응답 미확정은 별도 DB wrapper 단위 경계 검사이며 실제 DB 연결 장애를 모두 재현한 것은 아니다.
- 비교 드라이버 101단계 통과. 기존 production PBX HTTP 19건·3개 OpenAPI·DB·SSE/구독 복구/heartbeat/세션 회수도 유지했다. 고객 확인 59건은 양쪽 NODE_ENV=test의 전경 처리 검증으로, 아직 이식하지 않은 원본 월별 청구 자동 워커를 제외한다. production 전체 워커/DB 동등성으로 확대하지 않는다.
- Linux Node.js 24 이미지에서 lint/build·서비스별 단위 1개, customer E2E 7개·checks 14개, consultation E2E 5개·checks 27개, operations E2E 7개 통과. operations 원본 인증 40개씩·설정 2개·기존 11개 API의 production HTTP/DB/probe와 customer production 조회/인증 77건 및 test 전경 쓰기/조회/감사 54건·복구 비교도 통과했다. operations 설정의 새 URL 경계는 별도 Node 검사 2개에서도 확인했다.
- PostgreSQL 17.11/Liquibase 5.0.4 드라이버 291단계 통과. 신규 설치·재적용·이전 데이터/버전/소유권/이력/이벤트 보존·신규 changeset 후반 실패 rollback을 확인했다. 기존 적용 changeset은 수정하지 않았다. 업무/메시지/준비/Liquibase 테이블은 public 42개와 PBX 비공개 1개다.
- 공통 이벤트 단위 5개·PG/HTTP 15개·현재 95개 라우트/migration/worker 기준 1개, Linux 배포/선택/복구 59개 통과. 의존 순서 적용 중 다른 서비스 선택을 누락하던 회귀를 테스트로 재현하고 보존했다. Python 5개·Bash 13개·Jenkins shell 3개·XML 3개 구문과 문서 링크도 확인했다. 세 서비스 운영 의존성 npm audit은 각각 0건이다.
- 운영 kubeconfig 없이 격리 k3s v1.35.5+k3s1에서 실제 DB·Secret·Liquibase·인증/고객 조회 의존성을 연결했다. 최초 배포·정상 교체·의도적 readiness 실패 후 기존 이미지/리소스 복구를 확인했다. consultation HTTP 473건, customer 475건, operations 481건으로 실패 모두 0건이다. 생성한 자원만 소유 라벨을 확인해 정리했다.
- 실제 운영 Jenkins/공개 HTTPS·실제 PBX/S3 자격정보 연동·전체 95개 API/자동 워커·분산 장애 전부는 미검증이다. 고객 PATCH/PIN/청구·다른 상담/AI/주문/운영 기능과 명령 수신 기록을 포함한 전체 보관 워커는 후속이다. 기존 운영 PBX/S3 설정은 이전 단계와 같은 Secret으로 주입해야 한다.
