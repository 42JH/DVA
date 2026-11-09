# AI 상담 성능 대시보드 — AI 연동 명세

기준: `feature/ai-dashboard`, migration `050-call-dashboard-metrics.sql`. 운영 배포·AI 소스 반영 여부와는 별개다. 프론트 조회는 [별도 프론트 명세](ai-dashboard-frontend-integration.md)를 따른다.

## 1. 변경 요약과 전송 순서

| API | 변경 | AI가 보내는 값 |
| --- | --- | --- |
| `POST /api/ai/calls/{id}/analysis` | 기존 형식 유지, 불편 유형 5개 추가 | 기존 고객 구분·실제 페르소나 버전·접수 건수·불편 판정 등 |
| `POST /api/ai/calls/{id}/stage-metrics` | 신규 | 최종 이탈 단계 하나 |
| `POST /api/ai/calls/{id}/response-wait-metrics` | 신규 | 통화 전체 대기시간, 처리 유형별 레이턴시 합계·횟수 |

1. 기존 유효 통화 등록에서 받은 `callSessionSeq`를 경로 `{id}`에 사용한다. `providerCallId`는 최초 통화 ID 그대로다. 이 API들이 통화를 새로 만들지는 않는다.
2. 통화 종료 후 기존 `analysis`를 확정 전송하고 **204 성공을 확인한다**.
3. `stage-metrics`와 `response-wait-metrics`를 각각 전송한다. 이 두 요청은 병렬 전송할 수 있다. 한쪽의 수신·재전송이 다른 쪽을 덮어쓰지 않는다.
4. 실패한 항목만 같은 최종 본문으로 재전송한다. 각 항목의 최초 저장과 동일 재전송은 모두 **204, 본문 없음**이다.

세 요청 모두 다음 헤더를 사용한다. 새 환경변수·토큰은 없다. 관리자 쿠키·브라우저 Origin은 보내지 않는다.

```http
Authorization: Bearer <AI_INSIGHTS_TOKEN>
Content-Type: application/json
```

`{id}`는 양의 int32, `providerCallId`는 공백·NUL 없는 최대 200자 문자열이다. 통화 번호와 ID가 일치해야 한다. 장난전화·업무 무관 통화의 등록/전송 생략 정책은 [기존 계약](meaningful-call-registration-handoff.md)을 유지한다.

## 2. 기존 analysis에서 계속 필요한 값

대시보드를 위해 아래 값도 최초 확정 분석에 채운다. 기존 선택 필드를 API 차원에서 필수로 바꾸지는 않았다. 미수집을 0/false로 추정하지 않는다. 전체 필수 필드는 [ANL-01](../../docs/api/call-analysis.md)을 따른다.

| 필드 | 값과 의미 | 사용처 |
| --- | --- | --- |
| `startedAt`, `endedAt` | 시간대 있는 ISO 8601, 종료 >= 시작 | PBX 시각이 없을 때 통화 전체 시간 |
| `aiPersonaVersionSeq` | 실제 사용한 설정 버전 DB 번호 또는 null | 현재·직전 활성 버전 막대에 통화를 배정 |
| `isNewCustomer` | 통화 시작 시 판정한 신규 true / 기존 false. 생략/null은 미분류 | 전체·신규·기존 탭 |
| `registeredParcelCount` | 0 이상 int32. 생략/null은 미수집 | 접수 1건당 통화시간 |
| `hasComplaint` | true 불편 있음 / false 없음 / null 미판정 | 불편 표현 통화율 |
| `complaints` | 기존 상세 배열, 최대 20개 | 유형별 통화 수 |

- 페르소나는 **통화가 실제 사용한 버전 번호**를 보관해 전송한다. 통화 종료 시점의 현재 ACTIVE를 다시 조회해 대신 보내지 않는다. 표시용 `version: 2`나 페르소나 유형 번호와 다르다.
- 접수는 `order_parcels` 단위다. 주문 하나에 확정 배송 상세 3개면 3건이며, **결제 대기라도 상담에서 정보가 확정되었으면 포함**한다. 수집 중인 미완료 상세는 제외한다.
- 접수 시간은 백엔드가 **접수가 있는 통화 전체 시간 합계 / 같은 통화의 접수 건수 합계**로 계산한다. 180초 통화에서 2건 접수하면 90초/건이다. AI가 접수 전용 소요시간을 따로 보내지 않는다.
- `faqAnswerCount`, `orderLookupCount`, `cancelledParcelCount`, `hasHandoffRequest`, `hasCallbackRequest`, `repeatQuestionCount` 등 다른 기존 필드는 그대로 사용한다.
- `dropoffStage`, `totalWaitMs`, `latencyStats`를 기존 `analysis` 안에 추가하면 400이다. 별도 API로 보낸다. 기존 분석에 나중에 고객 구분/건수/불편 등을 추가하거나 변경하면 기존과 같이 409다.

### 불편 표현 유형

화면의 여섯 유형은 고객 불편 판정이며 **RAG 검색 성공·미답변 reason과 독립**이다. `UNSUPPORTED_ANSWER`를 `KB_NO_ANSWER`와 자동 연결하지 않는다. `SLOW_RESPONSE`도 단순 시간 임계값 초과가 아니라 고객 불편에 대한 AI 판정이다.

| `complaints[].type` | 표시 | 호환 |
| --- | --- | --- |
| `INFORMATION_RECOGNITION_ERROR` | 정보 인식 오류 | 신규 |
| `INTENT_RECOGNITION_ERROR` | 용건 인식 오류 | 신규 |
| `UNSUPPORTED_ANSWER` | 근거 없는 답변 | 신규 |
| `SLOW_RESPONSE` | 응답 지연 | 기존 |
| `INTERRUPTION` | 말 끊김 | 신규 |
| `DISSATISFACTION_EXPRESSION` | 불만 표현 | 신규 |
| `REPEATED_QUESTION` | 반복 질문 | 기존 유지 |
| `SPEAKING_TOO_FAST` | 말이 빠름 | 기존 유지 |
| `RECOGNITION_FAILURE` | 인식 실패 | 기존 유지 |
| `AI_REFUSAL` | 고객의 AI 상담 거부 | 기존 유지 |

항목 형식은 그대로다.

```json
{
  "type": "INFORMATION_RECOGNITION_ERROR",
  "evidenceText": "주소를 잘못 알아들어 고객이 불편함을 표현함",
  "offsetSeconds": 31,
  "utteranceOrders": [3, 4]
}
```

`evidenceText`는 공백 아닌 최대 1,000자, `offsetSeconds`는 정수 초 또는 null, `utteranceOrders`는 중복 없는 양의 int32 배열이다. `hasComplaint=true`이면 1개 이상, false/null이면 `[]`여야 한다. 같은 통화·유형에 여러 근거를 저장할 수 있지만 대시보드에서는 해당 유형의 통화 한 건으로 센다. 기존 유형을 새 유형으로 강제 변환하지 않는다.

## 3. 이탈 단계 전송

```http
POST /api/ai/calls/123/stage-metrics
```

```json
{
  "providerCallId": "rtc_original_session_id",
  "dropoffStage": "RECIPIENT_INFO"
}
```

| `dropoffStage` | 의미 |
| --- | --- |
| `SENDER_INFO` | 발신자 정보 확인 중 이탈 |
| `RECIPIENT_INFO` | 수신자 정보 확인 중 이탈 |
| `ITEM_INFO` | 물품 정보 확인 중 이탈 |
| `CONFIRMATION` | 접수 정보 최종 확인 중 이탈 |
| `PAYMENT_GUIDANCE` | 결제 안내 중 이탈 |
| `FAQ_ANSWER` | FAQ 답변 중 이탈 |
| `ORDER_LOOKUP` | 접수 내역 조회·안내 중 이탈 |
| `ORDER_CANCEL` | 주문 취소 처리 중 이탈 |
| `NONE` | 이탈 없이 종료한 것으로 판정 |

확정 단계 **하나**만 전송한다. `entered`, `abandoned`, 단계별 배열·진입 횟수는 받지 않는다. `NONE`은 판정한 정상 종료이며, 미전송은 미판정이다. 모르겠다는 의미로 NONE을 보내지 않는다. NULL은 받지 않으며 판정하지 못했으면 해당 항목을 전송하지 않는다.

전체 이탈률과 단계별 이탈률의 분모는 모두 **판정 완료 종료 통화 수**다. 단계 진입 건수를 수집하지 않으므로 단계 진입 대비 이탈률은 계산하지 않는다.

## 4. 대기시간·레이턴시 전송

```http
POST /api/ai/calls/123/response-wait-metrics
```

```json
{
  "providerCallId": "rtc_original_session_id",
  "totalWaitMs": 12000,
  "latencyStats": [
    { "processType": "CUSTOMER_LOOKUP", "totalLatencyMs": 2000, "measurementCount": 2 },
    { "processType": "ADDRESS_LOOKUP", "totalLatencyMs": 6000, "measurementCount": 3 }
  ]
}
```

| 필드 | 타입·검증 |
| --- | --- |
| `totalWaitMs` | 0~9,007,199,254,740,991 정수 밀리초. 전체 통화에서 고객이 기다린 구간의 합집합 길이 |
| `latencyStats` | 필수 배열, 최대 7개. 같은 processType 중복 불가 |
| `latencyStats[].processType` | 아래 7개 코드 중 하나 |
| `latencyStats[].totalLatencyMs` | 같은 유형의 레이턴시 합계, 0~9,007,199,254,740,991 정수 밀리초 |
| `latencyStats[].measurementCount` | 실제 측정 횟수, 1~2,147,483,647 정수 |

| `processType` | 표시 |
| --- | --- |
| `CUSTOMER_LOOKUP` | 고객 조회 |
| `INFORMATION_INPUT` | 정보 입력 |
| `FAQ_LOOKUP` | FAQ 조회 |
| `ORDER_LOOKUP` | 접수 내역 조회 |
| `ORDER_CANCEL` | 주문 취소 |
| `ADDRESS_LOOKUP` | 주소 조회 |
| `ORDER_SAVE` | 접수 저장 |

- 병렬 작업의 겹친 대기 구간은 **AI가 중복을 제외**해 `totalWaitMs`를 만든다. 백엔드는 합계만 받으므로 겹침을 재계산할 수 없다.
- 유형별 레이턴시 합계와 전체 대기는 별도다. 병렬 구간 때문에 유형별 합이 `totalWaitMs`와 같을 필요는 없다. 위 숫자는 예시다.
- 유형별 평균은 `SUM(totalLatencyMs) / SUM(measurementCount)`다. 평균값만 보내지 않는다.
- 미측정 유형은 배열에서 생략한다. `measurementCount: 0`은 허용하지 않는다. 측정 결과 대기가 없으면 `totalWaitMs: 0, latencyStats: []`로 보낸다. 측정 자체를 하지 못했으면 API를 전송하지 않는다.
- 모든 본문 필수값에 null·숫자 문자열을 허용하지 않는다. P95·개별 원본 표본·임의 필드는 받지 않는다.
- 새 최종값의 `totalWaitMs`가 현재 통화 전체 시간(PBX 우선, AI 시각 대체)을 넘으면 422이며 저장하지 않는다.
- 이미 저장한 동일 값은 나중에 PBX 통화시간이 짧게 보정돼도 204다. 사후에 대기 > 통화시간이 된 건은 대시보드가 `invalidWaitCallCount`로 알려주고 대기 집계에서 제외한다. 저장값을 자동 변경하지 않는다.

## 5. 재전송·오류

새 두 API는 **항목별 최종값을 한 번 확정**한다. `Idempotency-Key`는 필요 없다. 통화와 항목별 정규화 해시로 판별한다. JSON 키 순서와 `latencyStats`의 유형 배열 순서가 달라도 같은 내용이다. 값이 바뀐 요청은 누적하거나 덮어쓰지 않는다. 최초 수신 시각·성공 감사도 같은 재전송으로 갱신하지 않는다.

이 배열 순서 규칙은 새 레이턴시 API에만 해당한다. 기존 `analysis.complaints` 배열 순서·근거 원문의 재전송 규칙은 ANL-01 그대로다.

| HTTP | code | 처리 |
| --- | --- | --- |
| 204 | 없음 | 최초 또는 동일 값 성공. JSON 파싱하지 않음 |
| 400 | `INVALID_REQUEST` | 필수값·타입·코드·중복 유형·알 수 없는 필드 확인 |
| 401 | `UNAUTHORIZED` | AI 수집 토큰 누락/불일치/중복 Authorization 확인 |
| 403 | `FORBIDDEN` | 경로 통화 번호와 providerCallId 확인 |
| 404 | `NOT_FOUND` | 미존재·soft delete·5년 만료 통화. 새 통화를 대신 만들지 않음 |
| 409 | `INVALID_STATE` | 기존 analysis 저장 전. 분석 성공 후 같은 항목 재전송 |
| 409 | `EVENT_PAYLOAD_CONFLICT` | 같은 항목에 이미 다른 최종값이 존재. 무한 재전송 중단·내용 확인 |
| 422 | `VALIDATION_FAILED` | 새 전체 대기가 통화시간보다 큼. 집계 기준 확인 |
| 500 | `INTERNAL_ERROR` | 저장 실패. 동일 최종값으로 재시도 가능 |
| 503 | `DEPENDENCY_UNAVAILABLE` | AI_INSIGHTS_TOKEN 미설정 등 의존성 확인 |

오류는 `{ error: { code, message, details }, meta: { requestId } }`다. 응답 `X-Request-Id`로 추적하고 토큰·원문·고객 정보를 일반 로그에 남기지 않는다.

## 6. 저장·배포·비교 기준

- 새 앱 실행 전 migration **050 한 번**을 팀 runner로 적용한다. 001~049는 수정하지 않았다. 백업·기존 연결 정리 등 기존 배포 절차를 따른다.
- `call_dashboard_metrics` 한 테이블에 통화당 한 행으로 두 항목을 독립 저장한다. 기존 분석·요약·분석 재전송 해시를 변경하지 않는다.
- 통화 soft delete를 따라 모든 대시보드에서 숨긴다. 최초 수신 `incoming_at`부터 5년의 기존 실제 폐기 작업이 분석을 삭제할 때 신규 지표도 CASCADE 삭제한다. 로그성 7일 TTL 대상이 아니다.
- 비교용 `ai_persona_versions.previous_active_version_seq` 한 컬럼을 추가한다. 활성화 성공 트랜잭션에서 직전 ACTIVE 버전을 보존하므로 AI가 별도 비교 번호를 보낼 필요는 없다.
- 막대는 **현재 운영 버전 vs 그 버전 활성화 직전의 운영 버전**만 비교한다. 같은 페르소나 v1→v2도 구분한다. 첫 활성화 또는 확인 불가능한 과거 이력은 비교 대상 null이다. 최신 생성/PENDING 버전을 대신 선택하지 않는다.
- 별도 AI·프론트 소스 수정과 실제 서버 migration·배포·상호 호출은 이번 백엔드 작업에 포함하지 않았다.
