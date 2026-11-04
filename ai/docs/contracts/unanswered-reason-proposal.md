# 백엔드 전달용: 통화 종료 후 미답변 reason (S15P31D109-159)

상태: **계약 확인·사용자 백엔드 배포 완료 확인 / AI 배포 대기**. `origin/develop-backend` **fbbaca1**(2026-11-04)의 `feature/unanswered-reasons` 병합을 확인했다. 아래 형식과 두 사유 값은 실제 DTO·API 문서와 일치한다. 최신 원문은 [수집 계약](../be-contract/backend/unanswered-questions.md), [사유 연동](../be-contract/backend/unanswered-question-reasons.md)에 보관한다.

기존 `POST /api/ai/unanswered-questions`의 선택 필드 reason으로 아래와 같이 전송합니다. 통화 종료 후 한 질문당 한 요청입니다. 기존 인증·경로·응답·발생 ID 규칙은 유지합니다.

```json
{
  "eventId": "8d4e5cb5-d474-4e8a-904a-868304187e03",
  "callSessionSeq": 120,
  "providerCallId": "rtc_example_120",
  "questionText": "기사님 성별을 지정할 수 있나요?",
  "occurredAt": "2026-11-04T10:01:20+09:00",
  "offsetSeconds": 80,
  "reason": "KB_NO_ANSWER"
}
```

| 값 | 의미 |
| --- | --- |
| KB_NO_ANSWER | 검색은 정상 처리됐지만 실제 AI가 해당 문의를 끝내 안내하지 못함. 검색 결과가 존재하는 경우도 포함 |
| KB_UNAVAILABLE | 검색 시스템 장애·시간 초과 등으로 실제 AI가 해당 문의를 끝내 안내하지 못함 |

`KB_NO_ANSWER`는 DB에 관련 자료가 절대로 없다는 단정이 아닙니다. Live가 답하지 못한 최종 결과입니다. 이후 같은 통화에서 해결되면 수집하지 않습니다. 종료 후 판정기 자체의 실패는 두 사유 중 하나로 보내지 않습니다.

확인된 계약:

1. reason은 선택이며 위 두 값과 null을 허용합니다. 생략/null은 미분류입니다. UNCLASSIFIED는 조회 필터 전용이라 전송하지 않습니다.
2. 명시한 reason은 동일 eventId의 본문 비교에 포함됩니다. 재전송 중 값 변경·삭제는 409입니다. 과거 미분류 건을 같은 eventId로 사후 분류하지 않습니다.
3. 관리자 목록에 reason, 통화 처리 결과에 unansweredReason을 반환합니다. OPEN/REGISTERED/DELETED 업무 상태와 별개입니다.
4. 새 migration 049와 백엔드 코드가 병합됐고, 사용자가 백엔드 배포 완료를 확인했습니다. **운영 DB 백업 → 049 적용 → 새 BE 배포 → AI 활성화** 순서를 따릅니다. AI가 운영 DB·실제 수집 API를 직접 검사한 것은 아닙니다.

기존 `QUESTION_UNANSWERED` 이벤트에는 반환된 unansweredQuestionSeq를 연결합니다. 사유를 summaryText로 우회 전송하거나 고객 원문을 이벤트 요약에 중복 복사하지 않습니다.

AI는 검토 원본과 판정을 Outbox에 보관하며 같은 eventId·질문·시각·reason으로 재전송합니다. 전송 형식의 변경은 필요하지 않았습니다. 사용자 백엔드 배포 확인과 가상 통화 실모델 8건 통과 후 작업 브랜치 server.toml의 두 플래그를 true로 준비했습니다. 운영 AI에는 아직 배포하지 않았습니다.
