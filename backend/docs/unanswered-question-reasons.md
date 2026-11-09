# 미답변 사유 연동

2026-11-04 사용자 승인. 기준 `develop-backend` `277cf1c`, 작업 브랜치 `feature/unanswered-reasons`.

## 계획과 범위

1. 기존 수집·조회·재전송·통화 이벤트·FAQ 전환·삭제·배포 검증의 호출자를 확인한다.
2. 사유 입력·DB 저장·조회·필터·명세를 함께 변경한다. migration은 새 049 한 파일로 추가한다.
3. 입력 검증, 과거 행 업그레이드, 재전송, 사유별 건수, 관리자 업무 상태·이벤트 연결·삭제/보관 회귀를 검증한다.
4. 백엔드 정규 검사와 DB runner를 실행하고 결과를 기록한 뒤 작업 브랜치에 커밋한다.

AI의 RAG/Live 대조 로직과 전송 작업, 프론트 화면, 실제 운영 DB·배포는 이번 변경 범위에 포함하지 않는다.

## 계약

- AI는 통화 종료 후 기존 `POST /api/ai/unanswered-questions`를 질문별로 호출한다. 기존 `AI_INSIGHTS_TOKEN`을 사용한다.
- 기존 필수 여섯 필드는 유지하고 선택 `reason`을 추가한다. `KB_NO_ANSWER`는 검색 성공 후 근거 부족, `KB_UNAVAILABLE`은 검색 미연결·장애다. 생략/null과 기존 행은 미분류(null)다. 백엔드는 원인을 추정하지 않는다.
- `unanswered_questions.reason text NULL`에 두 코드만 허용하는 CHECK를 둔다. 새 테이블·FK·업무 상태·기존 행/해시/시각은 변경하지 않는다.
- 사유가 생략/null이면 기존 여섯 필드의 재전송 해시를 유지한다. 명시한 사유는 해시에 포함한다. 같은 eventId의 동일 재전송은 200, 사유를 포함한 내용 변경은 409다. 최초 저장 201과 응답 `data.unansweredQuestionSeq`는 유지한다.
- `GET /api/unanswered-questions`의 각 행에 `reason`을 반환한다. reason 생략은 전체 사유, 두 코드는 해당 사유, 조회 전용 `UNCLASSIFIED`는 null만 조회한다. 수집 본문의 reason에는 UNCLASSIFIED를 보내지 않는다.
- 기본 `status=OPEN`은 유지한다. 조회 전용 `status=ALL`은 OPEN·REGISTERED를 포함한다. DELETED와 삭제/보관 만료 통화는 계속 제외한다. 사유와 상태 필터는 AND로 적용하며 `total_count`는 필터 후 질문 발생 총건수다.
- 통화 처리 결과 조회의 `unansweredReason`은 연결된 미답변의 사유다. 다른 결과·미분류·삭제한 미답변은 null이다. 이벤트 입력에는 사유를 복사하지 않고 기존 QUESTION_UNANSWERED의 질문 번호 참조를 유지한다.
- FAQ 전환·삭제는 status만 바꾸며 원래 reason을 보존한다. 통화 최초 incoming_at부터 5년인 기존 보관·폐기 흐름을 유지한다.

## AI·프론트 적용

1. DB 백업 후 049 적용 → 새 백엔드 배포 → AI reason 전송 시작 순서다. 구버전 백엔드는 reason을 추가 필드로 거절한다.
2. AI는 RAG 검색 결과와 실제 답변을 대조해 통화 종료 후 사유를 확정한다. 최초 저장 시 고정한 eventId·본문·사유를 재전송에도 유지한다. 과거 미분류 발생을 같은 eventId로 사후 분류하지 않는다.
3. 최초/동일 재전송의 질문 번호를 기존 QUESTION_UNANSWERED 이벤트에 연결한다. 별도 통합 전송 API는 없다.
4. 프론트는 reason의 두 코드와 null을 각각 근거 부족·검색 장애·미분류로 표시한다. 미처리 목록은 기존 기본값, 사유별 전체 발생 집계는 `status=ALL&reason=...`의 total_count를 사용한다. 같은 질문도 서로 다른 eventId면 별도 발생이다.

## 검증 기록

- 신규 사유 입력·필터 테스트가 기존 코드에서 400으로 실패함을 먼저 확인했다(8개 중 새 2개 실패). 변경 후 컴파일·lint·포맷·단위 131개·결제 시뮬레이터 21개가 통과했다.
- DB runner(`infra/database/test-monolith.ps1`) exit 0. 신규/이전 DB의 049까지 업그레이드, 반복 적용, 체크섬 변경 거절, 실패 롤백·백업 복원을 검증했다. 28 public 테이블·24 FK·10 트리거는 유지된다.
- 1차 전체 검사에서 새 NOT VALID 부정 테스트의 기대 메시지가 실제 선행 검사와 달라 실패했다. 기존 verify.sql의 공통 미검증 제약 검사가 먼저 거절하는 것을 확인하고 해당 사례는 정확한 기존 메시지로 검사하도록 분리했다. 사유 전용 검사와 모든 거절 사례는 유지했다.
- 최종 `node backend/scripts/check.cjs` exit 0. 컴파일·lint·포맷, 단위 131개·결제 시뮬레이터 21개·PostgreSQL 통합 677개·실제 운영 이미지/양쪽 nginx/HTTPS 런타임 20개가 모두 통과했다. 합계 849개, 실패·skip·cancelled·todo 0이다. 049 스키마 검증·과거 해시·동시 재전송·사유/상태 필터·전체 건수·페이지 경계·삭제/만료 제외·FAQ 전환·삭제 후 사유 보존·이벤트 연결·OpenAPI를 포함한다.
- 추가 migration은 049 한 파일뿐이다. 기존 migration·HTTP 경로/메서드·인증 Guard·환경설정·의존성·주문/결제·nginx·Jenkins·AI/프론트 소스는 변경하지 않았다. 기존 관리자 권한·감사 트랜잭션·통화 5년 보관/폐기 회귀가 통과했다.
- 운영 DB 적용·배포·원격 CI·실제 AI/프론트 전송은 실행하지 않았다. AI의 사유 판단/전송과 프론트 표시 연결은 이 명세에 따라 별도로 반영한다.
