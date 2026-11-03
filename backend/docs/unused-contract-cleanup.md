# 미사용 계약 제거 연동 안내

## AI

- `GET /api/ai/faqs/{id}`를 제거한다. 단건도 `GET /api/ai/faqs?faqEntrySeqs={id}`로 요청한다.
- 목록 응답은 `{ data: [...], hasNext, total_count }`다. 삭제·미존재 번호는 빈 목록 200이며 관리자 식별자는 포함하지 않는다.
- 전체 원본 조회, 최대 100개 번호 필터, FAQ 변경 알림·삭제 동기화는 기존과 같다. 현재 AI 클라이언트는 목록 경로를 사용한다.

## 프론트

- 권한 변경은 `PATCH /api/admins/{id}`에 `{ "role": "OPERATOR" }` 또는 `{ "role": "SUPERVISOR" }`를 전달한다. `/role` 전용 경로는 제거한다.
- 인증·Origin·SYSTEM_ADMIN 권한과 감사 트랜잭션은 유지한다. `status`를 생략하면 계정 상태를 유지한다.
- 관리자 FAQ 상세 `GET /api/faqs/{id}`는 유지한다.
