# Soft delete API·AI 전달 사항

045·046과 새 백엔드를 함께 배포한다. 기존 삭제 API의 URL·본문·204 응답·역할은 유지한다. 이 문서는 기존 외부 API 문서의 ‘실제 삭제’ 설명보다 우선한다. 접수 중간 실패·최종 실패는 [10초·10분 재시도 계약](order-submission-retry.md)을 따른다.

| 호출 | 동작 |
|---|---|
| DELETE /api/admins/{id} | SYSTEM_ADMIN 전용. OPERATOR/SUPERVISOR 계정 soft delete + 모든 세션 즉시 폐기. SYSTEM_ADMIN 삭제 금지 유지 |
| DELETE /api/companies/{id} | 모든 활성 관리자. 기업·부서·소속·기업 PIN을 같은 트랜잭션에서 soft delete |
| DELETE /api/departments/{id} | 해당 부서·소속·기업 PIN만 soft delete |
| DELETE /api/members/{id} | 소속만 soft delete. 고객은 보존 |
| DELETE /api/faqs | 기존 faqEntrySeqs 배열 유지. 원문 보관 + AI DELETE 알림 유지 |
| DELETE /api/unanswered-questions/{id} | 기존 정책대로 OPEN만 삭제, DELETED 재호출 204, REGISTERED 409. 원문은 DB에 보관하고 조회·처리 결과에서는 숨김 |
| **DELETE /api/orders/{id}** | 신규. 모든 활성 관리자. 주문과 자식 이력을 일반 조회에서 숨김. 결제 취소 API가 아니며 금액·청구 총액은 변경하지 않음 |
| **DELETE /api/calls/{id}** | 신규. 모든 활성 관리자. 통화·분석·STT·AI 이벤트·미답변·녹취를 일반 조회에서 숨김. 연결된 주문은 보존 |

신규 DELETE는 관리자 쿠키와 CORS_ORIGINS의 Origin이 필요하다. 본문은 없다. 정상 204, 대상 없음/삭제/만료 404, 진행 중 409 INVALID_STATE, 잠금 대기 초과 409 REQUEST_IN_PROGRESS다. OPERATOR·SUPERVISOR·SYSTEM_ADMIN 모두 사용할 수 있다.

주문은 COLLECTING/CANCELLED/ACCEPTED이고 진행 중인 연결 통화·승인·안내 발송이 없을 때 삭제한다. notPaid는 기존 취소 API로 먼저 정리하고, PAID/SUBMITTING/SUBMITTING_FAILED/SUBMISSION_FAILED는 결제·접수 결과부터 확인한다. 최종 접수 실패도 결제 취소를 뜻하지 않는다. 통화는 PBX 종료가 확인되고 연결된 모든 녹취 수신의 저장이 완료되어야 삭제한다. RECEIVED·FAILED 또는 활성 업로드 lease가 있으면 409이며 저장을 마친 뒤 재호출한다. 종료 누락을 임의 시간 초과로 판단하지 않는다.

프론트는 기존 목록/total_count/상세를 다시 조회하면 된다. deletedAt을 새로 받아 필터링할 필요가 없다. 삭제/만료 데이터는 서버가 제외하며 이미 삭제한 주문·통화의 DELETE 재호출은 404다. 발급해 둔 녹취 URL은 기존 유효기간(최대 5분) 동안 동작할 수 있으며 이미 실행 중인 요청은 소급 취소하지 않는다.

보관 만료 후 자동 폐기에서는 최종 접수 실패 `SUBMISSION_FAILED`도 생성 시각부터 5년이 지난 정리 대상이다. 미확정 결제 승인·발송 중인 안내·연결 통화가 있으면 유예하며, 기한 안의 일반 DELETE와 결제 취소·환불 기준은 그대로 유지한다.

## AI·PBX

- 기존 요청 필드는 유지한다. AI가 최초 providerCallId·incomingAt을 재전송에도 유지해야 한다. 현재 시각으로 바꾸어 삭제/만료 통화를 재등록하지 않는다.
- 삭제/만료 통화에 새 주문·발화·분석·미답변을 보내면 기존 업무 결과를 재생성하지 않고 404 또는 등록 시 409를 반환한다. 해당 통화 전송을 종료한다. 5년은 incomingAt에서 계산하므로 늦은 분석·녹취 업로드로 연장되지 않는다.
- AI 이벤트가 참조하는 주문도 일반 주문 조회와 같은 삭제·5년 만료 조건을 적용한다. 만료 주문 참조는 404이며, 한 묶음에 유효/만료 참조가 섞여도 묶음 전체를 롤백한다. 보관 중인 기존 이벤트 이력은 바꾸지 않는다.
- 최초 수신 후 5년이 지난 PBX 데이터는 저장하지 않고 HTTP 200 `{status:"expired",recordingId,duplicate:false}`로 응답한다. 정상 received·중복 충돌 계약은 유지한다.
- AI 이벤트와 의미 있는 NO_ORDER는 업무 이력이다. 7일 로그 정리 대상이 아니며 통화와 같이 5년 보관한다. 미연결 PBX 수신의 기존 30분 정리는 유지한다.
- 삭제 FAQ는 AI 조회에서 제외하고 기존 DELETE 알림을 보낸다. AI 검색 캐시·복제 데이터의 삭제와 자체 5년 보관 처리는 AI에서 같은 정책으로 적용해야 한다.
- 주문 Idempotency-Key의 결과/권한 보장은 주문 보관 기간 안에서 제공한다. 이미 완료한 과거 요청 키를 새 주문에 재사용하지 않는다. 실제 폐기 후에는 고객·결제·요청 원본을 복구하지 않는다.

고객 WITHDRAWN·관리자 INACTIVE·기업 INACTIVE는 기존 업무 상태이며 soft delete와 구분한다. 이번에 고객/PIN 삭제 API나 복원 API는 추가하지 않는다.
