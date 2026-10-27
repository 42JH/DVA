# AI 주문 검증 및 미완료 상담 기록 API

관련 작업: [S15P31D109-55](https://ssafy.atlassian.net/browse/S15P31D109-55).

55번 Jira 본문을 기준으로 한다. AI는 상담 중 정보를 자체 문맥에 수집하고, 정상 접수 때 완성된 주문을 한 번에 전달한다. 접수 전에 통화가 끝나면 마지막 스냅샷을 **주문과 별개의 미완료 상담 기록**으로 전달한다. 상담 중 단계별 주문 저장, COLLECTING 주문 생성 및 재통화 시 자동 복원은 제공하지 않는다.

## 작업 경계

| 작업 | 책임 |
| --- | --- |
| 55번(이번 MR) | 주문 정보 검증, 종료 스냅샷 저장, 관리자 목록·상세 조회 |
| [57번](https://ssafy.atlassian.net/browse/S15P31D109-57) | 고객 최종 확인 후 신규 주문 저장·고객 연결·디버 접수·중복 접수 방지 |
| [69번](https://ssafy.atlassian.net/browse/S15P31D109-69) | 관리자 수기 주문 접수. 57번과 공통 접수 서비스 사용 |
| [88번](https://ssafy.atlassian.net/browse/S15P31D109-88) | 기존 통화·발화·녹취의 상세 조회 및 재생 접근 |
| [90번](https://ssafy.atlassian.net/browse/S15P31D109-90) | 미완료 상담 검수 상태·담당자·메모 관리 |
| [135번](https://ssafy.atlassian.net/browse/S15P31D109-135) | MVP 이후 AI→BE 서비스 인증 |

고객 등록 기능은 34번과 공통 접수 흐름에서 연결한다. **주문 정보 검증에는 기존 고객 ID가 필요하지 않으며, 검증 성공만으로 고객을 등록하지 않는다.**

## 경로와 호출 주체

모놀리식 경로는 기존 합의대로 /api이며 v1을 붙이지 않는다.

| 메서드·경로 | 호출 주체 | 결과 |
| --- | --- | --- |
| POST /api/orders/validation | AI | 저장 없는 주문 정보 일괄 검증 |
| POST /api/consultations/incomplete | AI | 접수 전 종료 스냅샷 저장 |
| GET /api/consultations/incomplete | 관리자 | 기간·통화별 목록 |
| GET /api/consultations/incomplete/{id} | 관리자 | 스냅샷·수집 현황·기존 이력 존재 정보 |

- 135번의 MVP 결정에 따라 **위 AI POST 두 메서드는 서비스 토큰·관리자 세션·Origin을 요구하지 않는다**. 요청 발신 서버나 통화 상대의 신원을 검증한다는 의미가 아니다. 일반 관리자 API 및 기존 PBX 인증은 유지한다.
- 관리자 GET 두 메서드는 ACTIVE OPERATOR/SUPERVISOR/SYSTEM_ADMIN의 dva_session 쿠키가 필요하다. AI 수신 예외를 조회에 적용하지 않는다.
- 현재 AI 브랜치의 /internal/ai 경로·snake_case 본문은 제안 문서에 기반한 별도 형식이다. 이번 모놀리식 계약과 자동 호환되지 않는다. 실제 AI 호출부에서 아래 경로·camelCase·응답 envelope를 맞춰야 한다.
- 단건 응답은 data/meta, 목록은 data/hasNext, 오류는 error/meta 공통 계약을 사용한다. Swagger는 /api/docs, OpenAPI는 /api/docs-json이다.

## 1. POST /api/orders/validation

저장 없이 형식·필수 정보·업무 입력을 검증한다. 성공해도 orders, order_parcels, customers, shipments에 행을 만들지 않는다. Idempotency-Key는 필요 없다.

57번의 실제 접수 API는 이 검증을 **서버 내부에서 재사용**해야 한다. AI가 검증 API와 접수 API를 반드시 두 번 호출하도록 요구하는 구조가 아니며, 사전 검증 성공은 이후 접수의 보증·인증 수단이 아니다.

요청 예시(수거 시각은 실제 미래 시각으로 교체):

```json
{
  "paymentMethodType": "credit",
  "pickupRequestedAt": "2026-10-28T10:00:00+09:00",
  "parcels": [{
    "origin": {
      "name": "발송인", "phoneNumber": "01000000001",
      "roadAddress": "예시로 1", "jibunAddress": "예시동 1",
      "detailAddress": "", "dongName": "예시동", "postalCode": "00001",
      "latitude": 37.5, "longitude": 127
    },
    "destination": {
      "name": "수령인", "phoneNumber": "01000000002",
      "roadAddress": "예시로 2", "jibunAddress": "예시동 2",
      "dongName": "예시동", "postalCode": "00002",
      "latitude": 37.6, "longitude": 127.1
    },
    "smallBoxCount": 1,
    "itemPrice": 0,
    "notifiedPrice": 3500,
    "clientComment": ""
  }]
}
```

성공: 200, data는 {"valid": true}이다. 접수번호를 발급하지 않는다.

검증 규칙:

- 결제 방식은 cat/billing/credit/groupBilling 중 명시적으로 전달한다. 미수집 시 credit 같은 값을 임의로 채우지 않는다. 실제 결제 자격·외부 결제 처리는 이번 범위가 아니다.
- pickupRequestedAt은 타임존을 포함하며 실제 날짜로 해석 가능한 ISO 8601 문자열이고 현재보다 미래여야 한다.
- parcels는 최소 1개다. 각 출발지·도착지의 이름·전화번호·도로명주소·지번주소·동명·우편번호·위도·경도를 확인한다. 상세 주소는 선택이다.
- 전화번호는 선행 0이 유지되는 숫자 문자열, 우편번호는 5자리 숫자, 위도 -90~90·경도 -180~180이다. 주소의 실제 존재 여부를 지오코딩으로 확인하지는 않는다.
- documentCount/smallBoxCount/mediumBoxCount/bigBoxCount는 전달 시 0~2147483647 정수다. 양수 수량이 하나 이상이거나 otherItemDescription이 있어야 한다.
- itemPrice는 필수이며 0~Number.MAX_SAFE_INTEGER 정수다. notifiedPrice는 전달 시 3500만 허용한다.
- 문자열 대신 숫자, 중첩 배열, 지원하지 않는 필드 등 잘못된 구조는 400 INVALID_REQUEST이다.
- 필수값 누락·지원하지 않는 결제 방식·잘못된 값 범위는 422 VALIDATION_FAILED이며 error.details에 모든 오류의 field/reason을 반환한다. 원문 개인정보는 오류 응답에 포함하지 않는다.

## 2. POST /api/consultations/incomplete

**접수 시도 전 통화가 중단됐을 때만**, AI가 종료 당시 마지막 스냅샷을 한 번 전달한다. 발화마다 호출하거나 접수 실패 주문을 이 API로 대신 저장하지 않는다.

```json
{
  "eventId": "demo-call-end-1",
  "providerCallId": "demo-call-1",
  "endedAt": "2026-10-27T09:00:00+09:00",
  "endType": null,
  "systemEvent": null,
  "snapshot": {
    "parcels": [{
      "origin": { "name": "발송인", "phoneNumber": "01000000001" },
      "smallBoxCount": 1
    }]
  }
}
```

- eventId는 종료 이벤트의 안정적인 식별자다. 재시도할 때 새로 생성하지 않는다.
- providerCallId는 기존 통화·발화·녹취 수집이 사용하는 provider_call_id와 같아야 한다. 다른 AI 세션 식별자와 같다고 임의로 가정하지 않는다. 재통화에는 새로운 통화 식별자를 사용한다.
- endedAt은 실제 종료 시각이며 타임존이 필요하다. DB에 시작 시각이 있으면 그보다 빠른 종료 시각을 거절한다.
- endType/systemEvent는 실제 시스템에서 보고한 유형·이벤트 코드만 전달한다. 원인이 불명확하면 생략 또는 null로 두며, 모델의 추정이나 전체 발화·녹취를 넣지 않는다. 이 값은 보고된 관찰 정보이며 서버가 종료 원인을 확정한 결과가 아니다.
- snapshot은 위 주문 정보와 같은 구조지만 미수집 값을 생략/null로 둘 수 있다. 문자열의 잘못 수집된 전화번호·주소나 범위를 벗어난 정수도 분석을 위해 보존하고 유효성 오류로 표시한다. 타입 자체가 다른 값과 미지원 필드는 거절한다.
- 완성된 정보를 수집했더라도 실제 접수 전 종료됐다면 미완료 상담 기록으로 남는다. 주문을 생성하지 않는다.

성공: 201, data 예시:

```json
{ "incompleteConsultationSeq": 1, "callSessionSeq": 7 }
```

저장·중복 처리:

- 통화당 최종 종료 스냅샷 하나를 저장한다. 같은 통화·eventId·정규화된 본문은 최초 식별자를 반환한다. 키 순서, 동등한 타임존, 생략/null 차이로 중복 저장하지 않는다.
- 같은 통화에서 eventId 또는 내용이 바뀌면 409 EVENT_PAYLOAD_CONFLICT이며 최초 기록을 덮어쓰지 않는다. 처리 중이면 409 REQUEST_IN_PROGRESS로 같은 요청 재시도를 안내한다.
- 별도 멱등 테이블을 만들지 않는다. incomplete_consultations의 통화 UNIQUE 제약·요청 해시와 트랜잭션 잠금으로 처리한다.
- 기존 call_sessions 행에 연결하며 없으면 provider_call_id만 가진 최소 행을 만든다. 기존 발신번호·시각·종료 사유·발화·녹취는 덮어쓰지 않는다.
- 이미 주문이 연결된 통화는 409 INVALID_STATE로 거절한다. 현재 DB의 통화당 주문 연결 모델을 따른다.
- 상담 기록, 필요한 최소 통화 행, 성공 감사 기록은 같은 트랜잭션이다. 저장 실패 시 함께 롤백한다. 감사 metadata에 스냅샷을 복제하지 않는다.
- 종료 시점 기준으로 collectedFields, missingFields, errors를 계산해 보관한다. collectedFields는 값의 수집 여부이고, 유효성은 errors로 구분한다. 누락 항목을 0·기본 결제 방식 등으로 채우지 않는다.
- 원래 통화의 녹취·발화는 기존 테이블에 그대로 두고 FK로 연결한다. 재통화 시 이 스냅샷을 조회·복원하는 AI API는 제공하지 않는다.

## 3. GET /api/consultations/incomplete

관리자 세션으로 조회한다.

쿼리: limit(기본 20, 1~100), offset(기본 0), providerCallId(정확히 일치), from/to(타임존 포함 종료 시각, from 포함·to 미포함). from은 to보다 빨라야 한다.

종료 시각 내림차순, 같은 시각은 incompleteConsultationSeq 내림차순이다. 응답은 {"data": [...], "hasNext": false}이며 전체 스냅샷·전화번호·발화 원문을 목록에 복제하지 않는다.

각 항목: incompleteConsultationSeq, callSessionSeq, providerCallId, endedAt, endType, systemEvent, missingFields, createdAt.

## 4. GET /api/consultations/incomplete/{id}

관리자 세션으로 단건 조회한다. 유효한 정수 ID 범위는 1~2147483647이며 잘못된 ID는 400, 미존재 기록은 404이다.

목록 항목에 아래 필드를 추가한다.

- eventId, snapshot: 종료 이벤트와 종료 당시 주문 정보.
- collectionAnalysis: 당시의 collectedFields, missingFields, errors. 조회 시각으로 재계산해 과거 판단을 바꾸지 않는다.
- history: 기존 통화의 startedAt, endedAt, utteranceCount, recordingCount. 아직 기록되지 않은 시각은 null, 없는 발화·녹취 개수는 0이다.

callSessionSeq로 88번의 기존 통화 조회와 연결한다. 녹취 object_key·공개 URL·전체 발화 원문·요청 해시는 반환하지 않는다. 검수 메모·상태 변경은 90번이며 이번 API에는 PATCH나 주문 복원 기능이 없다.

## 배포 및 검증

- 신규 migration은 006-incomplete-consultations.sql이다. 34번 MR !49의 005 번호와 겹치지 않게 배정했다. migration runner는 파일명으로 적용하므로 005가 없는 이 브랜치에서도 검증된다.
- 이전 MR 초안의 005-order-creation-requests.sql과 관리자 POST /api/orders는 최종 변경에서 제외했다. 기존 001~004는 수정하지 않았다. 이미 별도 환경에 적용한 테이블을 삭제하는 SQL은 실행하거나 추가하지 않았다.
- 새 테이블은 실제 주문과 분리한 incomplete_consultations 하나다. 고객 등록 모듈은 이번 MR에 포함하지 않는다.
- node scripts/check.cjs: 입력/HTTP·실제 PostgreSQL·동시 재전송·새 앱 인스턴스·실패 롤백·관리자 조회·기존 인증/기업/PBX·운영 이미지/Nginx 회귀.
- infra/database/test-monolith.ps1: 신규 제약·기존 데이터 보존·반복 적용·백업 복원·체크섬·최초/후속 실패 롤백.
- 운영 DB 적용, 실제 AI/PBX 식별자 매핑 및 AI 클라이언트 호출, 디버 접수는 이 MR에서 실행하지 않았다. 앱 교체 전에 신규 migration을 적용해야 한다.
