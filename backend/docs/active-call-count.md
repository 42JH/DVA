# 진행 통화 수 조회와 SSE 연동

Jira: [S15P31D109-155](https://ssafy.atlassian.net/browse/S15P31D109-155). 백엔드 API와 양쪽 nginx 설정을 포함한다. AI·프론트 코드 수정과 실제 서버 배포·nginx reload는 별도다.

## 집계 기준과 DB 전환

기능 도입 후 DB에 새로 등록되어 PBX·AI 분석 어느 쪽에도 종료 시각이 없는 통화를 센다. 목록의 `COALESCE(c.ended_at,a.ai_ended_at)`과 같은 종료 판정을 사용한다. 주문 생성 여부·결제·분석 상태 이름만으로 통화를 종료하지 않으며 실제 저장된 종료 시각을 확인한다. 최초 전화번호 조회만 한 통화와 등록하지 않은 무의미 통화는 포함하지 않는다.

새 앱 전에 `044-active-call-count.sql`을 적용한다. call_sessions에 nullable `registered_at`을 추가한 다음 신규 INSERT의 기본값만 DB 시각으로 설정한다. 기존 행은 NULL 그대로 유지해 과거 종료 미확인 통화를 집계에서 제외한다. 같은 providerCallId의 재전송은 새 등록으로 바꾸지 않는다. incoming_at은 최초 수신 시각을 유지한다. 과거 통화·주소·주문·녹취를 삭제하거나 시각을 보정하지 않는다.

집계 조건은 기존 `registered_at IS NOT NULL AND ended_at IS NULL`·삭제/보관 기준에 `ai_ended_at IS NOT NULL`인 분석이 없다는 조건을 추가한다. 진행 통화의 부분 인덱스와 분석의 통화 PK를 사용하며 별도의 누적 숫자를 저장하지 않는다. 통화 생성·PBX 종료·신규 AI 분석 저장의 공통 경로가 같은 트랜잭션에서 `pg_notify`를 호출하므로 커밋 후에만 변경 힌트가 전달된다. 분석 재전송에는 새 알림을 만들지 않는다. 새 migration·트리거는 없으며 PBX의 원본 시작/종료 시각도 변경하지 않는다.

PBX 수신 시 같은 발신번호·시작 시각에 정확히 일치하는 통화가 있으면 그 후보만 검토한다. 정확 일치가 없을 때만 기존 허용 범위 내 유일 후보를 사용하며, 정확 일치가 여러 건이거나 범위 후보만 여러 건이면 계속 거절한다. 웹훅이 먼저 도착했다면 통화 등록 트랜잭션에서 대기 수신을 매칭한다. 먼저 종료된 통화가 등록되더라도 커밋 후 값은 0건 증가다. 등록·수신·워커는 동일 발신번호의 매칭 잠금 규칙을 공유하며 이미 저장된 PBX 시각과 충돌하는 재전송은 덮어쓰지 않는다.

수신함 저장 실패는 기존 503, 같은 recordingId의 다른 본문은 409다. 수신함을 영속화한 뒤 즉시 매칭만 실패하면 200 ACK 후 기존 녹취 워커가 복구한다. S3 업로드 성공 여부는 종료 저장 조건이 아니다. 연결된 유효 수신·S3 재시도·처리권과 NO_ORDER를 보존한다. 최종 AI 주문 결과는 PBX 종료 뒤에도 기존 계약으로 저장한다.

PBX 종료와 AI 분석 종료가 모두 누락되면 실제 통화가 끝났어도 집계에 남을 수 있다. 미연결 PBX 수신 30분 보관을 통화 자동 종료 시간으로 사용하지 않는다. AI는 [유효 통화 등록 계약](meaningful-call-registration-handoff.md)대로 업무 의도 확인 후 최초 providerCallId·incomingAt으로 등록한다.

## 호출자별 역할과 데이터 이동

| 호출자 | API | 역할과 건수 영향 |
| --- | --- | --- |
| AI, 최초 고객 확인 | `POST /api/customers/context` | phoneNumber만 전송해 고객·주소 정보를 조회한다. 통화를 생성하지 않아 건수가 늘지 않는다. |
| AI, 업무 의도 확인 후 | `POST /api/customers/context` | 최초 call 정보를 추가한다. 통화를 생성·재사용하고 callSessionSeq를 받는다. 신규 진행 통화가 집계에 들어간다. |
| PBX | `POST /api/webhooks/pbx/call-ended` | 종료 시각을 저장해 집계에서 제외한다. 동일 웹훅 재전송은 중복 차감하지 않는다. |
| AI 분석 | `POST /api/ai/calls/{id}/analysis` | 종료 분석을 저장하면 PBX 미수신 통화도 집계에서 제외한다. PBX 원본 시각은 덮어쓰지 않으며 같은 분석 재전송은 중복 차감하지 않는다. |
| 프론트 | `GET /api/calls/active-count` | 현재 건수를 JSON으로 한 번 조회한다. 통화 상태를 변경하지 않는다. |
| 프론트 | `GET /api/calls/active-count/stream` | 최초 현재값과 이후 변경값을 하나의 연결에서 계속 받는다. 통화 상태를 변경하지 않는다. |

PBX 공개 URL은 기존 nginx가 백엔드의 `/webhooks/pbx/call-ended`로 전달한다. PBX Bearer 토큰과 관리자 세션 쿠키는 각각 기존 인증을 사용하며 서로 대체하지 않는다.

AI 최초 조회 예시:

```json
{ "phoneNumber": "01012345678" }
```

AI 업무 의도 확인 후 등록 예시. providerCallId와 incomingAt은 새로 만들지 않고 최초 전화 수신 이벤트 값을 사용한다.

```json
{
  "phoneNumber": "01012345678",
  "call": {
    "providerCallId": "original-provider-call-id",
    "incomingAt": "2026-11-03T00:00:00.000Z"
  }
}
```

저장 흐름은 AI 등록 → call_sessions 저장 → DB 트랜잭션 커밋 → PostgreSQL NOTIFY → 각 백엔드의 LISTEN → 진행 통화 COUNT → SSE → 프론트 숫자 갱신이다. 종료 시에는 PBX 수신 → ended_at 저장 이후 같은 알림 흐름을 사용한다. NOTIFY는 외부 API가 아니며 AI·프론트가 따로 호출하지 않는다.

별도 숫자 컬럼에 +1/-1을 누적 저장하지 않는다. 통화별 registered_at과 ended_at을 저장하고 조건에 맞는 행을 부분 인덱스로 센다. 예를 들어 DB에 7건이 남으면 프론트에 7을 전송한다. 화면마다 1을 더하는 방식이 아니므로 여러 관리자가 동시에 구독해도 건수가 증가하지 않는다. 롤백된 등록은 알림도 취소된다. 등록 전에 종료 웹훅이 도착한 경우에는 같은 등록 트랜잭션에서 종료까지 반영해 진행 건수가 잠시 늘어나는 것을 방지한다.

## 현재 건수 API

`GET /api/calls/active-count`. 입력·기간 필터 없음. ACTIVE 관리자 OPERATOR·SUPERVISOR·SYSTEM_ADMIN의 기존 dva_session 쿠키를 사용한다.

```json
{
  "data": {
    "activeCallCount": 37,
    "observedAt": "2026-11-03T00:00:00.000Z"
  },
  "meta": { "requestId": "c9d2d085-95cf-41c4-90df-d488c3c25b00" }
}
```

activeCallCount는 0 이상의 정수, observedAt은 해당 DB 조회를 관측한 시각이다. 누적 통화 수나 관리자 화면 접속자 수가 아니다. 401·403은 기존 인증·Origin 계약을 따른다. DB에서 건수를 확인하지 못하면 503 DEPENDENCY_UNAVAILABLE이며 0으로 대신하지 않는다.

## SSE API

`GET /api/calls/active-count/stream`. 일반 JSON 응답 포장과 구분된 `text/event-stream`이며 동일한 관리자 쿠키·권한을 사용한다. 클라이언트가 집계용 POST를 호출할 필요는 없다.

```text
event: active-call-count
data: {"activeCallCount":37,"observedAt":"2026-11-03T00:00:00.000Z"}

```

- 최초 연결·재연결: LISTEN 등록 후 현재 DB 값을 조회해 전달한다. 이벤트 ID를 과거 이벤트 재생 커서로 사용하지 않는다.
- 일반 부하: 약 100~200ms 주기로 변경을 모아 전송한다. 진행 통화가 100건 초과이거나 조회 사이 변경 힌트가 10건 이상 쌓이면 약 1초 간격으로 최신값을 전송한다. DB·네트워크 처리 시간은 추가될 수 있다.
- 같은 건수는 재전송하지 않는다. 예를 들어 시작 20건·종료 15건이 묶이면 최종 5건 증가값을 한 번 보낼 수 있다. 각 통화 상태는 개별 트랜잭션으로 반영한다.
- 백엔드 인스턴스마다 결과를 공유한다. 화면별로 변경 이벤트마다 COUNT 쿼리를 실행하지 않는다. 첫 구독 후 LISTEN 전용 연결 하나를 유지하며 조회 pool을 화면마다 점유하지 않는다.
- 5초마다 DB 현재값을 다시 확인해 알림 누락과 앱 경로 밖의 직접 DB 변경을 보완한다. LISTEN 연결도 복구한다. 구독자가 없으면 이 주기 조회를 실행하지 않는다.
- 5초 heartbeat 때 기존 인증을 재검증한다. 세션 만료·로그아웃·계정 비활성화 반영에는 최대 약 5초와 DB 처리 시간이 걸릴 수 있다.
- `heartbeat`: `data`는 마지막 DB 관측 시각이다. UI의 통화 수를 증감시키지 않는다.
- `session-expired`: `{"code":"UNAUTHORIZED"}` 전송 후 종료한다. 클라이언트가 연결을 닫고 기존 로그인 처리를 수행한다.
- `stream-error`: `{"code":"DEPENDENCY_UNAVAILABLE"}` 전송 후 종료한다. 연결 상태를 오류로 표시하고 재연결 시 현재값을 받는다. 기존 숫자를 0으로 바꾸지 않는다.
- 최초 준비 실패는 헤더 전 공통 JSON 503, 구독 중 실패는 위 이벤트다. 연결 종료·앱 종료 시 구독·타이머·DB 연결을 정리한다.

프론트 연결 예시:

SSE는 최초 현재값도 보내므로 화면 진입 시 stream 하나만 연결해도 된다. 현재값 GET은 단발 조회나 연결 상태 확인용으로 사용할 수 있다. EventSource는 GET 연결을 유지하며 브라우저가 재연결을 처리한다. 이벤트가 올 때마다 API를 다시 호출하거나 페이지를 새로고침할 필요는 없다.

```javascript
const source = new EventSource('/api/calls/active-count/stream', { withCredentials: true });
source.addEventListener('active-call-count', (event) => {
  const { activeCallCount, observedAt } = JSON.parse(event.data);
  // 숫자와 관측 시각만 화면 상태에 반영한다.
  updateActiveCallCount(activeCallCount, observedAt);
});
source.addEventListener('session-expired', () => {
  source.close();
  handleSessionExpired();
});
source.addEventListener('stream-error', () => setConnectionStatus('reconnecting'));
source.onerror = () => setConnectionStatus('reconnecting');
// 화면을 떠날 때 source.close(). 다른 Origin이면 허용된 API URL을 사용한다.
```

## nginx 설정 — 저장소 반영, 실제 서버 미반영

프론트 → 외부 HTTPS nginx → 컨테이너 nginx → backend 순서로 연결된다. 백엔드의 X-Accel-Buffering: no가 첫 프록시에서 소비될 수 있어 두 설정 모두 `/api/calls/active-count/stream` 전용 location에 버퍼링·캐시 해제를 명시한다.

- [컨테이너 nginx 설정](../../infra/nginx/default.prod.conf): backend:3000으로 전달한다.
- [외부 HTTPS nginx 설정](../../infra/https/https.conf): 기존 127.0.0.1:8082로 전달한다.
- 양쪽 모두 `proxy_buffering off`, `proxy_cache off`, `Connection ''`, `proxy_read_timeout 30s`를 사용한다. 30초는 수신 데이터 사이의 대기시간이며 통화나 SSE의 총 유지시간 제한이 아니다. 5초 heartbeat로 연결을 유지한다.
- 변경은 해당 스트림 경로에 한정한다. 기존 PBX 웹훅·AI 미러·인증·CORS·나머지 API 경로는 유지한다.

사용자가 요청한 순서에 따라 백엔드 기능을 먼저 커밋하고 nginx 설정·검증을 후속 커밋으로 분리한다. 두 커밋을 같은 Jira 155의 MR로 올릴 수 있다. 실제 서버 적용 순서는 다음과 같다.

1. develop-backend 대상 MR의 리뷰·병합 후 기존 배포 파이프라인을 사용한다. 새 backend 시작 전에 migration runner가 044를 적용하는지 확인한다. 컨테이너 nginx 설정은 기존 배포 패키지·Compose에 포함된다.
2. 호스트 HTTPS nginx 설정은 앱 배포로 자동 교체되지 않는다. 현재 서버 설정과 저장소 설정을 비교해 기존 도메인·인증서·추가 경로를 보존하면서 SSE location을 반영한다. `nginx -t` 성공 후 `systemctl reload nginx`로 반영한다. 호스트 반영은 [HTTPS 운영 절차](../../infra/https/README.md)를 따른다.
3. 실제 도메인에서 로그인 후 첫 SSE 이벤트, heartbeat와 10초 이상 연결 유지, 통화 등록·종료, 로그아웃 종료·재연결을 확인한다. AI의 기존 두 단계 등록이 실제 호출되는지도 확인한다.

이번 변경에서 실제 서버 접속·DB migration·배포·nginx reload·프론트/AI 코드 수정은 실행하지 않는다. 저장소 설정 반영과 실제 운영 반영을 구분한다.

## 검증 결과 — 2026-11-03

저장소 루트에서 `node backend/scripts/check.cjs`와 `node --test infra/jenkins/test-monolith-ci.cjs`를 실행했다. 일회용 PostgreSQL 17·운영용 backend 이미지·두 nginx의 실제 저장소 설정·임시 HTTPS 인증서로 확인했다.

| 검증 | 결과 |
| --- | --- |
| ESLint·Prettier·TypeScript 빌드 | 통과 |
| 단위 테스트 | 117개 통과 |
| 결제 테스트 | 21개 통과 |
| 실제 DB 통합 테스트 | 611개 통과, 새 기능 22개 포함 |
| 운영 이미지·두 nginx·HTTPS 통합 테스트 | 20개 통과 |
| 인프라 CI 변경 감지·검증 선택 테스트 | 5개 통과 |
| 합계 | 774개 통과, 실패·취소·건너뜀 0개 |

새 기능 검증은 과거 데이터 제외, 동일 등록·웹훅 재전송, 두 서버의 동시 처리, 웹훅 선도착, S3 미설정, PBX 종료 후 NO_ORDER, 역할·세션 검증, SSE 최초값·재연결·공유 조회·묶음 전송·알림 누락 복구·장애·서버 종료를 포함한다. 과거 3만 건과 진행 125건의 테스트 데이터에서 집계가 부분 인덱스를 사용하는 실행 계획도 확인했다. 운영 부하의 처리량·지연을 보장하는 벤치마크는 아니다.

실제 두 nginx 설정을 일회용 컨테이너에서 연결해 HTTPS 인증서 신뢰 검증, heartbeat 두 번과 등록·종료 알림, 로그아웃 종료를 확인했다. 외부 프록시를 통한 미인증 차단·내부 경로 차단·PBX POST 제한도 확인했다. 실제 서버·운영 도메인·운영 DB migration·프론트와 AI 서버 연동은 실행하지 않았다. 운영 반영은 위 절을 따른다.
