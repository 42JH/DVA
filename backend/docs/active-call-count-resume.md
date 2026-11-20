# 실시간 진행 통화 수 작업 재개 메모

## 2026-11-03 Jenkins 인증서 전달 오류 수정

- CI 실행은 컴파일·단위·결제·DB 통합 검증 후 HTTPS 테스트 실행 준비에서 실패했고, 배포 단계는 실행되지 않았다.
- 원인은 Jenkins agent의 임시 인증서를 별도 Docker daemon에 bind mount한 것이다. `/tmp/dva-backend-check-…/letsencrypt/live/dva-ip/fullchain.pem`은 agent에만 존재해 daemon에서 `bind source path does not exist`가 발생했다. 이전 Windows 로컬 검증은 이 파일시스템 분리 조건을 확인하지 못했다.
- 최신 `origin/develop-backend`를 기준으로 `fix/backend-ci-certificate`에서 수정한다. `backend/scripts/check.cjs`의 운영 이미지 테스트 컨테이너를 create → 인증서 docker cp → start --attach 순서로 실행하고, 성공·실패 후 finally에서 제거한다. `NODE_EXTRA_CA_CERTS`를 통한 TLS 검증과 기존 HTTPS/SSE 테스트를 유지한다.
- 일회용 Linux 클라이언트와 별도 Docker daemon의 파일시스템으로 같은 mount 오류를 재현했다. 인증서 파일 복사 후 내용 일치와 정상 종료, 실패 프로세스의 종료 코드 23 전달을 확인했다.
- 수정 후 같은 분리 환경에서 `node backend/scripts/check.cjs`가 종료 코드 0으로 완료됐다. 컴파일·ESLint·Prettier, 단위 117개·결제 21개·DB 통합 611개·두 nginx/HTTPS 20개, 총 **769개 통과**다. CI 선택 테스트 **5개 통과**로 합계 **774개**, 실패·취소·건너뜀 0개다. `infra/observability/test.mjs`와 `infra/payment-test/check.mjs`도 통과했다. 이는 로컬 Linux 재현 환경의 결과이며 원격 Jenkins 재실행·운영 배포 결과와 구분한다.

## 2026-11-03 인프라 설정까지 반영 — 당시 상태

- 사용자의 요청으로 백엔드 구현을 `2a5322b` (`feat: 실시간 진행 통화 수 조회 및 변경 알림 추가`)에 먼저 커밋했다.
- 이어서 사용자가 허용한 인프라 범위에서 `infra/nginx/default.prod.conf`와 `infra/https/https.conf`에 SSE 전용 location을 추가했다. 스트림 경로의 버퍼링·캐시 해제, 연결 헤더, 30초 수신 대기시간을 적용한다. 이 변경과 관련 문서·검증 도구를 후속 커밋으로 분리한다.
- 기존 검증 도구가 임시 인증서와 실제 두 nginx 설정을 사용하도록 보완했다. 운영용 backend·DB를 연결해 HTTPS에서 최초값·진행 건수 변경·heartbeat·로그아웃 종료와 기존 인증·내부 차단·PBX POST 제한을 검증했다. 테스트 인증서·키·컨테이너는 검증 후 정리했다.
- 최신 `node backend/scripts/check.cjs`는 **769개 통과**, `node --test infra/jenkins/test-monolith-ci.cjs`는 **5개 통과**했다. 합계 **774개**, 실패·취소·건너뜀 0개다. 백엔드 첫 커밋 당시 768개 결과와 구분한다.
- API별 호출자·역할·데이터 이동·AI 두 단계 입력·프론트 SSE 예시와 배포·호스트 nginx 적용 순서는 [연동 문서](active-call-count.md)에 정리했다. 현재값 GET은 단발 조회용이며 SSE 자체도 최초 현재값을 보낸다.
- 컨테이너 nginx는 기존 앱 배포에 포함된다. 호스트 HTTPS nginx는 앱 배포가 자동 갱신하지 않으므로 실제 서버의 도메인·인증서·추가 경로와 비교해 SSE 설정을 반영하고 검사·reload해야 한다.

아래 재개 결과는 백엔드 구현 검증 직후의 시점 기록이다.

## 2026-11-03 백엔드 구현 기록

사용자의 “이어서 작업 하자” 요청으로 재개했다. 아래 2026-11-02 원문은 중단 당시의 기록이며 현재 구현 상태와 구분한다.

- 작업 폴더·브랜치·원격을 다시 확인했다. `feature/active-call-count`, 기준 `4638593`이며 fetch한 origin/develop-backend와 같은 커밋이다. 기존에 있던 이 메모를 보존했다.
- `GET /api/calls/active-count`와 관리자 쿠키 인증의 `GET /api/calls/active-count/stream`을 구현했다. 최초 현재값, 변경 알림, 5초 heartbeat·인증 재검증, 오류·로그아웃·앱 종료 시 연결 정리를 포함한다.
- 새 044 migration은 call_sessions.registered_at과 부분 인덱스 두 개를 추가한다. 기존 통화의 등록 시각은 NULL이며 집계에서 제외한다. 기존 시각·주문·주소·분석·녹취는 보존한다.
- 등록·PBX 수신·워커의 매칭 잠금 규칙을 맞추고 PBX 수신 즉시 종료, 웹훅 선도착 시 등록 트랜잭션 내 매칭을 구현했다. 녹취 업로드 대기, 처리권·재시도·30분 정리·NO_ORDER 계약을 유지한다.
- 최종 구현은 DB 트리거 대신 공통 통화 저장 경로가 같은 트랜잭션에서 pg_notify를 호출한다. 커밋된 변경만 알리고 기존 배포 스키마 검사의 업무 트리거 10개 조건도 유지한다. LISTEN은 서버마다 하나, COUNT 결과는 구독자들이 공유한다. 100건 초과 또는 변경 집중 시 약 1초로 묶고, 알림이 없어도 5초마다 재조회한다.
- 전체 `node backend/scripts/check.cjs`가 종료 코드 0으로 완료됐다. ESLint·Prettier·TypeScript 빌드와 단위 117개·결제 21개·DB 통합 611개·운영 이미지/nginx 19개, 총 **768개 통과**, 실패·취소·건너뜀 0개다. 새 기능은 22개이며 과거 3만 건의 부분 인덱스 사용도 확인했다.
- 서버 종료 시 열린 SSE가 늦게 닫히던 문제는 회귀 테스트로 재현한 뒤 수정했고, 최종 전체 검증에 해당 테스트를 포함했다. 새 DB 트리거와 기존 배포 검사 충돌은 위 트랜잭션 알림 방식으로 해결했다.
- API·프론트 연결 예시·AI 등록 계약·전환·운영 nginx 설정안과 검증 범위는 [실시간 통화 수 계약](active-call-count.md)에 정리했다. 수정 파일은 모두 backend 내부이며 새 의존성은 없다.
- 커밋·푸시·새 MR 생성·운영 DB 적용·배포·nginx 변경·AI/프론트 코드 수정은 하지 않았다. 다음 단계에서 검토한 변경을 커밋할 수 있으며, 새 MR 생성은 사용자의 명시적 요청이 필요하다.
- 외부 HTTPS nginx의 스트림 버퍼링 해제와 실제 도메인 검증은 남아 있다. 종료 웹훅이 없거나 매칭이 모호한 통화는 집계에 남을 수 있으며 30분 뒤 임의 종료하지 않는다.

<details>
<summary>2026-11-02 중단 당시 원문 기록</summary>

2026-11-02 사용자의 요청으로 작업을 중단했다. 사용자가 재개를 요청하기 전에는 구현을 진행하지 않는다. 알림이나 자동 재개 일정은 등록하지 않았다.

## 현재 상태

- 작업 브랜치: `feature/active-call-count`. 이전 작업과 분리한 새 worktree이며 upstream은 지정하지 않았다.
- 아직 기능 소스·마이그레이션·테스트 코드는 수정하지 않았다. 이번 중단 정리에서 이 메모만 추가했다. 새 작업의 커밋·푸시·MR·운영 배포는 하지 않았다.
- 중단 시점에는 새 기능에 대한 테스트를 실행하지 않았다.

## 사용자와 확정한 기준

- 백엔드 작업이다. 기존에 허용한 수정 범위는 backend 내부이며 프론트·AI·인프라 파일은 수정하지 않는다.
- AI가 업무 의도를 확인하고 call_sessions를 생성한 유효 통화가 집계 대상이다. 단순 고객 확인 조회만 한 통화는 포함하지 않는다.
- 통화 등록 시 증가하고, 해당 통화의 PBX 종료 웹훅을 반영하면 감소한다. 중복 등록·재전송으로 건수가 다시 증가하거나 감소하면 안 된다.
- 사용자는 초기 집계에 대해 **기존 종료 시각 미확인 통화는 제외하고, 기능 도입 후 등록되는 통화부터 집계**한다고 답했다. 과거 통화를 임의로 종료하거나 삭제하지 않는다.
- 주문이 없는 유효 상담과 NO_ORDER는 유지한다. 무의미 통화는 AI가 등록·업무 결과 전송을 생략하는 기존 계약을 따른다.
- 통화별 상태는 매번 저장하고, 화면 전송은 낮은 부하에서 빠르게, 부하가 크면 최신값으로 묶는 방향이다.
- 미연결 PBX 수신의 30분 보관 정책은 통화의 최대 지속 시간이 아니다. 통화를 30분 후 자동 종료하는 로직을 추가하지 않는다.
- 프론트에는 증감 명령보다 현재 건수의 절대값을 보낸다. 기존에 제안한 인터페이스는 아래와 같으며 아직 구현하지 않았다.
  - `GET /api/calls/active-count`: 현재 건수 조회. 기존 data/meta 응답 형식.
  - `GET /api/calls/active-count/stream`: SSE 최초 현재값과 이후 변경값.
  - 데이터 예시: `{ "activeCallCount": 37, "observedAt": "2026-11-02T03:00:00.000Z" }`.

## 확인한 코드와 영향 범위

- `src/consultations/call-session.repository.ts`: ensureCall은 provider_call_id의 UNIQUE와 ON CONFLICT로 통화를 재사용한다. matchRecording은 발신번호·최초 수신 시각으로 후보를 찾고, 후보가 하나일 때 started_at·ended_at을 저장한다. 두 후보 이상이면 추정하지 않는다.
- call_sessions에는 현재 등록 시각 컬럼이 없다. incoming_at은 AI가 보관한 최초 수신 시각이며 DB 등록 시각으로 대체하면 안 된다. 기존 행의 ended_at IS NULL만 세면 과거 미확인 통화도 포함된다.
- `src/consultations/consultations.service.ts`: 고객 확인과 최종 주문 결과의 공통 ensureCall 경로이다. 생성 시 CALL_STARTED 감사를 한 번 기록한다.
- `src/customers/customers.service.ts`, `src/orders/orders.service.ts`: 통화 등록 호출자이다. 최종 AI 결과는 PBX 종료 후에도 도착할 수 있어 기존 정상 결과 저장 경로를 보존해야 한다.
- `src/webhooks/pbx/pbx-webhook.service.ts`: 현재는 수신함 INSERT·동일 재전송 확인 후 ACK한다. 즉시 종료 반영은 없다.
- `src/webhooks/pbx/pbx-recording.worker.ts`와 repository: 수신 후 최소 1분 대기, 10초 주기로 최대 5건 처리한다. 이때 통화 매칭·종료 저장을 수행한 뒤 S3 업로드한다. 종료 반영을 녹취 대기·저장 성공과 분리해야 한다.
- 현재 녹취 매칭의 DB 잠금 순서는 수신함 행 → 통화 행이다. 통화 등록 후 대기 웹훅을 재매칭할 때 반대 순서가 생기면 교착 가능성이 있으므로 세 경로 모두 같은 잠금 규칙을 사용해야 한다.
- `src/common/caller-phone.ts`: 한국 국제 표기 `+82` 또는 `0082`만 국내 0으로 통일한다. 다른 번호는 임의로 변환하지 않는다.
- `src/common/http/response-envelope.interceptor.ts`: 모든 /api 응답을 data/meta로 감싼다. 표준 Nest SSE 메시지를 감싸지 않도록 SSE 메타데이터 기반 예외와 기존 JSON 응답 회귀 검증이 필요하다.
- `src/auth/auth.guard.ts`와 `auth.service.ts`: 기존 관리자 쿠키 인증과 ACTIVE·역할 검증을 재사용한다. 장시간 SSE의 세션 만료·로그아웃·계정 비활성화도 처리해야 한다. AuthModule은 AuthService를 export한다.
- `src/database/database.service.ts`: pg Pool 최대 5개. LISTEN은 브라우저마다 pool 연결을 점유하지 않도록 백엔드 인스턴스당 별도 연결을 검토한다. 앱 시작 자동 SQL은 기존 001 PBX 수신함만 유지한다.
- 기존 설치된 Nest의 SSE 처리는 Promise로 반환된 Observable도 지원한다. 실제 코드·테스트로 오류 시점, 최초 연결과 연결 해제 처리를 다시 검증한다.
- 기존 pg·rxjs·Nest 의존성으로 구현 가능하며 새 의존성은 추가하지 않았다.

## 검토 중인 구현안 — 아직 적용하지 않음

1. 다음 신규 migration은 044 후보이다. call_sessions에 nullable 등록 시각을 추가한 뒤 신규 INSERT에만 기본 시각을 설정하면 기존 행의 NULL을 보존하면서 새 등록을 구분할 수 있다. 컬럼명·구현은 최종 확정 전이다.
2. 새 등록 시각이 존재하고 ended_at이 없는 통화에 부분 인덱스를 두고 현재 건수를 조회한다. 별도의 증감 숫자만 영구 저장하는 방식은 피한다.
3. DB 트리거는 변경 사실만 pg_notify로 알리고, SSE 제공자는 LISTEN 후 현재값을 읽는다. 재연결·알림 누락 보완을 위한 재조회가 필요하다. NOTIFY 자체를 영구 이벤트 저장소로 취급하지 않는다.
4. 전송 주기 초안은 100건 이하·변경이 드물 때 100~200ms 묶기, 100건 초과 또는 변경 집중 시 약 1초 묶기다. 변경이 계속돼도 일정 주기에는 반드시 최신값을 보낸다. 초기안이며 부하 검증 전 성능 보장은 없다.
5. PBX 수신 즉시 유일한 통화를 찾아 종료하고, 통화 등록이 나중이라면 대기 수신과 재매칭한다. 한 트랜잭션에서 이미 종료된 통화가 임시 활성값으로 공개되지 않도록 한다.
6. 매칭 공통화와 발신번호 단위 트랜잭션 advisory lock은 잠금 순서를 맞추기 위한 검토안이다. 워커·수신·등록 경로 중 일부에만 적용하면 잠금 순서 문제를 만들 수 있다.
7. 수신함 payload에서 역방향 매칭할 때는 기존 전화번호 정규화, 시각 허용 범위, 유일 후보 확인, 잘못된 과거 payload, 처리권·재시도 보존과 조회 인덱스를 함께 검토한다.
8. 초기 DB 장애는 공통 오류 응답으로 처리하고, 열린 스트림의 장애는 민감정보 없는 오류 이벤트와 연결 종료로 처리한다. 장애를 건수 0으로 보내지 않는다. 연결 종료 시 타이머·구독·연결을 정리한다.

## 운영 프록시 확인 사항

- 현재 `infra/nginx/default.prod.conf`의 /api 프록시와 `infra/https/https.conf`의 외부 /api 프록시가 두 단계로 존재한다. 아직 수정하지 않았다.
- 외부 /api의 proxy_read_timeout은 10초이며 SSE 전용 버퍼링 해제 설정이 없다. 백엔드 heartbeat와 각 프록시의 버퍼링·타임아웃 검증이 필요하다.
- 백엔드의 X-Accel-Buffering 헤더가 첫 nginx에서 소비되면 외부 nginx에는 전달되지 않을 수 있으므로 헤더 하나만으로 운영 전달을 검증했다고 단정하지 않는다.
- backend 밖 수정은 현재 허용 범위가 아니다. 우선 backend 문서에 적용 가능한 프록시 설정안을 준비하고, 외부 파일 변경이 필요하면 구체적인 범위로 별도 승인을 받는다. 운영 nginx 재시작·재로드는 하지 않았다.

## 재개 후 순서

1. 사용자 재개 요청을 확인하고 AGENTS·현재 지침과 이 문서를 읽는다. 작업 폴더·브랜치·원격·미커밋 변경을 확인한다. 이 메모를 기존 변경으로 보존한다.
2. origin/develop-backend의 새 변경과 충돌 여부를 확인한다. 보호 브랜치에서 직접 수정하거나 기존 작업을 폐기하지 않는다.
3. API 계약·초기 집계 제외 기준을 backend 문서에 정리하고, 위 구현안을 검토한 뒤 최소 범위로 구현한다.
4. 등록·즉시 종료·재전송·동시 처리·도착 순서 역전·과거 미확인 제외·S3 비활성·기존 NO_ORDER·녹취·인증 경로를 검증한다.
5. SSE 초기값·재연결·다중 인스턴스·부하별 묶기·세션 만료·연결 정리·DB 장애·프록시 통과를 실제 일회용 환경에서 검증하고 전체 회귀를 수행한다.
6. 새 기능의 검증 결과와 운영 미적용 사항을 구분해 보고한다. 새 작업 MR 생성이나 운영 배포는 아직 요청받지 않았다.

개발 DB는 일회용 PostgreSQL 17을 사용한다. backend/test/helpers/migrations.cjs는 새 migration 적용 여부 확인을 추가해야 한다. 기존 테스트를 임의로 완화하거나 운영 DB를 테스트 대상으로 사용하지 않는다.

</details>
