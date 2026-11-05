# Consultation 서비스

모놀리식과 같은 PBX 수신·녹취 워커와 진행 통화 수/SSE를 제공한다. 프론트·AI의 요청 형식은 바꾸지 않는다. Jira [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160), [이번 단계 계획·검증](../../../docs/msa-consultation-pbx-plan.md), [전체 동등성 계획](../../../docs/msa-parity-plan.md)을 따른다.

## 제공 API

- `POST /webhooks/pbx/call-ended`: 기존 Bearer·7개 필드·원문 응답. 수신함 저장 후 ACK하며 중복/충돌·5년 경계를 유지한다.
- 공개 프록시 경로 `POST /api/webhooks/pbx/call-ended`도 같은 처리로 연결한다. 기존 Nginx의 `/api` 제거 규칙을 앱에서 재현하며 PBX 응답을 업무 API envelope로 감싸지 않는다.
- `GET /api/calls/active-count`, `GET /api/calls/active-count/stream`: 현재 ACTIVE 관리자 세션 필요. PG 집계/NOTIFY와 보완 조회, 공유 구독, heartbeat, 인증 회수 시 종료를 유지한다.

customer의 기존 `POST /api/customers/context`에 call이 들어오면 내부 등록 이벤트로 통화를 생성·재사용한다. [고객 확인·통화 등록 계획](../../../docs/msa-caller-context-plan.md)을 따른다. 고객·주문을 생성하지 않으며 동일 통화 ID·발신번호·수신 시각·고객 논리 참조와 PBX 선도착 매칭을 유지한다. CALL_STARTED 감사 확정 후 응답하고 고객 조회/감사 준비 실패는 통화·PBX 연결·명령 수신 기록을 롤백한다. 명령 응답 유실·중복·실제 생산자 종료 복구도 검증한다.

customer의 고객 주소/PIN 요청은 `POST /internal/call-scope`에서 기존 CUSTOMER_AUTH_TOKEN으로 받는다. 원본 통화 조건으로 현재 발신번호·고객 참조·종료 상태를 읽고, 쓰기에는 FOR SHARE를 유지하면서 기존 CONSULTATION_AUTH_TOKEN으로 customer의 고정 내부 실행 경로에 위임한다. customer의 업무/수신 기록/감사 확정 후 반환하며 관리자나 주소록을 consultation DB에 복제하지 않는다. 공개 API/Swagger/Ingress에 이 경로를 추가하지 않는다. 상세 범위와 검증 한계는 [고객 수정·개인 PIN 계획](../../../docs/msa-customer-pins-plan.md)에 기록한다.

기존 PBX·녹취의 고정 연결·유일 후보·claim/재시도·S3 조건부 저장과 미연결 수신 30분 정리를 유지한다. 주문 결과·다른 상담/AI API·전체 보관 워커는 후속이다. 명령 수신 기록의 입력은 전체 보관 워커 이식 전까지 유지한다.

## 환경과 DB

Node.js 24에서 `npm ci` 후 환경을 설정하고 `npm run start:dev`를 실행한다. production/test는 `.env`를 읽지 않는다.

- consultation 전용 `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `OPERATIONS_URL`: 경로·자격정보 없는 정확한 HTTP(S) origin, 예시 `http://operations:3005`
- `CUSTOMER_URL`: customer의 정확한 HTTP(S) origin, k8s는 `http://customer:3001`
- `CUSTOMER_AUTH_TOKEN`: customer 등록 이벤트 인증용 32~256자 ASCII 비밀 값
- `CONSULTATION_AUTH_TOKEN`: operations와 공유하는 별도 32~256자 ASCII 서비스 비밀 값
- `CORS_ORIGINS`, `PORT` 기본 3004, `SWAGGER_ENABLED` 기본 true
- 기존 `PBX_WEBHOOK_TOKEN`, `AWS_REGION` 기본 ap-northeast-2, `S3_RECORDINGS_BUCKET`, `RECORDING_ALLOWED_HOSTS`, `RECORDING_MATCH_WINDOW_SECONDS` 기본 30(1~300)

consultation `004`, customer·operations `006`까지 먼저 적용한다. 앱은 스키마를 확인하며 DDL을 실행하지 않는다. 기존 통화·발화·녹취·메시지·과거 종료 사유를 보존하며 근거 없는 과거 등록 시각·고객 참조는 NULL로 남긴다.

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

Docker 빌드는 ESLint·단위 1개·E2E 5개·TypeScript를 검사한다. checks target은 인증/설정 6개·원본 집계/녹취 12개·DB 감사 경계 3개·고객 조회 이벤트 6개, 총 27개다. 검증기는 원본 PBX/워커 13개를 양쪽에 실행하고 원본 고객 확인 13개를 변경 없이 모놀리식에서 실행한다. production PBX/HTTP·DB·SSE와 별도 test 환경의 고객 확인/통화 등록 59개 동일 요청·전체 업무 행·15개 참조 DTO·실제 등록 SSE·명령 응답 유실·생산자 SIGKILL을 검사한다. test 환경은 아직 이식하지 않은 월별 청구 자동 워커를 제외한다. 로그는 `msa/liquibase/verification-logs/consultation/`에 남긴다.

Jenkins는 customer·consultation·operations 중 하나가 선택되면 `Verify Consultation Parity`를 실행하고 실패 시 배포를 중단한다. DB 적용 후 operations → customer → consultation 순서로 배포하며 다른 서비스 선택은 보존한다. 두 서비스 토큰은 기존 Secret에서 최초 생성/기존 값 보존 정책으로 공유한다. DB는 기존 서비스별 PG* Secret을 사용한다. Ingress는 기존 공개 경로를 유지하고 등록/조회/감사 내부 경로는 공개하지 않는다.

운영 PBX/S3 설정과 자격정보는 기존 값으로 `dva/consultation-runtime` Secret에서 주입한다. PBX 토큰·S3 버킷·허용 호스트·AWS 자격정보를 Git/명령 인자/로그에 넣지 않는다. Secret 자체는 선택 사항이며 토큰 미설정 시 PBX는 원본처럼 503을 반환한다. S3 미설정 시 통화 종료 매칭은 유지하고 파일 저장을 보류한다. 준비된 새 Pod부터 트래픽을 받고 실패 시 기존 리소스/이미지로 복구하지만 DB 변환은 앱 롤백으로 되돌리지 않는다.

실제 운영 Jenkins/공개 HTTPS·PBX/S3 자격정보를 사용한 외부 연동 및 전체 95개 API 동등성은 별도 검증 대상이다.
