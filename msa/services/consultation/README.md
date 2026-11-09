# Consultation 서비스

[주문 조회 이식](../../../docs/msa-order-reads-plan.md)은 기존 공개 상담 API를 유지하고 `/internal/order-read`만 추가한다. 기존 customer 토큰과 `OrderReadRequested`를 검증하고, 통화의 삭제/보관·종료·연결 주문 조건을 확인한 뒤 customer에 현재 발신번호의 활성 고객 확인을 요청한다. 조회가 끝날 때까지 통화 공유 잠금을 유지한다. 내부 경로는 Ingress/Swagger에 공개하지 않으며 이벤트 업무 행이나 개인정보 응답을 저장하지 않는다.

모놀리식과 같은 PBX 수신·녹취 워커와 진행 통화 수/SSE를 제공한다. 프론트·AI의 요청 형식은 바꾸지 않는다. Jira [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160), [이번 단계 계획·검증](../../../docs/msa-consultation-pbx-plan.md), [전체 동등성 계획](../../../docs/msa-parity-plan.md)을 따른다.

055 이전 통화는 order_intake_enabled=false, 이후 등록은 true다. 신규 통화의 AI 주문 취소는 삭제/보관 조건보다 먼저 원본 409로 거절한다. 관리자 통화 삭제는 미확정 통화의 유효 READY/EDITING 초안을 order에 확인하며, 확정 완료된 통화는 이 의존 확인을 건너뛴다. 기존 통화/녹취 진행 차단·감사·잠금은 유지한다.

consultation 008은 과거 주문 연결의 통화 수/발신번호를 임시 보관한다. order가 모든 초안 연결을 커밋한 뒤 인증된 정리 이벤트로 이 사본을 지운다. 내부 조회/정리는 Swagger·Ingress에 공개하지 않는다. [055 전환과 검증](../../../docs/msa-draft-compatibility-plan.md)을 따른다.

## 제공 API

- `POST /webhooks/pbx/call-ended`: 기존 Bearer·7개 필드·원문 응답. 수신함 저장 후 ACK하며 중복/충돌·5년 경계를 유지한다.
- 공개 프록시 경로 `POST /api/webhooks/pbx/call-ended`도 같은 처리로 연결한다. 기존 Nginx의 `/api` 제거 규칙을 앱에서 재현하며 PBX 응답을 업무 API envelope로 감싸지 않는다.
- `GET /api/calls/active-count`, `GET /api/calls/active-count/stream`: 현재 ACTIVE 관리자 세션 필요. PG 집계/NOTIFY와 보완 조회, 공유 구독, heartbeat, 인증 회수 시 종료를 유지한다.
- `POST /api/ai/calls/:id/analysis`, `stage-metrics`, `response-wait-metrics`: 원본 AI_INSIGHTS_TOKEN·DTO·204·정규화/해시·항목별 중복/충돌·실패 감사·PBX 시각 우선순위를 유지한다. [분석 이식 계획과 검증](../../../docs/msa-call-analysis-plan.md)을 따른다.

실제 페르소나 버전은 operations의 인증된 PersonaVersionRequested 이벤트로 매번 확인하고 조회 ACK 전에 FK 참조를 예약한다. 새 분석의 AuditPrepared가 예약을 연결하고 AuditCommitted가 확정하며, 동일 재수신의 임시 참조와 미커밋 중단은 기존 생산자 잠금 증명·AuditAborted로 해제한다. operations 앱이 1초 간격으로 대기 상담 트랜잭션의 증명을 확인해 감사 준비 전 생산자 종료도 회수한다. 비공개 personaVersionSeq는 감사 metadata에 넣지 않는다. 상담 DB에 페르소나를 복제하지 않으며 향후 분석 보관 삭제를 이식할 때 확정 참조 해제를 함께 연결해야 한다.

customer의 기존 `POST /api/customers/context`에 call이 들어오면 내부 등록 이벤트로 통화를 생성·재사용한다. [고객 확인·통화 등록 계획](../../../docs/msa-caller-context-plan.md)을 따른다. 고객·주문을 생성하지 않으며 동일 통화 ID·발신번호·수신 시각·고객 논리 참조와 PBX 선도착 매칭을 유지한다. CALL_STARTED 감사 확정 후 응답하고 고객 조회/감사 준비 실패는 통화·PBX 연결·명령 수신 기록을 롤백한다. 명령 응답 유실·중복·실제 생산자 종료 복구도 검증한다.

customer의 고객 주소/PIN 요청은 `POST /internal/call-scope`에서 기존 CUSTOMER_AUTH_TOKEN으로 받는다. 원본 통화 조건으로 현재 발신번호·고객 참조·종료 상태를 읽고, 쓰기에는 FOR SHARE를 유지하면서 기존 CONSULTATION_AUTH_TOKEN으로 customer의 고정 내부 실행 경로에 위임한다. customer의 업무/수신 기록/감사 확정 후 반환하며 관리자나 주소록을 consultation DB에 복제하지 않는다. 공개 API/Swagger/Ingress에 이 경로를 추가하지 않는다. 상세 범위와 검증 한계는 [고객 수정·개인 PIN 계획](../../../docs/msa-customer-pins-plan.md)에 기록한다.

기존 PBX·녹취의 고정 연결·유일 후보·claim/재시도·S3 조건부 저장과 미연결 수신 30분 정리를 유지한다. 주문 결과·다른 상담/AI API·전체 보관 워커는 후속이다. 명령 수신 기록의 입력은 전체 보관 워커 이식 전까지 유지한다.

## 환경과 DB

Node.js 24에서 `npm ci` 후 환경을 설정하고 `npm run start:dev`를 실행한다. production/test는 `.env`를 읽지 않는다.

- consultation 전용 `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `OPERATIONS_URL`: 경로·자격정보 없는 정확한 HTTP(S) origin, 예시 `http://operations:3005`
- `ORDER_URL`: 통화 삭제의 미확정 READY/EDITING 초안 확인용 정확한 HTTP(S) origin. k8s는 `http://order:3002`이며 누락/장애 시 해당 삭제는 503으로 롤백한다.
- `CUSTOMER_URL`: customer의 정확한 HTTP(S) origin, k8s는 `http://customer:3001`
- `CUSTOMER_AUTH_TOKEN`: customer 등록 이벤트 인증용 32~256자 ASCII 비밀 값
- `CONSULTATION_AUTH_TOKEN`: operations와 공유하는 별도 32~256자 ASCII 서비스 비밀 값
- `CORS_ORIGINS`, `PORT` 기본 3004, `SWAGGER_ENABLED` 기본 true
- 기존 `PBX_WEBHOOK_TOKEN`, `AWS_REGION` 기본 ap-northeast-2, `S3_RECORDINGS_BUCKET`, `RECORDING_ALLOWED_HOSTS`, `RECORDING_MATCH_WINDOW_SECONDS` 기본 30(1~300)
- `AI_INSIGHTS_TOKEN`: 원본과 같은 선택적 32자 이상 공백 없는 ASCII 토큰. consultation-runtime Secret의 기존 원본 값을 사용한다. 미설정이면 분석/지표·미답변 수집 네 API만 503이며 관리자 쿠키도 이 토큰을 대신하지 않는다.

consultation `007`, customer `007`, operations `009`까지 먼저 적용한다. 앱은 스키마를 확인하며 DDL을 실행하지 않는다. 기존 통화·발화·녹취·메시지·과거 종료 사유를 보존하며 근거 없는 과거 등록 시각·고객 참조·분석은 만들지 않는다.

세션/관리자를 복제하지 않고 operations의 기존 `POST /internal/auth/session`에 위임한다. 매 요청/heartbeat에 현재 세션을 확인하고 시간·응답 크기·정확한 필드·리다이렉트 경계를 적용한다. consultation 토큰은 customer 감사 이벤트나 공개 관리자 API 접근 권한을 부여하지 않는다.

- `/consultation/health`: 프로세스 상태
- `/consultation/health/ready`: consultation DB·operations 인증/이벤트·customer 조회 이벤트와 서비스 인증 확인
- `/consultation/docs`, `/consultation/docs-json`: 기존 문서 주소
- `/api/docs`, `/api/docs-json`: 서비스 내 문서 별칭

## 배포와 검증

```sh
docker build -t dva-consultation:local -f msa/services/consultation/Dockerfile msa
python msa/parity/verify-consultation.py
python msa/deploy/tests/integration_app_rollout.py --service consultation --image dva-consultation:local
```

Docker 빌드는 ESLint·E2E·TypeScript와 보안 로그 단위를 검사하며 checks target에서 인증·통화·녹취·감사·고객/분석 연결 단위를 실행한다. 업무 검증기는 고정 원본의 분석/지표·녹취 정책 회귀를 MSA에서 한 번 실행하며 분리 서비스 필수 환경만 fixture로 추가한다. 원본에서만 따로 실행하던 중복 회귀는 제거했다. production 분석·지표 HTTP/DB/해시/감사 비교, 버전 삭제 경합·실제 SIGKILL 복구와 PBX/HTTP·DB·SSE는 유지한다. 고객 확인/PIN은 별도 test 환경에서 원본 업무 행·DTO·등록 SSE·명령 유실·종료 복구를 비교하며 아직 이식하지 않은 월별 청구 자동 워커를 제외한다. 현재 업무 회귀는 50개이며 [정리 결과](../../../docs/msa-test-prune-results.md)에 전체 집계와 제거 근거가 있다. 로그는 `msa/liquibase/verification-logs/consultation/`에 남긴다.

Jenkins는 customer·consultation·operations·order 중 하나가 선택되면 `Verify Consultation Parity`를 실행하고 실패 시 배포를 중단한다. DB 적용 후 operations → customer → consultation 순서로 배포하며 다른 서비스 선택은 보존한다. 두 서비스 토큰은 기존 Secret에서 최초 생성/기존 값 보존 정책으로 공유한다. DB는 기존 서비스별 PG* Secret을 사용한다. Ingress는 기존 공개 경로를 유지하고 등록/조회/감사 내부 경로는 공개하지 않는다.

운영 PBX/S3 설정과 자격정보는 기존 값으로 `dva/consultation-runtime` Secret에서 주입한다. PBX 토큰·S3 버킷·허용 호스트·AWS 자격정보를 Git/명령 인자/로그에 넣지 않는다. Secret 자체는 선택 사항이며 토큰 미설정 시 PBX는 원본처럼 503을 반환한다. S3 미설정 시 통화 종료 매칭은 유지하고 파일 저장을 보류한다. 준비된 새 Pod부터 트래픽을 받고 실패 시 기존 리소스/이미지로 복구하지만 DB 변환은 앱 롤백으로 되돌리지 않는다.

실제 운영 Jenkins/공개 HTTPS·PBX/S3 자격정보를 사용한 외부 연동 및 전체 96개 API 동등성은 별도 검증 대상이다.

## FAQ 상세의 원본 통화 조회

operations의 `POST /internal/faq-call-sources` 조회 이벤트만 `auth:internal-operations`와 기존 CONSULTATION_AUTH_TOKEN으로 허용한다. event envelope/source/type/최대 10개 중복 없는 UUID를 검증하며 현재 이벤트→통화의 조회 가능 번호만 반환한다. 공개 prefix·Swagger·Ingress에 노출하지 않는다. 006은 원본 026/045/049의 이벤트/미답변 스키마와 로컬 제약을 추가한다. 미답변 수집·삭제와 통화 콘텐츠 조회·삭제는 아래 범위로 연결하며 이벤트 수집 API와 사례 생성 이벤트·전체 보관 워커는 아직 후속이다. [FAQ 계획](../../../docs/msa-faqs-plan.md)을 따른다.

## 원본 054와 보안 기록 동기화

녹취 처리 시도는 최초 포함 최대 5회이며 1/5/15/30분 대기를 DB에 저장한다. 정책 위반은 첫 실패부터, 재시도 소진/마지막 시도 중단은 운영 확인으로 보존한다. 안전한 코드만 기록하고 원문 URL·외부 오류를 노출하지 않는다. S3 미설정·미매칭 대기는 시도를 소비하지 않으며 미연결 수신의 30분 만료는 유지한다. [원본 운영 정책](../../../backend/docs/recording-retry-policy.md)을 따른다.

인증 실패 기록은 기존 API 응답/감사와 별도로 원본 HMAC 익명 키·사유만 출력한다. production은 `msa-security-logs` Secret의 64자리 hex hmac-key를 사용하며 배포기가 최초 생성/기존 값 검증을 수행한다. 기존 키는 재생성하지 않는다. 기본 AUTH_PROXY_HOPS=0이며 실제 신뢰 프록시 구성이 확인된 경우에만 1/2로 설정한다.


## 미답변과 통화 콘텐츠

[통화 콘텐츠 이식 계획](../../../docs/msa-call-content-plan.md)에 따라 consultation 공개 선언은 12개다. 새 선언은 POST /api/ai/unanswered-questions, DELETE /api/unanswered-questions/:id, GET /api/calls/:id/transcript·actions·processing-results와 DELETE /api/calls/:id 6개다. 동일 AI_INSIGHTS_TOKEN·관리자 세션/Origin·DTO·오류/응답·페이지네이션을 사용한다. 미답변 수집은 최초 201/동일 발생 200이며 사유·원문·해시·상태를 보존한다. 최신 원본처럼 삭제는 원문을 보존하고 통화 처리 결과에서만 원문/사유를 숨긴다. 원본 Swagger의 과거 원문 삭제 설명보다 실제 SQL/045 이후 보존 정책을 따른다.

미답변 쓰기·통화 삭제와 operations 감사는 기존 준비/확정/중단 이벤트로 연결한다. FAQ·고객·주문 테이블을 상담 DB에 복제하지 않는다. 통화 삭제는 종료·녹취 완료와 2초 잠금 조건을 유지하고 PBX·분석·발화·FAQ 원본 링크를 기존 조회 조건으로 숨긴다. 물리 폐기 워커는 후속이다. 기존 consultation 007로 충분하며 새 migration/의존성/Secret은 없다. Ingress는 기존 미답변 URL을 consultation에 연결한다.

이벤트 수집·FAQ 사례 생성, 주문 소유권 확인, 미답변 목록/FAQ 전환, 통화 목록/상세·녹취 재생과 전체 동등성은 아직 후속이다. 새 조회 검증의 발화·AI 동작·처리 결과는 기존 정상 업무 행을 주입한 fixture이며 수집 API 검증을 뜻하지 않는다.
