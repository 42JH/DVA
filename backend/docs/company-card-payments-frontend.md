# 기업·직원 결제 권한 및 등록 카드 프론트 연동 명세

2026-11-11 원격 develop-backend b87007c4 기준.

**구현·로컬 검증 완료 명세다. 실제 운영 배포와 PG 상점 승인 검증은 별도이며, 서버 배포 후 연동한다.**

## 확정한 결제 규칙

| paymentMethodType | 처리 |
| --- | --- |
| credit | 월결제. 기업 고객은 기업·직원별 월결제 자격을 확인한다. |
| billing | 고객의 등록 카드가 있으면 자동 승인한다. 등록 카드가 없으면 기존 MM 결제 링크를 발송한다. |
| groupBilling | 기업 등록 카드로 실제 승인한 뒤 접수한다. 기업 카드와 직원별 허용이 필요하다. |

프론트는 기존 paymentMethodType을 전송한다. paymentMode나 별도 결제 링크 enum은 추가하지 않는다.
자동 카드 승인이 끝나기 전에는 notPaid가 잠시 반환될 수 있다. 주문 상태를 재조회해 PAID와 이후 접수 상태를 반영한다.
PG 응답이 불명확하면 서버가 거래 결과를 조회하며, 프론트는 새 주문을 만들어 결제를 재요청하지 않는다.

기업 고객이 결제수단을 생략하면, 기업 월결제 사용 자격이 있는 경우 credit으로 확정한다.
자격이 없는 경우 화면에서 사용 가능한 수단을 선택한다. 카드가 등록됐다고 기존 미결제 주문을 전부 자동 결제하지 않는다.

기존 주문 상태와 statusGroup 계약을 사용한다.
notPaid는 결제 대기, PAID는 결제 완료, SUBMITTING은 접수 중, ACCEPTED는 접수 완료다.
SUBMITTING_FAILED와 SUBMISSION_FAILED는 배송 접수 실패이며 카드 승인 실패와 구분한다.

## 인증

- 관리자 요청은 기존 dva_session 쿠키와 허용 Origin을 사용한다. 브라우저 fetch는 credentials: include로 호출한다.
- 카드 조회·등록·해제는 기존 관리자 세션 또는 AI_BUSINESS_TOKEN Bearer로 호출할 수 있다.
- AI 카드 요청은 call_session_seq 헤더에 진행 중인 통화 번호를 보낸다. 개인 카드는 통화 고객, 기업 카드는 통화 고객이 속한 기업만 대상이 된다.
- 기업·직원 등록과 직원별 결제 권한 변경은 관리자 세션을 사용한다.
- 기존 API의 AI Bearer 및 관리자 인증 계약은 보존하며, 새 권한은 해당 메서드에 추가한다.
- Idempotency-Key가 필요한 카드 등록은 최초 요청 때 UUID를 만들고 동일 요청 재시도에서 재사용한다.

## 화면별 연결

| 화면 | 호출 순서 |
| --- | --- |
| CSV로 기업 등록 | 기존 POST /api/companies로 기업·직원을 등록하고, 카드 입력이 있으면 반환된 기업 번호로 PUT /api/companies/{id}/group-card를 호출한다. |
| 기업 정보 수정 | 기존 PATCH /api/companies/{id}로 정보를 저장하고 카드 입력이 있으면 기업 카드 PUT을 호출한다. |
| 고객 정보 수정 | 기존 PATCH /api/customers/{id}로 정보를 저장하고 카드 입력이 있으면 개인 카드 PUT을 호출한다. |
| 직원별 결제 권한 | 단건 PATCH /api/members/{id} 또는 배열 PATCH /api/companies/{id}/members를 호출한다. |
| 카드 표시 | 개인·기업 카드 GET으로 마스킹 정보를 표시한다. |
| 카드 등록 해제 | 개인·기업 카드 DELETE를 호출하고 관련 조회를 갱신한다. |

기업·직원 저장 성공 후 카드 등록이 실패하면 기업·직원을 재생성하지 않는다.
화면에 카드 등록 실패를 표시하고 카드 PUT만 다시 시도한다.
기존 CSV 파일은 기존처럼 프론트가 읽어 JSON으로 전송한다. 기업 카드는 기업당 한 번 등록한다.

## 기업·직원 기본값

- POST /api/companies의 monthlyBillingEnabled 생략 시 true다.
- 신규 직원의 monthlyBillingEnabled 생략 시 true, groupBillingEnabled 생략 시 false다.
- 기존 기업의 월결제 비활성 값은 보존한다.
- 기존 직원 그룹결제 허용은 기존 부서 설정에서 직원별 값으로 이관한다.
- 이후 그룹 카드 사용 자격은 직원별 설정을 사용한다. 부서가 없는 직원도 기업 카드 사용 권한을 부여할 수 있다.
- 월결제·그룹 카드 허용은 직원 status와 별도다. 결제 권한을 끈다고 직원 계정을 비활성화하지 않는다.

### 직원 등록 JSON

기존 POST /api/companies의 members와 POST /api/companies/{id}/members의 단건·items 입력에 아래 두 필드를 선택적으로 추가한다.

```json
{
  "employeeNo": "001",
  "name": "테스트 직원",
  "phoneNumber": "01012345678",
  "monthlyBillingEnabled": true,
  "groupBillingEnabled": false
}
```

기존 직원 갱신에서 권한 필드를 생략하면 현재 값을 보존한다.
기존 departmentSeq, departmentName, role, address 입력 계약을 함께 사용할 수 있다.

### 단건 권한 변경

PATCH /api/members/{membershipSeq}

```json
{
  "monthlyBillingEnabled": false,
  "groupBillingEnabled": true
}
```

응답은 204다. 둘 중 한 필드만 보내도 된다. 기존 role·status·departmentSeq 수정도 사용할 수 있다.

### 단건·복수 권한 변경

PATCH /api/companies/{organizationSeq}/members

```json
{
  "membershipSeqs": [11, 12],
  "monthlyBillingEnabled": true,
  "groupBillingEnabled": false
}
```

membershipSeqs는 중복 없는 1~100개 배열이다. 한 개만 넣으면 단건으로 처리한다.
모두 같은 기업의 유효한 직원이어야 하며 한 항목이라도 실패하면 전체 롤백한다.
결제 권한 필드는 최소 하나 필요하다. 성공 응답은 204다.
성공 후 기업 직원 목록과 해당 고객의 결제 가능 수단을 갱신한다.

GET /api/companies/{id}/members의 membership에 monthlyBillingEnabled와 groupBillingEnabled가 추가된다.

## 카드 조회·등록·해제

| 용도 | Method | 경로 | 성공 |
| --- | --- | --- | --- |
| 개인 카드 조회 | GET | /api/customers/{id}/card | 200 |
| 개인 카드 등록·교체 | PUT | /api/customers/{id}/card | 200 |
| 개인 카드 해제 | DELETE | /api/customers/{id}/card | 204 |
| 기업 카드 조회 | GET | /api/companies/{id}/group-card | 200 |
| 기업 카드 등록·교체 | PUT | /api/companies/{id}/group-card | 200 |
| 기업 카드 해제 | DELETE | /api/companies/{id}/group-card | 204 |

id는 각 경로의 customerSeq 또는 organizationSeq다.
소유자당 활성 카드 한 개를 관리하며 교체 성공 시 이전 카드는 soft delete한다.
등록 실패 시 기존 활성 카드를 보존한다. 해제 후에는 관련 카드·결제 가능 수단을 재조회한다.

### 등록 요청

관리자 요청은 기존 세션을 사용한다. PUT에는 Idempotency-Key 헤더를 추가한다.

```http
PUT /api/customers/50/card
Content-Type: application/json
Idempotency-Key: 9739765b-a6dd-4569-9d3d-4a07776ca88a
```

```json
{
  "cardNumber": "4111111111111111",
  "expirationYear": 2030,
  "expirationMonth": 12,
  "customerIdentityNumber": "900101",
  "cardPassword": "00",
  "customerName": "테스트 고객"
}
```

위 번호와 소유자 정보는 형식 설명용 테스트 값이다.

| 필드 | 규칙 |
| --- | --- |
| cardNumber | 숫자 문자열 14~20자리 |
| expirationYear | 4자리 정수, 만료되지 않은 카드 |
| expirationMonth | 1~12 정수 |
| customerIdentityNumber | 카드 소유자 생년월일 6자리 또는 사업자등록번호 10자리 |
| cardPassword | PG 계약에서 요구할 경우 비밀번호 앞 두 자리 |
| customerName | 선택, 최대 100자 |

PG 카드 인증·등록에 필요한 입력이며, 카드 등록 요청 자체가 주문 결제를 발생시키지는 않는다.
카드 원문·소유자 확인값·비밀번호를 프론트 로그, localStorage, 분석 도구, 통화 이벤트, MM에 남기지 않는다.
서버는 PG가 발급한 결제용 키를 암호화해 저장하고 조회에는 마스킹 정보만 반환한다.

같은 Idempotency-Key에 다른 내용을 보내면 409다.
처리 중인 같은 요청도 409일 수 있으므로 완료 여부를 확인한 뒤 같은 키로 재시도한다.

### 조회·등록 응답

```json
{
  "data": {
    "paymentCardSeq": 7,
    "issuerCode": "61",
    "maskedNumber": "************1111",
    "expirationYear": 2030,
    "expirationMonth": 12,
    "active": true
  },
  "meta": {
    "requestId": "서버 요청 추적 번호"
  }
}
```

카드가 없으면 GET은 data: null을 반환한다. 카드 원문과 PG 승인용 키는 응답에 포함되지 않는다.
카드 해제는 soft delete하며 등록·교체·해제는 감사 로그에 기록한다.

## 기업 카드 선택 비활성화

**기업 카드가 등록되어 있어야 그룹 카드 결제 선택지를 활성화한다.**

기업 조회의 groupCardRegistered는 현재 사용 가능한 기업 카드의 등록 여부다.
직원별 groupBillingEnabled는 사용 허용 설정이다.

그룹 카드 결제 선택은 아래 조건을 모두 충족할 때 활성화한다.

1. 고객·기업·소속이 ACTIVE이며 삭제되지 않음.
2. 직원의 groupBillingEnabled가 true.
3. 기업의 groupCardRegistered가 true.

카드가 없거나 만료·등록 해제 상태면 그룹 카드 결제 항목을 disabled로 표시하고 카드 등록이 필요함을 안내한다.
직원 허용이 false면 관리자에게 사용 권한을 요청하도록 안내한다.
기업 카드 등록과 직원 허용 토글 관리는 각각 할 수 있다.

고객 확인 응답의 availablePaymentMethods에서 groupBilling이 빠져 있으면 주문 결제수단으로 선택하지 않는다.
서버는 주문 확정·실제 승인 직전에도 같은 조건을 검증한다.

## billing 주문 응답 처리

결제 방식은 billing 하나를 사용하며 프론트에서 카드 유무를 입력으로 보내지 않는다.
서버가 주문 확정 시 등록 카드를 확인해 사용할 카드 또는 기존 링크 경로를 정한다.

- 등록 카드 없음: 기존 MM 결제 링크와 결제 대기 화면을 사용한다.
- 등록 카드 있음: 서버가 자동 승인한다. 승인 완료 전에는 결제 대기, 완료 후에는 실제 주문 상태를 표시한다.
- 자동 승인 거절: 주문을 결제 대기로 보존하고 cardPaymentFailed를 표시한다.
- 결과 확인 중: 추가 승인을 중복 요청하지 않고 기존 결제 조회 결과를 기다린다.

기존 주문 응답의 paymentRequest에 autoCharge와 cardPaymentFailed가 추가된다.
두 필드는 읽기 전용이다. paymentRequest가 null이면 완료·취소 여부를 주문 status로 판단한다.
기존 paymentRequestId, amount, expiresAt, notificationStatus 필드는 유지한다.

기존 GET /api/payments/requests/{id}에도 autoCharge와 cardPaymentFailed를 제공한다.
기존 결제 링크·confirm·reconcile 계약은 일반 링크 요청에서 계속 사용할 수 있다.

## 오류

| HTTP | 프론트 처리 |
| --- | --- |
| 400 | 필드 형식, UUID 요청 키, AI 통화 헤더 확인 |
| 401 | 세션 만료 또는 AI 토큰 오류 |
| 403 | 소유 범위·직원 결제 권한·선택 결제수단 자격 확인 |
| 404 | 고객·기업·직원 또는 결제 요청 재조회 |
| 409 | 처리 중·다른 변경·같은 키의 본문 충돌. 재조회 후 재시도 |
| 422 | 카드 등록·승인 거절 또는 저장된 주문 입력 검증 실패. 응답 code와 details 확인 |
| 502 | PG 결과가 불명확함. 기존 거래의 결과 조회 |
| 503 | 서버의 PG 키·카드 암호화·결제 설정 확인 필요 |

기존 공통 error.code, error.message, error.details와 meta 계약을 사용한다.
카드 등록·인증·결제 분기·기업 카드 자격·다중 인스턴스 중복 승인 방지·응답 유실 복구·승인 거절·soft delete를 포함한 신규 통합 시나리오 8건을 통과했다. 전체 54개 DB 통합 테스트 파일과 운영 이미지·Nginx 경유 검증도 통과했다. 실제 PG 상점의 카드사 승인은 미검증이다.

## 서버 배포 전제

배포에는 063·064 migration과 서버 전용 빌링 시크릿 키·카드 암호화 키가 필요하다. 프론트·AI에 서버 키를 넣지 않는다. 상세 절차는 [운영·복구 안내](company-card-payments-operations.md)를 따른다.

카드 등록·자동 승인 요청은 PG 처리에 따라 오래 걸릴 수 있다. 요청 제한을 85초 이상 허용하고, 응답이 끊기면 같은 요청 키로 결과를 확인한다. 새 주문을 생성해 결제를 반복하지 않는다.
