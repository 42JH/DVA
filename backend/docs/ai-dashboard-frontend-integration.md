# AI 상담 성능 대시보드 — 프론트 연동 명세

기준: `feature/ai-dashboard`, migration `050-call-dashboard-metrics.sql`. 운영 API 적용 여부는 별도 확인한다. AI 전송은 [별도 AI 명세](ai-dashboard-ai-integration.md)를 따른다.

## 1. 호출·고객 탭·공통 응답

| 화면 | GET API |
| --- | --- |
| 단계별 고객 이탈 | `/api/dashboard/stage-dropoffs` |
| 평균 접수 소요시간·페르소나 비교 | `/api/dashboard/registration-time` |
| 고객 불편 표현 통화 | `/api/dashboard/complaint-calls` |
| 응답 대기·레이턴시 | `/api/dashboard/response-wait` |

네 API의 유일한 쿼리는 `customerType=ALL|NEW|EXISTING`이며 생략 시 `ALL`이다. 대소문자를 구분한다. **날짜 필터·페이지네이션·비교 페르소나 선택 쿼리는 없다.** 알 수 없는 쿼리·중복 값·빈 값은 400이다.

| 탭 | 값 | 의미 |
| --- | --- | --- |
| 전체 | `ALL` | 고객 미분류까지 포함 |
| 신규 고객 | `NEW` | 분석의 isNewCustomer=true |
| 기존 고객 | `EXISTING` | 분석의 isNewCustomer=false |

고객 구분은 통화 당시 AI가 확정한 분석값이다. 현재 고객 테이블 상태로 다시 분류하지 않는다. 고객 탭 하나가 네 카드를 함께 제어하면 같은 값을 네 요청에 전달한다.

ACTIVE인 OPERATOR·SUPERVISOR·SYSTEM_ADMIN의 `dva_session` 쿠키를 사용한다. **AI 서비스 토큰은 프론트에 넣지 않는다.** 초기 진입·탭 변경·수동 새로고침에서 네 요청을 병렬 호출할 수 있다. 전용 SSE/갱신 이벤트는 이번 API에 추가하지 않았다. 탭을 빠르게 변경할 때 이전 탭 응답이 현재 화면을 덮지 않도록 요청 취소 또는 요청 순서를 관리한다.

```javascript
const endpoints = ['stage-dropoffs', 'registration-time', 'complaint-calls', 'response-wait'];
async function loadDashboard(customerType, signal) {
  return Promise.all(endpoints.map(async (endpoint) => {
    const response = await fetch(
      `/api/dashboard/${endpoint}?${new URLSearchParams({ customerType })}`,
      { credentials: 'include', signal },
    );
    const body = await response.json();
    if (!response.ok) throw new Error(`${body.error.code}: ${body.error.message}`);
    return body.data;
  }));
}
```

성공은 200이며 목록 envelope가 아닌 아래 단건 형식이다. `Cache-Control: no-store`를 반환한다.

```json
{
  "data": { "customerType": "ALL", "endedCallCount": 10, "unclassifiedCustomerCallCount": 1 },
  "meta": { "requestId": "요청별 ID" }
}
```

위 `data`는 공통 부분만 표시한 예시다. 카드별 전체 필드는 아래 표를 따른다.

| 공통 필드 | 타입·의미 |
| --- | --- |
| `customerType` | 요청한 고객 구분 |
| `endedCallCount` | 보관 중인 종료 통화 수. 삭제·5년 만료 제외 |
| `unclassifiedCustomerCallCount` | 위 통화 중 고객 구분 null인 수. NEW/EXISTING에서는 0 |

네 카드 모두 **종료 통화**가 대상이며 진행 중 통화는 제외한다. 통화 시작/종료 시각은 PBX 우선·없으면 AI 분석 시각을 사용한다. 최초 수신부터 5년 만료는 실제 폐기 작업 전에도 제외한다. 기준 시각을 알 수 없는 기존 통화는 임의로 만료시키지 않는 기존 정책을 따른다. 날짜 필터는 없어도 soft delete·보관 기한은 적용한다.

`null`은 미측정·계산 불가이며 **0과 다르다**. 비율/평균의 분모가 0이면 null이므로 `데이터 없음` 또는 `—`로 표시한다. 건수 0·측정된 평균 0은 그대로 표시한다. 비율은 이미 **0~100의 숫자**이므로 다시 100을 곱하지 않는다. 백엔드는 반올림하지 않으며 프론트에서 표시 자릿수만 조절한다.

각 요청은 한 SQL 스냅샷에서 집계하지만 네 요청 전체가 하나의 트랜잭션은 아니다. AI 지표가 독립 도착하므로 카드별 측정 완료 통화 수가 다를 수 있다.

## 2. 단계별 고객 이탈

`GET /api/dashboard/stage-dropoffs?customerType=NEW`

| data 필드 | 타입·의미 |
| --- | --- |
| 공통 3개 필드 | 위 공통 규칙 |
| `assessedCallCount` | number. AI가 이탈 단계 또는 NONE을 전송한 종료 통화 수 |
| `unassessedCallCount` | number. endedCallCount - assessedCallCount |
| `dropoffCallCount` | number. NONE을 제외한 이탈 통화 수 |
| `dropoffRatePercent` | number 또는 null. dropoffCallCount / assessedCallCount × 100 |
| `stages` | 아래 순서로 항상 8개 |
| `stages[].stage` | 아래 코드 |
| `stages[].callCount` | number. 해당 단계에서 이탈한 통화 수 |
| `stages[].dropoffRatePercent` | number 또는 null. 해당 단계 이탈 / assessedCallCount × 100 |

| stage | 표시 |
| --- | --- |
| `SENDER_INFO` | 발신자 정보 |
| `RECIPIENT_INFO` | 수신자 정보 |
| `ITEM_INFO` | 물품 정보 |
| `CONFIRMATION` | 최종 확인 |
| `PAYMENT_GUIDANCE` | 결제 안내 |
| `FAQ_ANSWER` | FAQ 답변 |
| `ORDER_LOOKUP` | 접수 내역 조회 |
| `ORDER_CANCEL` | 주문 취소 |

화면의 **단계 진입 수 컬럼은 제거**한다. 단계별 비율은 단계 진입 대비가 아니라 판정 완료 통화 대비다. `NONE`은 이탈 없는 정상 판정이므로 분모에는 포함하되 표에 별도 행으로 반환하지 않는다. 미전송은 정상으로 추정하지 않는다. 표의 callCount 합은 dropoffCallCount다.

## 3. 평균 접수 소요시간과 페르소나 막대

`GET /api/dashboard/registration-time?customerType=ALL`

| data 필드 | 타입·의미 |
| --- | --- |
| 공통 3개 필드 | 위 공통 규칙 |
| `registrationCallCount` | number. 접수 확정 건수가 1 이상인 통화 수 |
| `unmeasuredCallCount` | number. 접수 건수 미수신 통화 수. 확인된 0건은 포함하지 않음 |
| `registeredParcelCount` | number. 접수가 있는 통화의 배송 상세 건수 합계. 결제 대기 포함 |
| `totalCallDurationMs` | number. 같은 통화의 **전체** 통화시간 합계(밀리초) |
| `averageSecondsPerParcel` | number 또는 null. totalCallDurationMs / registeredParcelCount / 1000 |
| `comparison.current` | 현재 ACTIVE 버전 객체 또는 null |
| `comparison.previous` | 현재 버전 활성화 직전에 ACTIVE였던 버전 객체 또는 null |
| `comparison.previousMinusCurrentSeconds` | number 또는 null. 직전 평균 - 현재 평균, 초/건 |

**3분 통화에서 배송 상세 2건 접수 = 90초/건**이다. 전체 평균도 `시간 합계 / 건수 합계`이며 통화별 평균의 단순 평균이 아니다. 접수 0건인 통화의 시간은 평균에 넣지 않는다. FAQ·조회 등을 함께 진행했다면 그 시간도 전체 통화에 포함한다.

각 비교 객체는 아래와 같다. 현재/직전 둘 모두 같은 고객 탭 필터를 적용한다.

| 비교 객체 필드 | 의미 |
| --- | --- |
| `aiPersonaVersionSeq` | 정확한 설정 버전 DB 번호 |
| `aiPersonaSeq` | 페르소나 유형 번호 |
| `name`, `version` | 버전의 표시 이름과 버전 숫자 |
| `registrationCallCount` | 이 버전을 실제 사용한 접수 통화 수 |
| `registeredParcelCount` | 같은 통화들의 확정 배송 상세 합계 |
| `totalCallDurationMs` | 같은 통화들의 전체 시간 합계 |
| `averageSecondsPerParcel` | 같은 통화들의 초/건. 표본 없으면 null |

막대는 **현재 운영 버전 vs 이 버전 직전에 성공적으로 활성화된 버전** 두 개다. 같은 페르소나 유형의 v1→v2 변경도 구분한다. 프론트가 생성 순서·version 숫자·appliedAt 정렬로 비교 대상을 고르지 않는다. 신규 생성/PENDING 버전이 있어도 바꾸지 않는다. 직전 버전이 재활성화 대기 중이어도 보존된 정확한 버전을 비교한다.

- 상단 평균은 선택 고객의 모든 접수 통화다. 막대 두 버전만으로 상단을 다시 계산하지 않는다.
- 각 막대는 해당 버전을 사용한 보관 중인 접수 통화 전체를 집계한다. 이번 활성화 이후의 통화로만 자르는 방식은 아니다.
- ACTIVE가 없으면 두 비교 객체가 null이다. 첫 활성화 또는 과거 이력 확인 불가면 previous만 null일 수 있다. 임의의 다른 페르소나를 넣지 않는다.
- 버전은 있어도 해당 고객 탭의 접수 표본이 없으면 객체의 건수/합계는 0, 평균은 null이다. 막대 0초로 그리지 않는다.
- 차이가 양수면 현재 버전이 그만큼 빠르고, 음수면 그만큼 느리다. 한쪽 평균이 없으면 차이도 null이다.

예를 들어 아래처럼 표시할 수 있다. 아래는 공통 envelope의 `data` 전체 예시다.

```json
{
  "customerType": "ALL",
  "endedCallCount": 2,
  "unclassifiedCustomerCallCount": 0,
  "registrationCallCount": 2,
  "unmeasuredCallCount": 0,
  "registeredParcelCount": 3,
  "totalCallDurationMs": 300000,
  "averageSecondsPerParcel": 100,
  "comparison": {
    "current": {
      "aiPersonaVersionSeq": 12, "aiPersonaSeq": 2, "name": "친절형", "version": 2,
      "registrationCallCount": 1, "registeredParcelCount": 2,
      "totalCallDurationMs": 180000, "averageSecondsPerParcel": 90
    },
    "previous": {
      "aiPersonaVersionSeq": 11, "aiPersonaSeq": 2, "name": "친절형", "version": 1,
      "registrationCallCount": 1, "registeredParcelCount": 1,
      "totalCallDurationMs": 120000, "averageSecondsPerParcel": 120
    },
    "previousMinusCurrentSeconds": 30
  }
}
```

## 4. 고객 불편 표현 통화

`GET /api/dashboard/complaint-calls?customerType=EXISTING`

| data 필드 | 타입·의미 |
| --- | --- |
| 공통 3개 필드 | 위 공통 규칙 |
| `assessedCallCount` | number. hasComplaint가 true/false인 종료 통화 수 |
| `unassessedCallCount` | number. 미판정·분석 미수신 통화 수 |
| `complaintCallCount` | number. hasComplaint=true인 통화 수 |
| `complaintRatePercent` | number 또는 null. complaintCallCount / assessedCallCount × 100 |
| `typeTotalCount` | number. 화면 6개 유형별 통화 수의 합계. 도넛 분모 |
| `legacyTypeCallCount` | number. 화면 6개 외 과거 유형이 있는 통화 수(통화 내 중복 제외) |
| `types` | 아래 순서로 항상 6개 |
| `types[].type` | 아래 코드 |
| `types[].callCount` | number. 해당 유형이 있는 통화 수. 통화·유형당 한 번 |
| `types[].sharePercent` | number 또는 null. callCount / typeTotalCount × 100 |

| type | 표시 |
| --- | --- |
| `INFORMATION_RECOGNITION_ERROR` | 정보 인식 오류 |
| `INTENT_RECOGNITION_ERROR` | 용건 인식 오류 |
| `UNSUPPORTED_ANSWER` | 근거 없는 답변 |
| `SLOW_RESPONSE` | 응답 지연 |
| `INTERRUPTION` | 말 끊김 |
| `DISSATISFACTION_EXPRESSION` | 불만 표현 |

한 통화의 같은 유형 근거가 여러 개면 1건이다. 다른 유형 2개면 각 1건이므로 typeTotalCount는 complaintCallCount보다 클 수 있다. 상단은 불편 **통화** 비율, 도넛은 유형별 통화 수 합계 안의 구성비다.

기존 `REPEATED_QUESTION`, `SPEAKING_TOO_FAST`, `RECOGNITION_FAILURE`, `AI_REFUSAL`은 새 여섯 유형으로 변환하지 않는다. 과거 유형도 상단 통화율에 포함하고 `legacyTypeCallCount`를 `기존 분류 N통화` 등 별도 안내로 표시할 수 있다. 화면 유형과 과거 유형을 함께 가진 통화도 있으므로 이 수를 typeTotalCount에 더해 도넛을 재계산하지 않는다.

RAG 응답·미답변 사유 API를 이 카드에 사용하지 않는다. 기존 통화 목록·상세의 `analysis.complaints[].type`도 새 5개 코드가 추가되며 응답 구조는 동일하다. 상세 화면의 라벨/타입 정의에는 [AI 명세의 전체 10개 코드](ai-dashboard-ai-integration.md#불편-표현-유형)를 반영한다.

## 5. 응답 대기·레이턴시

`GET /api/dashboard/response-wait?customerType=ALL`

| data 필드 | 타입·의미 |
| --- | --- |
| 공통 3개 필드 | 위 공통 규칙 |
| `measuredCallCount` | number. 대기 수신 완료이며 현재 통화시간과 모순 없는 통화 수 |
| `unmeasuredCallCount` | number. 대기 지표 미수신 통화 수 |
| `invalidWaitCallCount` | number. 수신 후 PBX 시각 보정 등으로 전체 대기가 통화시간보다 커진 수 |
| `totalWaitMs` | number. 유효 측정 통화들의 전체 대기 합계(밀리초) |
| `totalCallDurationMs` | number. 위 **동일 통화들**의 전체 시간 합계(밀리초) |
| `waitRatePercent` | number 또는 null. totalWaitMs / totalCallDurationMs × 100 |
| `processes` | 아래 순서로 항상 7개 |
| `processes[].processType` | 아래 코드 |
| `processes[].measurementCount` | number. 유효 통화들의 해당 유형 측정 횟수 합계 |
| `processes[].totalLatencyMs` | number. 같은 유형 레이턴시 합계(밀리초) |
| `processes[].averageLatencyMs` | number 또는 null. totalLatencyMs / measurementCount |

| processType | 표시 |
| --- | --- |
| `CUSTOMER_LOOKUP` | 고객 조회 |
| `INFORMATION_INPUT` | 정보 입력 |
| `FAQ_LOOKUP` | FAQ 조회 |
| `ORDER_LOOKUP` | 접수 내역 조회 |
| `ORDER_CANCEL` | 주문 취소 |
| `ADDRESS_LOOKUP` | 주소 조회 |
| `ORDER_SAVE` | 접수 저장 |

**P95 컬럼은 제거**하고 유형별 평균 레이턴시를 사용한다. 상단 `통화시간 중 대기 비율`은 유지한다. 평균은 횟수로 가중한 값이며 통화별 평균의 단순 평균이 아니다. 초로 표시하려면 averageLatencyMs / 1000을 표시 단계에서 계산한다.

전체 대기는 AI가 겹친 구간을 제외한 값이다. 유형별 합을 다시 더해 상단 대기를 만들지 않는다. `invalidWaitCallCount` 건은 이 카드의 대기·통화시간·레이턴시 전부에서 제외하며 별도 데이터 확인 안내에 사용할 수 있다. `endedCallCount = measuredCallCount + unmeasuredCallCount + invalidWaitCallCount`다. 측정한 대기 0과 미수신은 다르다. 전체 통화시간까지 0이면 비율은 null이다.

## 6. 오류·삭제·배포

오류 형식은 `{ error: { code, message, details }, meta: { requestId } }`이며 응답 헤더에도 `X-Request-Id`가 있다.

| HTTP | 화면 처리 |
| --- | --- |
| 400 `INVALID_REQUEST` | 쿼리 값·제거한 날짜/페이지 필터 확인 |
| 401 | 로그인·세션 만료 처리 |
| 403 | 비활성/허용되지 않은 관리자 권한 확인 |
| 500 `INTERNAL_ERROR` | 조회 실패 표시·재시도. 데이터 없음/0건으로 바꾸지 않음 |

새 업무 DELETE API는 추가하지 않는다. 기존 통화 soft delete 즉시 네 조회에서 제외하며, 최초 수신부터 5년 실제 폐기 시 분석과 새 지표를 함께 제거한다. AI가 두 지표를 보내지 않은 과거 통화에 기본 지표를 생성하지 않는다.

배포 순서는 050 적용 → 새 BE 실행 → AI 전송·프론트 호출 연결이다. 현재/직전 활성 버전 관계는 BE가 저장하며 과거 성공 감사로 확인할 수 있는 경우만 보완한다. 확인 불가능한 과거는 previous=null로 시작한다. 프론트 소스·실제 운영 배포와 화면 확인은 이번 백엔드 작업과 별도다.
