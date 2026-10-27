# 주문 최종 접수 — ORD-06

관련 Jira: [S15P31D109-57](https://ssafy.atlassian.net/browse/S15P31D109-57).
API 명세의 **기존 주문 생성 → 수정 → 최종 접수** 흐름을 따른다. Jira의 새 주문 일괄 생성 설명은 적용하지 않는다.
디버 전송 형식은 팀 제공 「디버 택배 주문 접수 API 명세 v2」(2026-10-01), 결제 자격은 2026-10-27 사용자 확정 기준이다.

## 요청

```http
POST /api/orders/123/submit
Content-Type: application/json
Idempotency-Key: 00000000-0000-4000-8000-000000000057
call_session_seq: 7
```

```json
{ "expectedVersion": 4 }
```

- `123`은 기존 `orderSeq`. ORD-03에서 저장된 주소·물품·결제 방식·수거 시각을 고객에게 확인한 뒤 현재 `version`을 전달한다.
- 주문 본문이나 `confirmed`를 추가로 보내지 않는다. `expectedVersion`은 1~2147483647 정수다.
- AI는 기존 통화의 `call_session_seq`가 필수다. 진행 중 통화의 발신번호와 활성 고객 전화번호가 일치해야 한다. 다른 주문에 연결된 통화는 사용할 수 없다.
- 관리자는 ACTIVE OPERATOR/SUPERVISOR/SYSTEM_ADMIN 세션과 허용 Origin을 사용한다. 통화 헤더는 선택이며, 전달하면 같은 통화 조건을 검사한다.
- 관리자 쿠키가 있으면 정상 인증을 요구한다. 잘못된 쿠키를 AI 요청으로 전환하지 않는다. AI 서비스 인증은 기존 MVP 방침대로 아직 없다.
- 신규 접수는 `COLLECTING`만 가능하다. 종료된 통화는 기존 연결 주문의 같은 접수 키로 결과를 재확인할 수만 있다.

## 결제 규칙

| 코드 | 사용 대상 |
| --- | --- |
| `credit` | 정산. 개인·기업 모두 가능, 생성 시 기본값 |
| `groupBilling` | 그룹카드. ACTIVE 기업에 ACTIVE 소속이 있는 고객 |
| `billing` | 개인카드. 위의 활성 기업 소속이 없는 고객 |

생성·수정은 이 세 코드만 입력받고, **최종 접수 직전** 고객 자격을 다시 검사한다. 맞지 않으면 403이며 외부로 전송하지 않는다.
기존 DB의 `cat` 주문은 조회할 수 있지만 접수하려면 ORD-04로 지원하는 결제 방식으로 바꿔야 한다. 기존 행을 일괄 변환하지 않는다.
이 API는 결제 방식을 디버에 전달한다. 카드 등록·PG 승인·청구 기능은 포함하지 않는다.

## 처리 순서

1. 주문·통화·활성 고객 범위를 확인하고 접수 키를 조회한다. 같은 키에 다른 주문 또는 `expectedVersion`이면 422다.
2. 신규 요청은 주문을 잠그고 상태·버전·필수 주소·물품·미래 수거 시각·결제 자격·PIN 접근을 검사한다.
3. 같은 `orders` 행에 접수 키·확인 버전·시작 시각과 `SUBMITTING`을 저장한다. 통화 연결·시작 감사와 함께 커밋한다.
4. DB 트랜잭션을 종료한 후 디버에 한 번 POST한다. 대기 시간은 응답 본문까지 10초이며 리다이렉트·자동 재전송은 하지 않는다.
5. 접수 결과를 저장한다. 성공이면 주문 상태·참고번호·접수 시각·택배별 배송·초기 배송 이력·감사를 하나의 트랜잭션으로 확정한다.

택배 상세는 디버 `outboundParcels`로 변환한다. 수량은 `item.document/smallBox/mediumBox/bigBox`, 기타 설명은 `item.etc`다.
`notifiedPrice`는 **택배 상세별 3,500원**이며 `itemPrice`는 물품 가액이다. 고객/주문/PIN 번호는 디버에 보내지 않는다.

필수 검증은 상세 1개 이상, 출발·도착 이름/숫자 연락처/도로명·지번 주소/동명/5자리 우편번호/위경도,
수량 또는 기타 물품 설명, 물품 가액, 미래 수거 시각이다. 상세 주소는 선택이다. 부족하면 422의 `details`에 필드 경로를 반환하고 `COLLECTING`을 유지한다.

## 결과와 재시도

```json
{ "data": { "status": "ACCEPTED" }, "meta": { "requestId": "요청 추적 UUID" } }
```

| HTTP / status | 의미 |
| --- | --- |
| 200 / `ACCEPTED` | 디버 200 및 `ok=true`, 8자리 영숫자 `parcelNo`, 유효한 시간대 포함 `receivedAt` 확인·저장 |
| 200 / `AUTH_FAILED` | 디버 403. 서버 API 키 설정 확인 필요 |
| 200 / `REVIEW_REQUIRED` | 타임아웃·연결 끊김·기타 오류·비정상 응답 등으로 접수 결과 확인 필요 |
| 202 / `SUBMITTING` | 접수 처리 중 또는 결과 DB 저장 미확정. `Location: /api/orders/{id}` 반환 |

**HTTP 200만으로 접수 성공이라고 판단하지 않는다.** `ACCEPTED`만 성공이다.
ORD-03에서 디버 참고번호·접수 시각·배송을 조회한다. 배송은 택배 상세마다 하나씩 `notPaid`와 초기 이력을 생성한다.
배송 추적번호는 내부 고유 UUID 기반 번호이며 택배사 송장이 아니다. `parcelNo`는 중복 가능한 참고값이다.

- 접수 키는 주문 생성 키와 별개의 요청 식별자다. 같은 접수를 재확인할 때는 **같은 키·같은 expectedVersion**을 사용한다.
- 같은 키 재조회는 주문의 현재 버전·상태 검사보다 먼저 처리한다. 고객·통화 접근 검사는 유지하며, 결제/PIN 검사나 외부 전송을 반복하지 않는다.
- 요청 준비 중 같은 키는 409 `REQUEST_IN_PROGRESS`, 준비가 커밋되면 같은 키는 202 또는 저장된 결과를 반환한다.
- 다른 키로 `SUBMITTING`·`ACCEPTED`·`AUTH_FAILED`·`REVIEW_REQUIRED` 주문을 접수하면 409다.
- 프로세스 중단 등으로 `SUBMITTING`이 남으면 **시작 후 1분이 지난 같은 키 재조회**에서 `REVIEW_REQUIRED`로 전환한다. 주기적 감시 작업은 없다. ORD-03 조회만으로 이 전환을 실행하지 않는다.
- 결과 불명은 실패 확정이 아니다. 키를 지우거나 주문을 `COLLECTING`으로 되돌려 재전송하지 말고 디버 측 접수 여부를 먼저 확인한다. 외부 조회·취소·수동 결과 확정 API는 이번 범위가 아니다.

## 오류

| HTTP / code | 조건 |
| --- | --- |
| 400 `INVALID_REQUEST` | 경로·키·헤더·본문 형식 오류 또는 추가 필드 |
| 401 `UNAUTHORIZED` | 잘못되거나 만료된 관리자 세션 |
| 403 `FORBIDDEN` | 관리자 Origin, 고객·통화·PIN 접근 또는 결제 자격 오류 |
| 404 `NOT_FOUND` | 주문·고객·통화 없음 |
| 409 `VERSION_CONFLICT` | 고객이 확인한 주문 버전과 불일치 |
| 409 `INVALID_STATE` | 접수 불가 상태·통화 연결 충돌·종료된 통화의 신규 접수 |
| 409 `REQUEST_IN_PROGRESS` | 같은 키 준비 중 또는 결제 자격에 필요한 소속 변경 중 |
| 422 `IDEMPOTENCY_KEY_REUSED` | 같은 키에 다른 주문·확인 버전 |
| 422 `VALIDATION_FAILED` | 저장된 주문 필수값·규칙 오류 |
| 503 `DEPENDENCY_UNAVAILABLE` | 디버 API 키 미설정. 접수 의도를 저장하지 않음 |

## 배포 및 확인

- `011-order-submission.sql`을 적용한 뒤 새 백엔드를 실행한다. 기존 SQL 001~010은 변경하지 않는다. 테이블 추가 없이 `orders`에 nullable 컬럼 세 개와 제약을 추가한다.
- `DVER_API_URL` 기본값은 `https://public-n8n.dvercorp.co.kr:47514/webhook/parcel`이다. 운영·개발은 HTTPS를 요구한다.
- 서버 비밀 환경변수 `DVER_API_KEY`를 설정한다. 빈 값이면 기존 API는 실행되고 신규 디버 접수만 503이다. 로컬·운영 Compose에서 두 변수를 backend에 전달한다. 키는 저장소에 넣지 않는다.
- 키를 설정한 서버에서 `/submit`을 호출하면 실제 디버 주문 요청이 나간다. 자동 검증은 실제 키를 사용하지 않고 로컬 모의 서버로 실행한다.
- Swagger `/api/docs`의 `Orders` → `주문 최종 접수 (ORD-06)`에서 호출 규격·예시·상태·오류를 확인한다.
- `node scripts/check.cjs`: 빌드·린트·포맷, 실제 임시 DB, 모의 디버, 동시 요청·실패 롤백·재시작·기존 API·Nginx/PBX 회귀.
- `./infra/database/test-monolith.ps1`: 신규/기존 DB 전환, 기존 주문 보존, 제약, 반복 적용·체크섬·백업 복원·전체 롤백.

운영 DB 적용·Jenkins 배포·실제 디버 주문 전송·AI 컨테이너 호출부 연결은 아직 실행하지 않았다. AI 측은 같은 주문의 ORD-01 → ORD-04 → ORD-03 확인 → ORD-06 순서와 `call_session_seq` 헤더를 사용해야 한다.
