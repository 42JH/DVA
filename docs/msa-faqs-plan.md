# FAQ MSA 이식 계획

Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)

기준은 MR !326이 병합된 `develop-backend`의 `3d8bf7b9d742e1571b7508139ea61c064bf89a99`다. backend tree `c19c5594540415c579b00eee1917df1cbd954a93`와 원본 migration 053까지를 계약으로 삼는다. 작업 브랜치는 `feature/msa-faqs`이며 수정은 msa/infra/docs에 한정한다.

## 범위와 순서

1. operations에 관리자 FAQ 목록·상세·단건/복수 등록·수정·삭제와 AI FAQ 목록, 총 6개 선언을 이식한다. 동일 DTO·정규화 중복·권한·Cookie/Origin 우선순위·오류·204/Location·페이지네이션을 보존한다.
2. operations 009에서 기존 FAQ의 ID·내용·시각을 보존하며 분류, 활성 질문 유일성, soft delete, 알림 대기와 최근 질문 스냅샷을 연결한다. 원본 027의 확인된 분류표만 사용하고 알 수 없는 분류/중복 행은 전체 롤백한다. 신규 FAQ나 과거 사례를 만들지 않는다. consultation 006은 원본 이벤트/미답변 저장 구조를 추가해 상세의 원본 이벤트·통화 조회를 지원한다.
3. FAQ 상세는 operations의 최근 10개 스냅샷을 조회하고 원본 event UUID들의 현재 통화 연결을 consultation의 인증된 비공개 조회 이벤트로 확인한다. 통화 삭제·보관 만료·원본 이벤트 삭제 뒤에는 사례를 보존하며 callSessionSeq만 null이다. 교차 DB SQL·고객 데이터 복제·공개 내부 경로는 사용하지 않는다.
4. 원본 FAQ 변경 알림 outbox·claim·순서·재시도·2초 timeout·202 ACK·SYSTEM 감사를 보존한다. 기존 AI_AGENT_URL과 AI_FAQ_TOKEN을 사용하며 토큰이 없으면 대기를 보존한다. 초기 FAQ CLI와 데이터도 원본 방식으로 연결한다. 새 의존성·Redis·브로커·클라이언트 API는 추가하지 않는다.
5. 독립 커밋 후 원본 테스트, production HTTP/DB/감사 대조, 알림 실패·재시작 복구, 신규/기존 DB와 SQL 실패 롤백, 기존 운영/상담/배포 회귀를 검증한다. 검증 근거와 미검증 범위를 기록하고 같은 Jira Task로 develop-backend 대상 MR을 생성한 뒤 사용자 병합을 기다린다.

## 영향 범위

operations의 FAQ 모듈·앱 등록·기존 인증 메타데이터·환경 검증·이미지의 초기 데이터·Ingress/Secret 연결, consultation의 비공개 조회·전역 prefix 제외·모듈 등록, 양 DB changelog와 검증 수치/fixture, parity 검증기·CI·문서를 함께 확인한다. 기존 적용 changeset과 backend/frontend/ai는 변경하지 않는다.

## 진행 중 최신 기준 동기화

작업 중 `bae5074`가 develop-backend에 병합되어 작업 브랜치에 merge했다. 현재 비교 기준 backend tree는 `46377df301afd942d27f2cbd9d24694c46a3aae6`, 원본 054까지다. 다른 작업의 backend/프론트/AI 코드는 수정하지 않으며 MR diff도 허용 폴더로 한정한다. 목표 브랜치의 개발 의존성 교체는 그대로 보존한다.

- consultation 007에 원본 054의 attempt_count·next_attempt_at·안전한 last_error_code·requires_review 제약과 기존 FAILED의 LEGACY_FAILURE 보완을 추가한다. 원본의 최대 5회, 1/5/15/30분 재시도, 정책 오류의 즉시 운영 확인, 만료된 5번째 claim 뒤 추가 업로드 금지와 미연결 30분 정리를 유지한다. 기존 발화/녹취/수신 payload·claim·시각·이력을 보존하고 실패 rollback을 검증한다.
- 이미 이식한 operations/customer/consultation의 인증 실패·로그인 성공 기록에 원본 HMAC 영역·사유/필드 허용 목록·프록시 끝부분 검증을 적용한다. 개인 ID·IP·비밀번호·토큰·원문 오류를 로그에 넣지 않는다. HTTP 응답·업무 감사와 내부 오류 envelope는 유지한다.
- 원본처럼 production의 SECURITY_LOG_HMAC_KEY는 64자리 hex 필수다. 기존 배포 Secret 생성 절차로 공유 `msa-security-logs`의 hmac-key를 최초 한 번 만들고 정상 기존 값은 그대로 사용한다. 잘못된 기존 값은 출력/교체하지 않고 배포를 중단한다. 기존 서비스 인증 토큰과 새 키는 분리한다. 개발/test만 임시 키를 허용한다.
- 원본 녹취 정책 테스트 4개는 주문 API와 무관한 원본 테스트 이름으로 선택해 복사본 수정 없이 양쪽에서 실행한다. 원본 전체 recordings 통합 suite의 주문·통화 조회 경로는 아직 이식하지 않아 이번 결과로 확대하지 않는다. 새 보안 기록의 공통 경계 검사를 세 서비스 이미지에서 실행하고 전체 기존 HTTP·이벤트/배포 회귀를 다시 실행한다.

## 검증의 한계

AI 통화 이벤트 수집과 FAQ 질문 사례의 교차 서비스 생성은 다음 단계다. 이번에는 원본과 같은 기존 업무 행을 주입해 상세 조회를 비교하며 이를 수집 API 검증으로 보고하지 않는다. 미답변 FAQ 전환·주문/청구·전체 보관 워커·전체 API 동등성도 후속이다. 실제 Jenkins/k3s/공개 HTTPS 및 실제 AI/PBX/S3 연동은 로컬 임시 PostgreSQL·HTTP 검증과 구분한다.

원본 auth-limits 통합 테스트는 AI 기업 검색까지 같은 앱으로 요청하므로 원본에서 그대로 실행한다. operations는 그 고객 API를 소유하지 않아 전체 suite를 operations 단독에 실행하면 해당 경로가 404다. operations의 원본 인증 단위/통합과 production 제한 비교를 유지하고 실제 양 앱 stdout의 인증 성공·제한 실패·HMAC 키 형식·출력 필드 허용 목록을 별도로 검증한다. 고객 API는 실제 customer 회귀와 공통 보안 경계 검사로 확인한다. 원본 테스트의 기대값이나 인증을 수정하지 않는다.

최근 질문의 분리 DB 조회는 operations 트랜잭션에서 FAQ 행을 먼저 FOR SHARE로 잠근 다음 별도 문장으로 스냅샷을 읽는다. consultation 조회가 끝날 때까지 FAQ 수정/삭제(사례 초기화)와 같은 행 잠금을 유지한다. 잠금 대기 후 최신 본문과 이전 사례가 섞이지 않게 읽기보다 잠금을 먼저 얻는다. 실제 consultation 테이블 잠금으로 응답을 멈추고 concurrent PATCH가 대기하는지·해제 후 원본의 읽기→수정 결과와 같은지 검증한다. 변경 전 이 검증은 PATCH가 먼저 끝나 실패했다. peer 실패/timeout은 기존 5초 경계에서 rollback하며 없는 통화로 위장하지 않는다.

## 최종 검증 기록 (2026-11-06)

아래 실행은 모두 최신 backend tree `46377df301afd942d27f2cbd9d24694c46a3aae6`와 원본 054까지를 기준으로 했다. 실행 label은 Docker 준비·복사·SQL·정리 등을 포함하며 테스트 개수가 아니다.

| 명령/범위 | 결과 |
|---|---|
| `python msa/parity/verify-operations.py` | `5f39536ed98e`, passed=true, 164개 실행 label. 원본 FAQ 42개를 수정 없이 양쪽에 각각 실행해 통과. production FAQ 59쌍의 상태·본문·Location/요청 ID/no-store/CORS와 매 요청 후 FAQ·사례·알림 대기·감사 업무 값을 비교했다. |
| FAQ 상세 경합·원본 조회 | 현재/삭제/보관 만료/이벤트 삭제의 callSessionSeq·최신 10개·5년·수정 초기화, 비공개 envelope/source/type/UUID/자격정보·Swagger 제외, 실제 DB 잠금 아래 읽기/수정 직렬화 통과. 사례는 기존 업무 행을 주입한 조회 검증이며 수집 API 검증이 아니다. |
| 실제 FAQ 알림 워커 | token 미설정 시 대기 보존, 503 뒤 선행 순서·SYSTEM 시도/실패 감사, 살아 있는 claim 중 양 production 앱 SIGKILL, 실제 30초 lease 뒤 동일 UUID/operation/ID 배열 재전송과 202 확정·후속 순서·감사 통과. 재시작 readiness 뒤 실제 배포 probe 통과. |
| 기존 operations 회귀 | 원본 인증·관리자·감사·페르소나 suite와 production 제한·세션/역할·실제 SIGKILL publication 복구 통과. 실제 stdout의 로그인 성공·제한 실패·HMAC 형식·허용 필드도 검사했다. |
| `python msa/parity/verify-consultation.py` | `509ccb33c680`, passed=true, 134개 실행 label. 원본 녹취 정책 4개를 양쪽에 각각 실행. 기존 production PBX/SSE·분석 99쌍·버전 참조 예약/감사/강제 종료, 별도 test 환경 고객 확인/PIN·잠금·복구 회귀 통과. |
| `python msa/parity/verify-customer.py` | `b3aa09c8c00b`, passed=true, 71개 실행 label. production 조회와 별도 test 환경 쓰기·감사·기존 정상 경로 회귀 통과. 자동 월별 청구 워커를 제외한 쓰기 검증이다. |
| 세 서비스 Docker checks/production 이미지 | ESLint·Jest·E2E·TypeScript와 각 이미지의 보안 경계 5개, 기존 customer/consultation Node 검사 및 새 FAQ 조회 ACK 검증 통과. 원본의 느슨한 any/비동기 콜백을 MSA의 기존 엄격한 타입 패턴으로 맞추었고 검사를 완화하지 않았다. |
| `DB_IMAGE=dva-liquibase:faq-latest-check python msa/liquibase/verify.py` | passed=true, 426개 실행 label. 5개 DB 신규 설치·재적용, 실제 FK/CHECK, 기존 FAQ/발화/수신 payload·시각·claim·이력/대기 보존, 미분류/중복 거절, 009/006/007 후반 SQL 실패 rollback과 기존 회귀 통과. |
| `python msa/shared/events/verify.py` | 실제 PostgreSQL/HTTP 이벤트 전달 15개와 기준 목록 1개 통과 (`7106a04cfd8b`). |
| Linux `python3 -m unittest discover -s msa/deploy/tests -p 'test_*.py'` | 61개 통과. HMAC 최초 생성·기존 값 보존·잘못된 값 비노출 거절·manifest 사전 준비와 기존 선택/실패 복구 포함. |

확인한 실패와 수정은 JDBC의 JSONB 물음표 해석(jsonb_exists로 동등 치환), 엄격한 TypeScript 경계, fixture의 필수 CUSTOMER_URL·재시작 readiness 누락, HMAC Secret 이름 연결, FAQ 분리 DB 읽기 경합이다. 원본은 유효 세션 GET에 Origin을 요구하지 않아 신규 테스트의 그 가정만 원본 코드/실행에 맞췄다. 원본 테스트·기대값·기능을 수정하거나 오류를 숨기지 않았다.

추적 수정은 msa/docs 내부이며 target 대비 backend/frontend/ai·루트 compose 및 의존성 변경은 없다. 기존 적용 SQL은 그대로 보존했다. 실제 운영 Jenkins·k3s·공개 HTTPS·실제 AI/PBX/S3, 전체 이벤트 수집/FAQ 사례 생성·미답변 전환·주문/청구·전체 보관 워커와 전체 API 동등성은 이번 완료 범위가 아니다. 다음 MR은 사용자 병합 확인 후 진행한다.
