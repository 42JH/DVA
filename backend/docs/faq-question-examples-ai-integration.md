# AI 연동: FAQ 고객 질문 사례

## AI 파트에 전달할 내용

새 API는 없다. 통화 종료 후 실제 답변과 검색 근거를 대조해 질문·답변 한 쌍마다 기존 `FAQ_ANSWERED` 이벤트 하나를 전송한다. 사용한 FAQ 번호는 `faqEntrySeqs` 배열로 보낸다. 백엔드가 연결된 고객 발화 원문을 각 FAQ의 질문 사례로 복사한다. `questionText` 같은 추가 요청 필드는 보내지 않는다.

예를 들어 FAQ 12·15를 사용했다면 한 이벤트에 `faqEntrySeqs: [12, 15]`를 보낸다. 질문·답변 `UTTERANCE`도 각각 한 번만 전송한다. 하나의 실제 응대 결과에 UUID·통화 전체 순번도 하나씩 사용한다.

같은 응대를 배열 이벤트와 FAQ별 개별 이벤트로 이중 전송하지 않는다. 백엔드는 서로 다른 이벤트의 같은 질문도 별도 사례로 취급한다.

## 수집 API

- `POST /api/ai/calls/{callSessionSeq}/events`
- `Authorization: Bearer <AI_INSIGHTS_TOKEN>`
- `Content-Type: application/json`
- 성공: `204 No Content`. 사례 번호를 반환하지 않는다.
- 기존 `providerCallId` 결속, 요청당 1~50개·JSON 100KiB, 통화 전체 순번, 참조·재전송 규칙은 유지한다.

기존 [이벤트 전체 계약](../../docs/api/call-events.md)을 따르며 다음은 질문·답변과 FAQ 결과를 함께 보내는 예시다. 번호·UUID·발생 시각은 실제 통화의 값으로 바꾼다.

```json
{
  "providerCallId": "rtc_example_call",
  "events": [
    {
      "eventId": "c05bad94-2b41-4c92-89d3-b8dc66c6d851",
      "eventOrder": 10,
      "kind": "UTTERANCE",
      "occurredAt": "2026-11-05T03:00:00.000Z",
      "offsetSeconds": 30,
      "payload": {
        "utteranceOrder": 5,
        "speaker": "CUSTOMER",
        "utteranceText": "수거 기사님은 늦어도 몇 시까지 오세요?",
        "lastSentenceSeq": 1
      }
    },
    {
      "eventId": "f64c08ec-fad1-41fd-a6e5-ae1e24459165",
      "eventOrder": 11,
      "kind": "UTTERANCE",
      "occurredAt": "2026-11-05T03:00:05.000Z",
      "offsetSeconds": 35,
      "payload": {
        "utteranceOrder": 6,
        "speaker": "AI",
        "utteranceText": "수거 가능 시간은 오전 9시부터 오후 5시까지입니다.",
        "lastSentenceSeq": 1
      }
    },
    {
      "eventId": "0cecfcd0-eb16-4b27-abf8-2532ecb48e2f",
      "eventOrder": 12,
      "kind": "BUSINESS_RESULT",
      "occurredAt": "2026-11-05T03:00:05.000Z",
      "offsetSeconds": 35,
      "payload": {
        "action": "FAQ_ANSWERED",
        "orderSeq": null,
        "unansweredQuestionSeq": null,
        "summaryText": "FAQ로 수거 시간 안내 완료",
        "faqEntrySeqs": [12, 15],
        "questionUtteranceOrder": 5,
        "answerUtteranceOrder": 6
      }
    }
  ]
}
```

위 예시는 통화 처리 결과 한 건이며, FAQ 12·15 각각에 동일 질문 사례가 한 개씩 저장된다. FAQ 하나만 사용했을 때도 `[12]`로 보내면 된다.

## 값·중복·오류 규칙

| 항목 | 계약 |
|---|---|
| `faqEntrySeqs` | 실제 답변 근거로 사용한 FAQ 번호 1~100개. 양의 int32, 배열 내 중복 불가. 검색에만 노출된 FAQ는 넣지 않는다. 배열 순서는 의미가 없으며 서버에서 오름차순으로 정규화한다. |
| 기존 `faqEntrySeq` | 단건 호환용. `faqEntrySeqs`와 둘 중 하나만 보낸다. 둘 다 보내거나 둘 다 없으면 400이다. 신규 연동은 배열을 사용한다. |
| 질문·답변 발화 | 같은 통화의 완결 발화. 같은 요청 묶음 또는 이전에 저장된 발화를 참조한다. 질문은 CUSTOMER, 답변은 AI여야 한다. |
| 원문 | 고객 `UTTERANCE.utteranceText`를 그대로 사용한다. 공백·줄바꿈도 보존하고 최대 20,000자다. 한 발화에 질문이 여러 개면 발화 전체가 사례로 표시된다. |
| `occurredAt` | 실제 FAQ 응대 발생 시각. 사후 분석·HTTP 전송 시각으로 바꾸지 않는다. 시간대 포함 ISO 8601이다. |
| 같은 문장·발화 | 서로 다른 응대 이벤트이면 별도 사례로 저장한다. 문장이나 발화 번호 조합으로 중복 제거하지 않는다. |
| 동일 발생 재전송 | 원래 `eventId`·`eventOrder`·내용·최초 단건/배열 형식을 유지한다. 배열 순서만 바뀐 것은 동일하게 처리한다. 동일 재전송은 204이며 사례 추가·삭제 복구·보존 기간 연장을 하지 않는다. |
| 같은 식별자의 다른 내용 | 기존처럼 409 `EVENT_PAYLOAD_CONFLICT`, 이번 묶음 전체 롤백. |
| 질문·답변 발화 누락 | 404 `NOT_FOUND`, 이번 묶음 전체 롤백. 발화와 결과를 같이 보내거나 발화 저장 성공 후 결과를 전송한다. |
| 질문·답변 화자 오류 | 422 `VALIDATION_FAILED`, 이번 묶음 전체 롤백. |
| 추가 `questionText` 필드 | 400 `INVALID_REQUEST`. 새 수집 필드가 아니다. |

## FAQ 사례 저장 정책

- FAQ별 실제 응대 발생 시각이 최신인 10개만 유지한다. 같은 시각은 백엔드 사례 번호 내림차순이다. 11개 이상이면 가장 오래된 사례를 물리 삭제한다.
- 사례는 발생부터 5년까지 보관한다. 5년이 지난 사례는 즉시 조회에서 제외하고 기존 보관 워커가 물리 삭제한다.
- FAQ가 실제로 수정되거나 삭제되면 사례를 전부 삭제한다. 내용·분류·수정자 등 저장값이 모두 같은 요청은 기존 수정 시각·사례를 유지한다.
- FAQ 수정 시각보다 이전에 발생한 지연 이벤트, 삭제·미존재 FAQ, 이미 5년이 지난 응대는 FAQ 사례에 추가하지 않는다. 유효한 통화·발화이면 원본 이벤트는 기존처럼 저장하고 204를 반환한다.
- 배열에 현재 FAQ와 삭제·수정된 FAQ가 섞이면 FAQ별로 위 조건을 판정한다. 적격 FAQ에는 사례를 저장하고 원본 처리 결과에는 사용 FAQ 번호 전체를 유지한다.
- 따라서 204가 해당 질문의 FAQ 화면 노출을 보장하지는 않는다. 이미 최신 10개에서 밀린 사례도 원본 이벤트 저장에는 성공할 수 있다.
- 이미 저장된 질문 텍스트는 통화 soft delete·물리 삭제 이후에도 남는다. 삭제·만료된 통화에 **새 이벤트를 수집하는 규칙**은 기존 404를 유지한다.
- FAQ 사례 추가는 FAQ 본문·수정 시각·AI FAQ 갱신 알림을 바꾸지 않는다. 통화 요약 `faqAnswerCount`도 이벤트 개수로 재계산하지 않는다.
- 과거 이벤트의 사례 소급 생성은 하지 않는다. 기존 이벤트를 재전송해도 새 사례를 만들지 않는다.

## 배포

백엔드 앱 교체 전에 migration `052-faq-question-examples.sql`을 적용한다. 새 백엔드 배포 후 `faqEntrySeqs` 배열 전송으로 전환한다. 기존 단건 요청·토큰·204 응답은 유지한다. 이 문서는 해당 기능에 한정하며 미답변 수집·RAG 구현·다른 통화 지표 계약은 변경하지 않는다.
