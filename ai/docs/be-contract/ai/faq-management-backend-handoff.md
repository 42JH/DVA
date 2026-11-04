# FAQ 변경 알림 연동 — 백엔드 공유 요약 v4

2026-10-30. 브랜치: feature/S15P31D109-123-faq-management.

[전체 계획서](faq-management-plan.md)는 최신 develop-backend ce92b13의 실제 계약에 맞췄습니다. 이전 v3의 임시 JSON·revision·별도 upsert/delete 수신 경로는 사용하지 않습니다.

## 확정된 건수

| 작업 | 관리자 API | AI 알림의 번호 개수 |
|---|---|---|
| 추가 | POST /api/faqs | 1~100개 |
| 수정 | PATCH /api/faqs/{id} | 정확히1개 |
| 삭제 | DELETE /api/faqs | 1~100개 |

관리자 삭제 본문은 {"faqEntrySeqs":[123]} 또는 {"faqEntrySeqs":[123,124]}입니다. DELETE /api/faqs/{id}는 없습니다.

## 백엔드 → AI

```http
POST /internal/faqs/refresh
Authorization: Bearer <AI_FAQ_TOKEN>
```

```json
{
  "eventId": "f5af1894-3e32-4c75-a2c5-768ea9e48593",
  "operation": "INSERT",
  "faqEntrySeqs": [123, 124]
}
```

operation은 INSERT/UPDATE/DELETE입니다. 질문·답변 본문과 revision은 보내지 않습니다. UPDATE의 번호 배열은 하나여야 합니다.

AI는 인증·본문 검사와 **영속 저장 후 2초 이내202**를 반환해야 합니다. 같은eventId는 중복 작업 없이202를 반환합니다. 응답 본문은 BE가 사용하지 않으며200/204는 성공이 아닙니다.202는 접수 확인이지 검색 반영 완료가 아닙니다.

AI_FAQ_TOKEN은 별도32자 이상 공백 없는 ASCII 토큰입니다. AI_PERSONA_TOKEN·관리자 쿠키를 재사용하지 않습니다.

## 추가·수정 후 필요한 원문만 조회

```http
GET /api/ai/faqs?faqEntrySeqs=123,124&limit=100&offset=0
```

AI는 받은 번호만 지정하고 q를 넣지 않습니다. 응답의 data/hasNext를 검증합니다. 반환된 최신 질문·답변으로 변경된 청크만 임베딩합니다. 요청했지만 **정상적인 전체 응답에 없는 번호는 삭제된 자료로 처리**합니다. 조회 오류나 부분 결과를 삭제로 해석하지 않습니다.

본문은 이벤트 당시 복사본이 아니라 조회 시점 최신 내용입니다. 불필요한 전체 FAQ 조회를 매 이벤트마다 하지 않습니다.

## 삭제 후 처리

DELETE는 번호로 해당FAQ의 모든 자식청크를 찾아 BM25·원문·벡터 DB에서 제거합니다. 이전/준비중 버전도 실제 삭제하고 Qdrant 잔존0건을 확인합니다. 삭제에는 임베딩을 호출하지 않습니다. 이미 없어진 벡터의 재삭제는 정상 무변경입니다.

검색 차단만 된 상태와 물리 삭제까지 끝난 상태는 구분합니다. 삭제 실패는 AI 내부 재시도로 복구하며, 옛 자료를 자동 복원하지 않습니다. 본문 없는 중복 제거·삭제 이력은 보관할 수 있습니다.

## 순서·실패·초기 이전

- BE는 원본·감사·알림 대기를 함께 커밋하고, 선행 미전송을 추월하지 않으며 같은eventId로 재시도합니다.
- AI는 영속 FIFO 큐로 조회→색인→삭제를 순차 처리합니다. 같은FAQ의 옛 수정이 삭제보다 늦게 적용되지 않게 합니다. 현재 계약에 없는 revision을 요구하지 않습니다.
-202 이후 색인 실패는 AI가 재시도합니다. 현재 계약에는 색인 완료 회신 API가 없습니다. 추가callback을 필수로 가정하지 않습니다.
- 최초32건은 초기INSERT 알림 또는 별도bootstrap이 필요합니다. 이미 데이터가 있어 초기등록을 건너뛴 경우 새알림이 생성되지 않습니다.
- 배포 전020 migration, 양쪽 AI_FAQ_TOKEN, AI_AGENT_URL과 AI 수신 API 준비를 확인합니다. 이 문서 작성에서 운영 설정은 변경하지 않았습니다.

## AI 검색 구현 범위

OpenAI large3072·원문+유효검색설명·Kiwi/BM25·RRF0.4/0.6 Top5·고정Qwen Top3는 유지합니다. 긴FAQ만 질문과 표 문맥을 보존한 자식청크로 확장하고 기존95문항과 별도 긴FAQ 평가를 수행합니다.

수신 API·영속 큐·최신 원문 조회·증분 반영·삭제·검색 연결 코드를 구현했고 실제 임베딩/Qdrant/GPU 검증을 수행했습니다.
BE 관리자 API/outbox부터의 전체 운영 검증은 배포/공유 토큰 설정 이후 진행합니다.
기본 수신/처리 플래그는 비활성으로 배포하며 기존 검색을 즉시 전환하지 않습니다.
현재 준비 상태와 팀원 역할은 [실제 전체 검증 체크리스트](faq-end-to-end-checklist.md)를 따릅니다.
