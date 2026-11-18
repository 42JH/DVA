# UNQ-03 FAQ 전환 / UNQ-04 미답변 삭제

두 API는 ACTIVE OPERATOR·SUPERVISOR·SYSTEM_ADMIN의 dva_session 쿠키와 허용 Origin이 필수다.
프론트는 credentials: include를 사용한다. AI 서비스 토큰만으로 호출할 수 없다.
기존 목록은 [UNQ-02](unanswered-questions-read-spec.md), AI 수집은 [UNQ-01](unanswered-questions.md)을 따른다.
027 migration까지 적용한 뒤 새 앱을 실행한다. 실제 DB 적용은 이번 작업에서 제외한다.

## UNQ-03 미답변을 FAQ로 전환

| 항목 | 계약 |
| --- | --- |
| API | POST /api/unanswered-questions/{id}/faqs |
| id | 기존 unansweredQuestionSeq. 양의 int32 |
| 방향 | 관리자 프론트 → 백엔드 |
| 성공 | 204, 본문 없음. Location: /api/faqs/{faqEntrySeq} |
| 단위 | 질문 하나에서 새 FAQ 하나 생성 |

```json
{
  "category": "수거 일정",
  "question": "주말에도 택배를 수거하나요?",
  "answer": "수거 가능한 일정은 접수 시 확인해 안내합니다."
}
```

category·question·answer 모두 필수다. 이전 초안의 질문 생략·원문 대체는 제공하지 않는다.
category는 접수 / 수거 일정 / 물품·박스 / 포장·파손 / 배송·운송장 / 주소 / 변경·취소 / 요금·결제 / 이용 안내 / 기타 중 하나다.
전체·null·허용값 외 분류는 400이다. 질문 최대 1,000자, 답변 최대 20,000자이며 공백뿐인 값·NUL·추가 필드는 거절한다.
질문·답변의 공백·줄바꿈은 보존하며 공통 JSON 본문 100KiB 제한을 적용한다.
관리자가 답변을 작성한다. 이 API에서 AI 답변 생성을 요청하지 않는다.

### 트랜잭션과 재시도

1. 미답변 행을 FOR UPDATE로 읽는다. 없으면 404, DELETED이면 409다.
2. OPEN이면 기존 FAQ 생성 기능을 같은 PoolClient로 실행한다. FAQ·FAQ_CREATED 감사·기존 INSERT 알림 대기를 저장한다.
3. 질문을 REGISTERED로 바꾸고 faq_entry_seq·registered_at·faq_conversion_hash를 저장한다.
   UNANSWERED_QUESTION_REGISTERED 성공 감사도 같은 트랜잭션에 저장한다.
4. 어느 저장 단계든 실패하면 새 FAQ·알림 대기·질문 변경·성공 감사를 함께 롤백한다. 실패 감사는 기존 정책대로 별도로 남을 수 있다.
5. 수집한 question_text·event_id·payload_hash·발생 시각·위치는 변경하지 않는다. 다듬은 질문은 FAQ에만 저장한다.
6. REGISTERED의 동일 category·question·answer 재전송은 기존 FAQ가 존재하면 같은 Location과 204다.
   비교는 고정 키 순서의 최종 세 필드 해시다. 문자열 공백·줄바꿈 차이는 다른 내용이며 JSON 키 순서·관리자·requestId는 비교값에 넣지 않는다.
7. 다른 내용으로 재전환하거나 연결 FAQ가 삭제됐다면 409다. FAQ를 새로 만들거나 질문을 OPEN으로 복원하지 않는다.
8. 동일 재전송에는 새 성공 감사·알림·처리 시각을 추가하지 않는다. 이후 일반 FAQ 수정 내용을 되돌리지 않는다.
9. 질문 행 잠금으로 여러 앱 인스턴스의 동시 전환·삭제를 직렬화한다. 같은 내용은 FAQ 하나, 다른 내용은 첫 전환만 성공한다.

별도 Idempotency-Key를 요구하지 않는다. 같은 문장인 서로 다른 미답변의 전환을 자동 합치지 않는다.
관리자 목록은 기본 OPEN이므로 전환 후 빠지고 status=REGISTERED로 조회할 수 있다.
기존 [FAQ 추가·수정](faqs.md)도 분류·질문·답변이 모두 필수다.

### AI 연동

기존 AI 알림 POST /internal/faqs/refresh와 eventId·operation·faqEntrySeqs 계약을 재사용한다.
AI 목록·상세 응답은 기존 faqEntrySeq·question·answer·updatedAt만 반환한다. category 필드·query를 추가하지 않는다.
관리자 목록·상세와 DB에서만 분류를 제공한다. AI 알림에도 분류·질문·답변을 추가하지 않는다.
AI_FAQ_TOKEN 미설정·AI 서버 중단은 DB 등록을 취소하지 않는다. 기존 워커가 커밋 후 전송·재시도한다.
204는 DB 등록 완료이며 AI의 202도 알림 수신 확인이다. 실제 검색 반영 완료를 뜻하지 않는다.

## UNQ-04 미처리 미답변 삭제

| 항목 | 계약 |
| --- | --- |
| API | DELETE /api/unanswered-questions/{id} |
| id | 기존 unansweredQuestionSeq. 양의 int32 |
| Request | 본문 없음. 빈 객체 외 본문 필드는 400 |
| 성공 | 204, 본문 없음 |

OPEN 행을 잠근 뒤 question_text를 null로 비우고 status=DELETED·deleted_at을 저장한다.
UNANSWERED_QUESTION_DELETED 성공 감사와 함께 커밋하며 감사 실패 시 원문·상태도 롤백한다.
event_id·payload_hash·통화·발생 시각·위치는 보존한다. 같은 AI 발생이 재전송돼도 원문을 복구하지 않는다.
이미 DELETED면 변경·성공 감사 추가 없이 204다. REGISTERED면 409, 미존재면 404다.
목록에서는 제외되고 통화 처리 결과의 연결 questionText는 null이다. 기존 통화 스크립트·녹취·FAQ는 보존한다.
전체·복수 삭제 API는 추가하지 않는다. 전환과 삭제가 경쟁하면 먼저 처리한 상태만 커밋하고 반대 요청은 409다.

## 오류·검증

| HTTP | code | 조건 |
| --- | --- | --- |
| 400 | INVALID_REQUEST | 번호·필수 분류/질문/답변·추가 필드·삭제 본문 오류 |
| 401 | UNAUTHORIZED | 활성 관리자 세션 없음·오류·만료 |
| 403 | FORBIDDEN | 관리자 권한 또는 Origin 오류 |
| 404 | NOT_FOUND | 미답변 질문 없음 |
| 409 | INVALID_STATE | 삭제·전환 상태, 다른 전환 내용 또는 전환 FAQ 삭제 |
| 413 | PAYLOAD_TOO_LARGE | 본문 100KiB 초과 |
| 500 | INTERNAL_ERROR | DB·감사·알림 대기 저장 실패. 업무 변경 전체 롤백 |

오류는 기존 error/meta 형식이며 성공·오류에 X-Request-Id와 Cache-Control: no-store를 제공한다.
질문·답변·토큰·해시는 HTTP 로그·감사 metadata에 복사하지 않는다.
검증은 필수 입력·권한, 두 인스턴스 동시 전환·삭제, 각 저장 단계 롤백, 삭제·FAQ 수정/삭제 뒤 재전송,
기존 스크립트·연결 처리 결과, 성공 감사·알림 중복 방지, AI 응답 형식과 기존 FAQ 회귀를 포함한다.
