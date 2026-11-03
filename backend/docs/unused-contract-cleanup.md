# 미사용 계약 제거 연동 안내

## AI

- `GET /api/ai/faqs/{id}`를 제거한다. 단건도 `GET /api/ai/faqs?faqEntrySeqs={id}`로 요청한다.
- 목록 응답은 `{ data: [...], hasNext, total_count }`다. 삭제·미존재 번호는 빈 목록 200이며 관리자 식별자는 포함하지 않는다.
- 전체 원본 조회, 최대 100개 번호 필터, FAQ 변경 알림·삭제 동기화는 기존과 같다. 현재 AI 클라이언트는 목록 경로를 사용한다.

## 프론트

- 권한 변경은 `PATCH /api/admins/{id}`에 `{ "role": "OPERATOR" }` 또는 `{ "role": "SUPERVISOR" }`를 전달한다. `/role` 전용 경로는 제거한다.
- 인증·Origin·SYSTEM_ADMIN 권한과 감사 트랜잭션은 유지한다. `status`를 생략하면 계정 상태를 유지한다.
- 관리자 FAQ 상세 `GET /api/faqs/{id}`는 유지한다.
- 통화 목록의 각 항목과 상세 `data.call`에서 `endReason`, `handoff`를 제거한다. `endReason`, `handoffStatus` 목록 필터도 제거하며 전달하면 400이다.
- 상담원 연결 요구는 목록의 `analysis.hasHandoffRequest`, 상세의 `data.analysis.hasHandoffRequest`로 조회한다. null은 미수집, true/false는 요청 있음/없음이며 연결 성공 여부는 아니다. AI 입력과 이벤트 `HANDOFF_REQUESTED`는 유지한다.
- 현재 develop-fe의 `frontend/src/features/call/api/callDto.ts`, 해당 테스트·mock에 예전 `endReason`·`handoff` 타입이 남아 있다. 프론트 작업에서 함께 제거한다. 이번 변경은 프론트 파일을 수정하지 않는다.

## DB 전환

- `047-remove-unused-schema.sql` 한 파일로 `company_pins.search_text`, `call_sessions.end_reason`, `handoff_requests`를 제거한다. 이전에 적용한 migration 파일은 수정하지 않는다.
- 회사 PIN의 주소·부서·식별자와 개인 PIN의 검색 생성 컬럼은 유지한다. 통화 시각 CHECK를 다시 만들고 나머지 FK·업무 트리거를 보존한다. 최종 public 테이블 28개, FK 24개, 업무 트리거 10개다.
- 삭제 컬럼과 레거시 테이블에 기존 값이 있으면 실제로 소실된다. 기존 앱·워커 중지 → DB 백업 → 기존 runner로 047까지 한 트랜잭션 적용 → `infra/database/verify.sql` → 새 앱 시작 순서다. 운영 DB 적용은 이 작업에 포함하지 않는다.
- 구버전 앱은 삭제한 컬럼·테이블을 조회하므로 새 DB와 함께 실행하지 않는다. 복구가 필요하면 앱·DB를 백업 시점에 맞춰 함께 복원한다.
- `has_handoff_request` 요약, AI 이벤트, 주문·통화·녹취·STT의 보존 기간과 soft delete는 그대로 유지한다.
