# 프론트 연동: FAQ 상세 고객 질문 사례

## 프론트 파트에 전달할 내용

기존 관리자 FAQ 상세 `GET /api/faqs/{faqEntrySeq}`의 `data.recentQuestions`가 추가된다. 별도 API 호출 없이 이 배열을 FAQ 답변 아래에 최신순으로 표시한다. 최대 10개이며 동일 문장도 서로 다른 사례로 표시한다.

## API와 응답

- `GET /api/faqs/{faqEntrySeq}`
- 기존 관리자 세션 쿠키 사용. OPERATOR·SUPERVISOR·SYSTEM_ADMIN 모두 조회 가능.
- 성공 200, 기존 `data`·`meta` envelope와 FAQ 필드는 유지한다.
- 사례가 없으면 `recentQuestions: []`이며 null을 반환하지 않는다.

```json
{
  "data": {
    "faqEntrySeq": 12,
    "question": "방문 수거는 몇 시까지 오나요?",
    "answer": "수거 가능 시간은 오전 9시부터 오후 5시까지입니다.",
    "updatedAt": "2026-11-05T02:00:00.000Z",
    "category": "수거 일정",
    "createdAt": "2026-11-01T02:00:00.000Z",
    "updatedByAdminUserSeq": 1,
    "recentQuestions": [
      {
        "faqQuestionExampleSeq": 101,
        "questionText": "수거 기사님은 늦어도 몇 시까지 오세요?",
        "occurredAt": "2026-11-05T03:00:05+00:00"
      },
      {
        "faqQuestionExampleSeq": 100,
        "questionText": "오늘 수거하러 오시는 시간대가 어떻게 돼요?",
        "occurredAt": "2026-11-05T02:30:05+00:00"
      }
    ]
  },
  "meta": {
    "requestId": "example-request-id"
  }
}
```

| 추가 필드 | 타입 | 의미 |
|---|---|---|
| `recentQuestions` | array, 0~10개 | 실제 FAQ 응대 발생 시각 내림차순. 같은 시각은 사례 번호 내림차순. |
| `faqQuestionExampleSeq` | 양의 정수 | 렌더링 key로 사용할 사례 번호. |
| `questionText` | 문자열 | 실제 고객 발화 원문. 공백·줄바꿈 보존, 최대 20,000자. |
| `occurredAt` | ISO 8601 문자열 | 실제 FAQ 응대 발생 시각. 시간대 포함, 소수 초가 생략될 수도 있다. |

## 화면 처리

- 배열 순서를 그대로 사용한다. 동일 문장을 합치거나 중복 제거하지 않는다. 렌더링 key는 `questionText` 대신 `faqQuestionExampleSeq`를 사용한다.
- 발화는 일반 텍스트로 표시한다. HTML 삽입이나 Markdown 변환을 하지 않는다.
- 사례 수는 `recentQuestions.length`로 알 수 있다. 이는 현재 보관 중인 사례 수이며 FAQ 전체 사용 횟수가 아니다.
- AI 전송은 통화 종료 후 이루어진다. 기존 상세 재조회로 최신 사례를 받으며, 이 기능에 별도 SSE·폴링 API는 추가하지 않는다.
- FAQ 수정 성공 후 기존처럼 상세를 재조회한다. 저장값이 실제로 바뀌었다면 `recentQuestions`는 빈 배열이다. 저장값이 모두 같으면 기존 수정 시각·사례를 유지한다.
- FAQ 삭제 후 상세는 기존처럼 404이며 사례도 함께 삭제된다.

## 보관과 영향 범위

- FAQ별 최신 10개만 유지한다. 11번째가 들어오면 가장 오래된 사례가 삭제된다.
- 각 사례는 실제 응대 발생 시각부터 최대 5년 보관하고 만료된 사례는 조회에서 제외한다.
- 통화 soft delete·물리 삭제는 이 배열의 텍스트를 지우지 않는다. 따라서 통화 상세로 연결하기 위한 통화 번호는 제공하지 않는다.
- FAQ 수정 전 발생한 사례가 늦게 전송되어도 다시 추가하지 않는다. 과거 이벤트의 소급 생성도 하지 않아 초기에는 빈 배열일 수 있다.
- 기존 `GET /api/faqs` 목록의 응답·검색·페이지·`total_count`는 변경하지 않는다. 목록에서 항목을 선택한 뒤 상세를 조회하면 된다.
- AI FAQ 원본 목록 응답도 변경하지 않는다. 고객 질문 사례는 관리자 상세에만 제공한다.
- 통화 요약 `faqAnswerCount`는 이벤트/FAQ 번호 개수로 재계산하지 않는다.

## 같은 FAQ 이벤트를 표시하는 통화 처리 결과 화면

`GET /api/calls/{callSessionSeq}/processing-results`에는 `faqEntrySeqs: number[] | null`이 추가된다. FAQ 응대 한 건에 여러 번호를 담을 수 있으므로 사용 FAQ 표시는 이 배열을 사용한다. 기존 단건 이벤트도 `[12]`처럼 조회된다. FAQ 응대가 아닌 결과는 null이다.

기존 `faqEntrySeq`도 유지한다. 사용 FAQ가 하나이면 그 번호, 복수 FAQ이면 null이다. 질문·답변 발화·원문은 기존 필드를 사용하고 한 응대 결과는 목록 한 건으로 표시한다. FAQ 상세의 `recentQuestions` 형식에는 영향이 없다.

## 배포

migration `052-faq-question-examples.sql`과 새 백엔드를 먼저 적용한다. 구버전 백엔드에 프론트를 먼저 배포해야 하면 과도기 동안 `data.recentQuestions ?? []`로 처리한다. 새 백엔드의 정식 계약은 항상 배열이다.
