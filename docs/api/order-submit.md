# 주문 최종 확정 — ORD-06

관련 Jira: [S15P31D109-57](https://ssafy.atlassian.net/browse/S15P31D109-57), [결제 흐름 개편 138](https://ssafy.atlassian.net/browse/S15P31D109-138).

기존 COLLECTING 주문을 보완한 뒤 최종 확정하는 API다. 새 AI 완료 결과는 POST /api/orders, 관리자 신규 수기는 POST /api/admin/orders 한 번으로 같은 검증을 수행한다. 결제·접수의 공통 정책은 [주문 결제](order-billing.md), AI 호출 예시는 [별도 연동 규격](ai-order-billing-integration.md)을 따른다.

## 요청

~~~http
POST /api/orders/123/submit
Content-Type: application/json
call_session_seq: 7
~~~

~~~json
{"expectedVersion": 4}
~~~

- 주문 상세의 실제 version을 전달한다. 본문은 expectedVersion 하나이며 주문 내용을 다시 보내지 않는다.
- AI는 DB의 call_session_seq 헤더가 필요하다. 진행 중 통화의 발신번호와 활성 고객 번호가 같아야 한다. 다른 주문에 연결된 통화는 사용할 수 없다.
- 관리자는 ACTIVE OPERATOR/SUPERVISOR/SYSTEM_ADMIN 세션과 허용 Origin을 사용한다. 통화 헤더는 선택이다.
- 잘못된 관리자 쿠키는 인증 오류다. AI 서비스 인증은 기존 MVP 정책을 유지한다.
- 새 확정은 COLLECTING만 가능하다. 종료된 통화는 이미 연결된 주문의 상태 확인만 허용한다.
- Idempotency-Key는 사용하지 않는다. 같은 주문 번호와 현재 상태로 중복 전송을 막는다.

## 검증과 처리

1. 주문·고객·통화·버전을 확인하고 미취소 상세의 주소·물품·PIN·미래 수거 시각을 검증한다.
2. totalAmount와 모든 미취소 상세의 notifiedPrice가 양의 정수이고 합계가 일치하는지 확인한다. 배송비는 고정값이 아니며 itemPrice는 물품 가액이다.
3. billing은 개인·기업 고객의 개인 카드로 notPaid 상태와 24시간 결제 요청을 저장한다. 이때 디버는 호출하지 않는다.
4. credit은 월결제, groupBilling은 소속 부서 그룹결제다. 현재 사용 자격을 확인하고 PAID·결제 완료 감사·기업 사용액을 먼저 커밋한다.
5. PAID 주문을 SUBMITTING으로 저장·커밋한 뒤 트랜잭션 밖에서 디버를 호출한다. 200 성공이면 ACCEPTED, 400 실패이면 SUBMISSION_FAILED를 저장한다. 외부 오류 코드는 응답에 추가하지 않는다.

월결제는 개인 설정 또는 활성 소속·활성 기업의 설정을, 그룹결제는 활성 소속 부서의 설정을 검사한다. 미입력 기본 결제 방식은 billing이다. 과거 cat은 조회만 가능하고 COLLECTING에서 지원 방식으로 바꿔야 확정할 수 있다.

주소는 출발·도착 이름/숫자 연락처/도로명·지번/동명/5자리 우편번호/위경도가 필요하다. 양의 물품 수량 또는 기타 설명, 물품 가액도 필요하며 상세 주소는 선택이다. 취소 상세는 필수값·PIN 검증과 전송에서 제외한다. 성공 시 미취소 상세마다 배송과 초기 paid 이력을 함께 저장한다. 내부 추적번호는 택배사 송장이 아니며 parcelNo는 중복 가능한 참고값이다.

## 응답과 재접수

~~~json
{"data":{"status":"notPaid"},"meta":{"requestId":"요청 UUID"}}
~~~

| HTTP / status | 의미 |
| --- | --- |
| 200 / notPaid | 개인 카드 결제 대기. 상세에서 총액·유효 결제 요청 확인 |
| 200 / PAID | 결제 완료. 전송 복구 대상 |
| 202 / SUBMITTING | 디버 접수중 또는 결과 저장 미확정 |
| 200 / ACCEPTED | 디버 접수 완료 |
| 200 / SUBMISSION_FAILED | 디버 접수 실패. 관리자 재접수 대상 |

HTTP 200만으로 접수 성공을 안내하지 않는다. PAID 이후 내용 수정·취소는 불가하다. notPaid도 내용 수정은 불가하며 전체·부분 취소만 허용한다.

같은 주문의 반복 submit은 현재 상태를 반환하며 FAILED를 자동 재전송하지 않는다. 마지막 갱신 후 1분이 지난 SUBMITTING은 반복 submit에서 SUBMISSION_FAILED로 전환한다. 결과 형식 오류·전송 오류도 접수 실패로 다루며 자동 재전송하지 않는다. 관리자 재접수는 POST /api/admin/orders/{id}/retry를 사용하고 결제·사용액을 다시 처리하지 않는다. 결제 완료 직후 전송 시작 전에 중단된 PAID는 백엔드 유지보수 작업이 이어간다.

## 오류·배포

400은 형식·범위, 401은 세션, 403은 고객·통화·PIN·결제 자격, 404는 없는 대상, 409는 버전·상태 충돌 또는 DB 잠금 대기 초과, 422는 저장된 필수값·합계 검증 실패다. 최초 월·그룹 확정 전에 디버 설정이 없으면 503이며 COLLECTING을 유지한다.

DB 잠금 대기는 최대 2초다. 초과한 준비 작업은 롤백하고 디버를 호출하지 않는다. 외부 요청은 본문까지 10초 제한이며 DB 잠금을 유지하지 않는다. 디버 전송 뒤 결과 저장 실패는 외부 접수를 되돌리지 못하므로 SUBMITTING을 유지하고 같은 주문으로 확인한다.

새 앱 실행 전에 016~019 migration을 기존 runner로 적용한다. 최초 전환은 기존 백엔드 중지·백업·검증 후 앱을 교체하며 구버전 복귀를 차단한다. 상세는 [DB](../database/README.md)와 [배포 절차](../../infra/deploy/README.md)를 따른다. 실제 결제사·메시지 발송은 별도 연동이며 결제 요청 ID는 결제 URL이 아니다.
