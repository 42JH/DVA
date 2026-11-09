# 미사용 계약 제거 연동 안내

파트별 전달본: [AI 현재 연동 명세](ai-integration-current.md), [프론트 현재 연동 명세](frontend-integration-current.md). 최신 호출 흐름·요청·응답·표시·오류 처리와 기존 변경을 함께 정리했다.

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
- 현재 develop-fe의 `frontend/src/features/call/api/callDto.ts`, 해당 테스트·mock에 예전 `endReason`·`handoff` 타입이 남아 있다. 상세 변환 함수도 `d.call.handoff`로 표시 정보를 만들므로 타입·mock·변환과 표시를 함께 정리한다. 상담원 연결 요구 표시는 `analysis.hasHandoffRequest`에 맞춘다. 이번 변경은 프론트 파일을 수정하지 않는다.

## DB 전환

- `047-remove-unused-schema.sql` 한 파일로 `company_pins.search_text`, `call_sessions.end_reason`, `handoff_requests`를 제거한다. 이전에 적용한 migration 파일은 수정하지 않는다.
- 회사 PIN의 주소·부서·식별자와 개인 PIN의 검색 생성 컬럼은 유지한다. 통화 시각 CHECK를 다시 만들고 나머지 FK·업무 트리거를 보존한다. 최종 public 테이블 28개, FK 24개, 업무 트리거 10개다.
- 삭제 컬럼과 레거시 테이블에 기존 값이 있으면 실제로 소실된다. 기존 앱·워커 중지 → DB 백업 → 기존 runner로 047까지 한 트랜잭션 적용 → `infra/database/verify.sql` → 새 앱 시작 순서다. 운영 DB 적용은 이 작업에 포함하지 않는다.
- 구버전 앱은 삭제한 컬럼·테이블을 조회하므로 새 DB와 함께 실행하지 않는다. 복구가 필요하면 앱·DB를 백업 시점에 맞춰 함께 복원한다.
- `has_handoff_request` 요약, AI 이벤트, 주문·통화·녹취·STT의 보존 기간과 soft delete는 그대로 유지한다.

## 작업·검증 결과

`refactor/unused-backend`에서 다음 순서로 수정·검증했다. 단계별 테스트에는 중복 실행이 있어 합산하지 않는다.

| 단계 | 정리 내용 | 관련 통합 테스트 |
| --- | --- | --- |
| 1 | 호출자 없는 `isCompanyCustomer` 제거 | 접수·복구 17개 통과 |
| 2 | `beginPayment`, `releaseDeclinedPayment`, repository `begin`·`release` 제거. 기존 시나리오는 실제 승인 처리권 경로로 전환 | 결제·주문·취소·기업 삭제·복구 161개 통과 |
| 3 | 중복 관리자 권한 API·전용 DTO 제거 | 인증·권한·Origin·감사 롤백·Swagger 36개 통과 |
| 4 | AI FAQ 상세 API·전용 응답 DTO 제거 | FAQ·분류·초기 데이터·알림·미해결 질문·soft delete 58개 통과 |
| 5 | 기업 PIN 검색 생성 컬럼 제거 | migration·배포 검증·개인 검색·기업 삭제 46개 통과 |
| 6 | 레거시 종료 사유·연결 기록과 DTO·필터·JOIN·폐기 쿼리 제거 | 통화·분석·이벤트·보존·녹취·실시간 집계·스키마 148개 검증. 보완한 migration fixture는 045·046·047 3개 재검증 통과 |

삭제 후 FAQ 상세 조회는 관리자만 사용하므로 Service·Repository의 불필요한 AI 분기·인수·반환 union을 제거했다. 통화 목록 Swagger의 예전 연결 기록 설명도 정리했다.

- `node backend/scripts/check.cjs`: Linux 컴파일·lint·format 통과. 단위 118개, 결제 시뮬레이션 21개, PostgreSQL 통합 648개, 운영 이미지·nginx·HTTPS 20개로 총 807개 통과, 실패·스킵 0개. HTTPS SSE와 PBX 회귀도 포함한다.
- 마지막 Swagger 문구 정리 후 빌드·lint·format·단위 검증을 다시 통과했고 통화·FAQ 통합 40개가 추가 통과했다.
- `%TEMP%/dva-unused-final-check.log`, `%TEMP%/dva-unused-final-swagger-tests.log`에 로컬 결과를 기록했다.
- 실제 운영 DB 적용·배포·실제 결제사/S3 연결과 별도 수동 `infra/database/test-monolith.ps1` 전체 실행은 검증 범위에 포함하지 않았다. 047의 빈 DB·기존 데이터 업그레이드·전체 롤백·배포 verify는 PostgreSQL 통합 테스트로 확인했다.
