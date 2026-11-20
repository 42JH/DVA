# 운영 상태 확인 — 2026-11-09

조회·접수 동작을 정리한 초기 기록이다. 최신 상태 계약은 [통화 분석 상태](call-analysis-status-frontend-integration.md)와 [미완료 만료 정책](incomplete-expiry-latest-call.md)을 따른다.

## 번호가 건너뛰는 이유

- orders와 call_sessions의 sequence increment는 모두 1, cache도 1이다. 잘못된 증가 간격 설정은 아니다.
- 통화 등록의 `CallSessionRepository.ensureCall`은 INSERT ... ON CONFLICT(provider_call_id) DO NOTHING 뒤 기존 행을 조회한다. 중복 수신에서도 기본 identity 값이 배정될 수 있다. 트랜잭션 롤백도 PostgreSQL sequence를 되돌리지 않는다.
- 화면 정렬은 업무 시각·생성 시각 기준이며 PK의 연속성을 보장하지 않는다. 새 예약번호도 삭제·취소·여러 초안 묶음 때문에 미사용 번호가 생기는 사용자 확정 방식이다. 기존 PK를 재정렬하지 않는다.

## 주문 목록의 취소 표시

- `OrderPaymentsRepository`는 미결제 기한을 현재 시각 +24시간으로 설정한다. `OrderMaintenanceWorker`는 승인 처리 중인 결제를 제외하고 기한이 지난 notPaid를 취소한다. 조회한 시스템 취소의 closed_at은 payment_due_at 직후였다.

## 통화 분석 결과가 수신되지 않은 경우

- 초기 목록 SQL은 분석 행이 있으면 COMPLETED, 실패 통보 시각이 있으면 FAILED, 둘 다 없으면 PENDING으로 표시했다.
- 따라서 이 PENDING은 실제 분석 프로세스가 실행 중이라는 뜻이 아니라 결과 미수신이다. 프론트는 PENDING 동안 갱신을 계속한다. 이 경우 녹취만으로 분석 결과가 자동 생성되지 않는다.

## 미완료 이어가기

원본은 삭제·만료되지 않은 INCOMPLETE여야 한다. 관리자와 새로운 AI 통화는 새 clientParcelId·sourceDraftSeq로 새 초안을 만든다. 원본은 RESUMED로 바뀌며 같은 원본의 동시 재개는 잠금으로 직렬화된다. 같은 생성 UUID 재전송은 기존 새 초안을 반환한다.

원본 고객이 있으면 그대로 유지하고 없으면 활성 고객을 지정한다. 주소·물품 사본과 보관 시작 시각을 복사하며, 이어가기로 5년 보관 기한을 연장하지 않는다. 필수값을 채워 READY로 저장한 뒤 관리자 초안 submit으로 별도 ADMIN 주문을 만든다. 원본 통화의 이미 확정된 주문에 상세를 덧붙이지 않는다.

기존 운영 버전은 이 최종 접수 시 새 orderSeq를 배정한다. 작업 브랜치는 source의 reservedOrderSeq를 새 초안으로 이어 받아 같은 번호로 접수한다. 진행 중인 통화의 READY/EDITING을 관리자가 직접 이어가는 것은 허용하지 않는다.

## 개인 PIN의 ‘보내는 곳’

고객 기본 출발지는 `customers.address_data` 한 객체다. 개인 주소록은 별도 `personal_pins`의 여러 행이다. backend 주문 저장 자체가 고객 기본 주소나 PIN을 자동 갱신하지는 않는다. AI의 일반 저장 정책(`ai/app/domain/address_book.py`)은 택배를 담을 때 변경된 발송 주소를 고객 기본 주소에 덮어쓰고, 새 수령 주소는 개인 PIN으로 추가한다.

AI의 `ai/app/calls/results.py` register 경로는 신규 고객을 주소와 함께 등록한 후 다시 `create_pin(..., role="sender", label="보내는 곳")`을 호출한다. 이 별도 경로가 출발지를 개인 PIN에 한 번 더 넣는다. 해당 AI 테스트도 보내는 곳 PIN 생성을 기대하고 있어 정책 변경 시 함께 수정해야 한다.

요구한 ‘출발지는 최신 개인 주소 하나’와 맞추려면 이 신규 등록의 sender PIN 생성 호출을 제거하고 기본 주소 저장을 유지해야 한다. 수령지 PIN은 별개다. backend PIN API는 주소의 출발/도착 용도를 별도 필드로 저장하지 않으므로 라벨 문자열만 보고 자동 삭제하지 않았다.

추가로 AI 출발지 후보는 기본 주소가 없으면 과거 접수 출발지를 대체 후보로 사용한다(`ai/app/calls/service.py`). 기본 주소만 쓰는 정책을 엄격히 적용한다면 이 대체 경로도 AI에서 함께 확인해야 한다.
