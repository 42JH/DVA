# 페르소나 통계 조회 권한·결제수단 미정 연동

기능 변경 범위는 backend/다. 승인받은 infra/database/verify.sql의 스키마 검증도 함께 갱신한다. 프론트·AI 소스와 실제 서버 DB는 변경하지 않는다.

## 1. 활성 관리자 페르소나 조회

| API | 허용 대상 |
| --- | --- |
| GET /api/personas | ACTIVE인 OPERATOR·SUPERVISOR·SYSTEM_ADMIN |
| GET /api/personas/{id} | ACTIVE인 OPERATOR·SUPERVISOR·SYSTEM_ADMIN |
| GET /api/personas/{id}/versions | ACTIVE인 OPERATOR·SUPERVISOR·SYSTEM_ADMIN |
| POST /api/personas, PATCH /api/personas/{id}, POST /api/personas/{id}/activate | ACTIVE인 SUPERVISOR(개발자)·SYSTEM_ADMIN |
| GET /api/ai/options | ACTIVE인 SUPERVISOR(개발자)·SYSTEM_ADMIN |

목록·상세·버전 응답 형식은 유지한다. 미로그인·만료 세션·PENDING·INACTIVE는 401이다. OPERATOR의 생성·수정·publish·AI 옵션 조회는 403이다. AI 서비스 토큰만으로 관리자 조회를 할 수 없다. 신규 DEVELOPER 코드는 만들지 않으며 기존 SUPERVISOR를 개발자로 사용한다. 프론트의 관리 메뉴·생성·수정·적용 버튼은 SUPERVISOR 또는 SYSTEM_ADMIN 조건을 사용하고, SUPERVISOR 표시 이름은 '개발자'로 바꾼다.

프론트 `features/dashboard/hooks/useDashboard.ts`의 isSystemAdmin에 따른 페르소나 탭·조회 제한을 제거한다. 로그인 가드의 ACTIVE 세션 확인은 유지한다. 대시보드는 기존 GET /api/personas → 유형별 versions → aiPersonaVersionSeq로 calls·unanswered-questions를 조회하는 흐름을 사용한다.

## 2. 주문 결제수단 미정

신규 주문의 paymentMethodType을 생략하면 DB와 GET /api/orders·GET /api/orders/{id} 응답에 null이 저장·반환된다. billing을 자동 지정하지 않는다. 요청에서 명시적 null이나 알 수 없는 결제수단을 보내는 것은 기존대로 400이며, 미정 요청은 필드를 생략한다. PATCH에서 생략하면 기존 값이 유지된다.

```json
{
  "data": {
    "orderSeq": 123,
    "status": "COLLECTING",
    "paymentMethodType": null,
    "totalAmount": null
  }
}
```

위 예시는 상세 응답의 일부 필드다. 관리자 목록 전용 GET /api/admin/orders는 원래 결제수단을 반환하지 않으며 응답은 변경하지 않는다.

프론트는 다음을 반영한다.

1. 서버 주문 DTO의 paymentMethodType에 null을 추가한다.
2. null은 '미정'으로 표시한다. 개인카드·월결제로 대체하지 않는다.
3. 수정 창의 초기 결제수단도 미선택 상태로 둔다. 특히 `order?.paymentMethod ?? 'MONTHLY'`가 미정을 월결제로 바꾸지 않도록 한다.
4. COLLECTING 주문을 최종 접수하기 전 billing·credit·groupBilling 중 하나를 선택해 PATCH한다. 선택한 방식을 저장한 뒤 응답 version으로 submit한다.
5. 미선택 상태에서 최종 접수하면 422 VALIDATION_FAILED이며 error.details에 `{ "field": "paymentMethodType", "reason": "required" }`가 포함된다.

AI의 결제수단 생략 요청은 그대로 사용할 수 있다. COMPLETE 결과와 관리자 수기 최종 접수에서는 결제수단이 필요하며 미정이면 저장·결제·디버 전송을 진행하지 않는다. 일부 정보가 있는 미완료·취소 주문에는 null을 보존한다. 주문 데이터가 전혀 없는 미완료·취소 통화는 [빈 통화 계약](empty-ai-order-results.md)에 따라 주문을 생성하지 않는다.

## 3. DB 적용과 범위

새 migration 037은 orders.payment_method_type의 기본값·NOT NULL을 제거하고 COLLECTING·CANCELLED 이외 상태에는 결제수단을 요구한다. 이전 migration은 수정하지 않으며 기존 billing·credit·groupBilling·cat 값은 변경하지 않는다. 기존 개인카드 값이 실제 선택인지 과거 기본값인지 구분할 근거가 없으므로 소급해서 null로 바꾸지 않는다.

038은 주문 없는 통화 결과의 재전송 식별자를 저장한다. 038까지 적용한 뒤 새 백엔드를 기동한다. 실제 서버 SQL 적용은 별도이며 과거에 생성된 빈 주문은 자동 삭제하지 않는다.
