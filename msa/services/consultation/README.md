# Consultation 서비스

모놀리식과 같은 PBX 수신·녹취 워커와 진행 통화 수/SSE를 제공한다. 프론트·AI의 요청 형식은 바꾸지 않는다. Jira [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160), [이번 단계 계획·검증](../../../docs/msa-consultation-pbx-plan.md), [전체 동등성 계획](../../../docs/msa-parity-plan.md)을 따른다.

## 제공 API

- `POST /webhooks/pbx/call-ended`: 기존 Bearer·7개 필드·원문 응답. 수신함 저장 후 ACK하며 중복/충돌·5년 경계를 유지한다.
- 공개 프록시 경로 `POST /api/webhooks/pbx/call-ended`도 같은 처리로 연결한다. 기존 Nginx의 `/api` 제거 규칙을 앱에서 재현하며 PBX 응답을 업무 API envelope로 감싸지 않는다.
- `GET /api/calls/active-count`, `GET /api/calls/active-count/stream`: 현재 ACTIVE 관리자 세션 필요. PG 집계/NOTIFY와 보완 조회, 공유 구독, heartbeat, 인증 회수 시 종료를 유지한다.

통화 생성은 고객 컨텍스트/주문 API와 연결하는 후속 작업이다. 임의 통화·고객·주문을 생성하지 않는다. 기존 유효 통화에 PBX 종료가 오면 시작/종료 시각과 연결을 고정하며, 후보가 없거나 여러 개면 추정 연결하지 않는다. 녹취는 기존 claim·재시도·S3 조건부 저장을 사용하고 무의미한 미연결 수신만 원본의 30분 정책으로 정리한다. 다른 통화 조회/삭제·분석/발화·AI 이벤트·대시보드와 전체 보관 워커는 아직 제공하지 않는다.

## 환경과 DB

Node.js 24에서 `npm ci` 후 환경을 설정하고 `npm run start:dev`를 실행한다. production/test는 `.env`를 읽지 않는다.

- consultation 전용 `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `OPERATIONS_URL`: 경로·자격정보 없는 정확한 HTTP(S) origin, 예시 `http://operations:3005`
- `CONSULTATION_AUTH_TOKEN`: operations와 공유하는 별도 32~256자 ASCII 서비스 비밀 값
- `CORS_ORIGINS`, `PORT` 기본 3004, `SWAGGER_ENABLED` 기본 true
- 기존 `PBX_WEBHOOK_TOKEN`, `AWS_REGION` 기본 ap-northeast-2, `S3_RECORDINGS_BUCKET`, `RECORDING_ALLOWED_HOSTS`, `RECORDING_MATCH_WINDOW_SECONDS` 기본 30(1~300)

consultation Liquibase `003`과 operations `005`를 먼저 적용한다. 앱은 스키마를 확인하며 DDL을 실행하지 않는다. 기존 통화·발화·녹취·대기 이벤트와 과거 종료 사유를 보존한다. 실제 PBX 시작 시각만 누락된 도착 시각으로 사용하며 과거 등록 시각을 임의 생성하지 않는다. 등록 시각이 없는 legacy 통화는 활성 통화로 추정하지 않는다.

세션/관리자를 복제하지 않고 operations의 기존 `POST /internal/auth/session`에 위임한다. 매 요청/heartbeat에 현재 세션을 확인하고 시간·응답 크기·정확한 필드·리다이렉트 경계를 적용한다. consultation 토큰은 customer 감사 이벤트나 공개 관리자 API 접근 권한을 부여하지 않는다.

- `/consultation/health`: 프로세스 상태
- `/consultation/health/ready`: consultation DB와 operations DB/내부 세션 인증 확인
- `/consultation/docs`, `/consultation/docs-json`: 기존 문서 주소
- `/api/docs`, `/api/docs-json`: 서비스 내 문서 별칭

## 배포와 검증

```sh
docker build -t dva-consultation:local msa/services/consultation
python msa/parity/verify-consultation.py
python msa/deploy/tests/integration_app_rollout.py --service consultation --image dva-consultation:local
```

Docker 빌드는 ESLint·단위 1개·E2E 5개·TypeScript 검사를 실행한다. checks target은 인증/설정 연결 6개와 변경하지 않은 원본 진행 통화·녹취 저장 단위 테스트 12개를 실행한다. 비교 검증기는 독립 DB/이미지의 원본 PBX 7개 및 동일 워커/SQL/claim 복구 시나리오 6개를 양쪽에 실행하고 production HTTP·DB·OpenAPI·SSE를 비교한다. 로그는 `msa/liquibase/verification-logs/consultation/`에 남긴다.

Jenkins의 `Verify Consultation Parity` 실패 시 배포를 중단한다. DB 적용 후 operations를 먼저 배포한다. `dva/msa-consultation-auth` Secret의 `consultation-token`은 최초 한 번 생성하며 기존 값은 보존한다. customer 토큰과 별도 Secret이다. DB는 기존 `consultation-db` Secret의 PG* 필드를 사용한다. Ingress는 `/consultation`, `/api/calls`와 기존 PBX 경로를 라우팅하며 내부 세션 경로를 공개하지 않는다.

운영 PBX/S3 설정과 자격정보는 기존 값으로 `dva/consultation-runtime` Secret에서 주입한다. PBX 토큰·S3 버킷·허용 호스트·AWS 자격정보를 Git/명령 인자/로그에 넣지 않는다. Secret 자체는 선택 사항이며 토큰 미설정 시 PBX는 원본처럼 503을 반환한다. S3 미설정 시 통화 종료 매칭은 유지하고 파일 저장을 보류한다. 준비된 새 Pod부터 트래픽을 받고 실패 시 기존 리소스/이미지로 복구하지만 DB 변환은 앱 롤백으로 되돌리지 않는다.

실제 운영 Jenkins/공개 HTTPS·PBX/S3 자격정보를 사용한 외부 연동 및 전체 95개 API 동등성은 별도 검증 대상이다.
