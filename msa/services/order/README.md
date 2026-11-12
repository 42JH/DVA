# Order 서비스

최신 모놀리식과 같은 주문 조회 4개·관리자 삭제·전체/상세 취소 2개 API를 제공한다. [계획과 검증 근거](../../../docs/msa-order-reads-plan.md), [전체 이식 계획](../../../docs/msa-parity-plan.md)을 따른다. [삭제 계획과 검증 근거](../../../docs/msa-order-deletion-plan.md)를 함께 따른다. [취소 계획과 검증 근거](../../../docs/msa-order-cancellation-plan.md)를 함께 따른다. 주문 생성·수정·결제/사용액 적립·접수/배송 생성 이벤트·보관 워커는 후속이다.

| API | 동작 |
| --- | --- |
| `POST /api/orders/:id/cancel` | 관리자/AI 전체 취소·총액 재계산·결제 요청 무효화 |
| `POST /api/orders/:id/parcels/cancel` | 관리자/AI 상세 선택 취소·남은 결제 요청 교체·완료 시 부모 취소 |
| `DELETE /api/orders/:id` | 관리자 soft delete·통화/결제 진행 차단·감사 확정 |
| `GET /api/orders` | 관리자 전체/AI 통화 고객 범위의 요약, 검색·기간·페이지·전체 개수 |
| `GET /api/orders/:id` | 저장 버전·상세/주소/PIN/청구 스냅샷·유효 결제 요청 |
| `GET /api/admin/orders` | 관리자 목록 화면의 검색·상태 탭·상세 |
| `GET /api/parcel-drafts` | 상태·고객·현재 기업·통화·이관 주문·검색·기간별 초안과 전체 개수 |
| `GET /api/parcel-drafts/:id` | 독립 초안 스냅샷과 AI 통화의 intakeVersion |
| `GET /api/customers/:id/addresses` | ACCEPTED·ACTIVE 이전 주소, 방향/기간/검색/페이지 |

관리자 cookie·역할·입력·보관/삭제 조건·응답 envelope·에러 문구를 유지한다. 잘못된 cookie를 AI로 우회하지 않는다. AI는 기존 `call_session_seq`로 현재 발신번호의 활성 고객만 조회한다. 종료 통화는 연결된 주문 상세 한 건만 허용한다. 클라이언트에 추가 토큰이나 API를 요구하지 않는다. 원본 API의 기존 AI 접근 정책을 유지하는 범위다.

order DB에는 주문/상세/결제 요청/청구만 두고 타 소유자 테이블을 복제하지 않는다. 상담/고객 확인은 [인증된 조회 이벤트](../../shared/events/README.md)로 연결하며 같은 조회 재시도도 최신 상태를 확인한다. GET 조회는 업무/감사·outbox/inbox 쓰기를 만들지 않는다. 소유 행의 공유 잠금과 로컬 REPEATABLE READ를 사용하므로 동시 통화 종료·고객 상태 변경은 조회가 끝날 때까지 짧게 대기한다. 서비스 의존 장애는 503이며 관리자 로컬 주문 조회는 계속 제공한다.

## 055 저장 구조와 기존 API

[055 이관 계획](../../../docs/msa-draft-compatibility-plan.md)에 따라 과거 COLLECTING을 원래 보관/삭제 시각으로 부분 초안에 복사한다. 기존 목록은 이관 원본을 숨기고 취소는 409로 거절한다. 신규 통화의 AI 취소도 원본처럼 409다. 초안 목록·상세를 제공하며 생성·수정·삭제·완료 API는 후속이다.

order 시작 전에 consultation의 불변 이관 사본을 인증 이벤트로 읽어 초안 연결과 완료 표식을 같은 로컬 트랜잭션으로 저장한다. 모두 커밋한 뒤 임시 통화/발신번호 사본을 정리하고 요청을 받는다. 실패한 시작은 미완료 표식을 다음 시작에서 이어 처리한다. 최초 시작에는 consultation이 필요하며, 완료 후 시작은 이관 의존 없이 가능하다. 영구 inbox/outbox에 전화번호를 복제하지 않는다.

최초 이관 완료 뒤 초안 보관 워커가 10초마다 원래 retention_started_at에서 5년 지난 행을 100개씩 폐기한다. 수정·삭제·재개로 보관을 연장하지 않고 잠긴 행은 다음 주기에 처리한다. 주문/통화 원본·감사/결제의 전체 보관 처리는 후속이다.

## 실행과 배포

Node.js 24와 기존 PostgreSQL을 사용한다. `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `OPERATIONS_URL`, `CUSTOMER_URL`, `CONSULTATION_URL`, `DELIVERY_URL`, `CUSTOMER_AUTH_TOKEN`을 설정한다. `PORT` 기본값은 3002, 운영에는 기존 `SECURITY_LOG_HMAC_KEY` 64자리 hex와 `CORS_ORIGINS`를 주입한다. Liquibase order 004와 consultation 008을 먼저 적용해야 한다. 별도 토큰/로그 Secret 종류를 추가하지 않고 기존 최초 생성·값 보존 정책을 사용한다.

저장소 루트에서 실행한다.

```sh
docker build --target checks -t dva-order-checks -f msa/services/order/Dockerfile msa
docker build -t dva-order:local -f msa/services/order/Dockerfile msa
python3 msa/parity/verify-order.py
python3 -m unittest discover -s msa/deploy/tests -v
# 운영 kubeconfig를 사용하지 않는 로컬 Docker/k3s에서만 실행
python3 msa/deploy/tests/integration_app_rollout.py --service order --image dva-order:local
```

이미지는 기존 MSA 패키지 버전·공통 이벤트 파일 의존성을 재사용한다. Redis·브로커·새 런타임 앱은 추가하지 않는다. Jenkins `Verify Order Parity`는 operations/customer/consultation/order가 선택되면 실행하고 실패 시 배포를 중단한다. 각 서비스의 실제 배포 이력을 유지하며 모두 선택되면 operations → customer → consultation → delivery → order 순으로 배포한다.

- `/order/health`: 프로세스 상태. `/order/health/ready`: 실제 order DB와 operations 세션 인증 의존 확인.
- `/order/docs`, `/order/docs-json`: 업무 조회·삭제·취소와 health만 공개한다. `/internal/order-read`, `/internal/order-cancellation`, `/internal/audit/flush`는 Ingress/OpenAPI에서 제외한다.
- Ingress는 기존 `/api/orders`, `/api/admin/orders`를 전달한다. 고객 주소는 `/api/customers/[^/]+/addresses/?$`만 `ImplementationSpecific`/`PathRegexp`로 선택한다. 나머지 customer 경로와 일반 Prefix 경로는 유지한다. [Traefik 공식 설정](https://doc.traefik.io/traefik/reference/routing-configuration/kubernetes/ingress/) 및 [v3.5.4 구현의 경로별 matcher 선택](https://github.com/traefik/traefik/blob/v3.5.4/pkg/provider/kubernetes/ingress/kubernetes.go#L640)을 근거로 한다.
- 기존 RollingUpdate·앱 패키징·실패 복구를 사용한다. 운영 Jenkins/k3s/HTTPS 확인은 로컬 컨테이너·격리 k3s 검증과 구분해 보고한다.

## 삭제와 감사 확정

기존 관리자 cookie·역할·허용 Origin을 요구한다. COLLECTING/CANCELLED/ACCEPTED에서만 삭제하며 활성 통화, 승인 중 결제, SENDING 안내가 있으면 409다. 이미 삭제되거나 보관 기간이 끝난 주문은 404다. 주문 행과 결제 요청을 잠그고 consultation의 `/internal/order-deletion-check`에 `OrderDeletionCheckRequested`를 보내 boolean만 확인한다. 같은 이벤트도 현재 통화를 읽고 캐시·수신 이력·통화 변경은 만들지 않는다. 종료되지 않은 과거 통화도 원본처럼 차단한다. 의존 장애는 503이며 삭제를 커밋하지 않는다.

order 로컬 트랜잭션은 대기 결제 안내 상태와 deleted_at을 바꾸고 operations에 성공 감사를 준비한다. 업무와 AuditCommitted outbox를 함께 커밋한 뒤 감사 COMMIT/ACK까지 확인해야 204를 반환한다. 실패는 rollback/AuditAborted와 기존 FAILED/DENIED 감사를 따른다. 릴레이는 기존 250ms 재시도이며 operations는 생산자 트랜잭션 잠금 증명을 확인해 강제 종료 후 미확정 준비를 중단하거나 커밋된 감사를 확정한다. 이미 커밋된 응답 유실은 실패로 단정해 되돌리지 않는다. 분리 DB의 전역 원자성을 보장하지 않으며 장애 응답 뒤 확정 결과는 기존 GET과 감사 조회로 확인한다.

operations Liquibase 010을 앱보다 먼저 적용하고 operations → consultation → order를 배포한다. operations에 `ORDER_URL=http://order:3002`를 주입하며 기존 CUSTOMER_AUTH_TOKEN을 재사용한다. 새로운 프론트/AI 토큰과 공개 API는 요구하지 않는다. 수거/결제 취소와 물리 폐기는 이 DELETE의 역할이 아니다.

## 전체·상세 취소

두 기존 POST 경로는 관리자 cookie·역할·Origin과 AI call_session_seq 예외를 원본대로 사용한다. AI는 consultation 통화와 customer의 현재 활성 발신 고객을 공유 잠금으로 보호한 동안 order callback에서 취소한다. 종료 통화는 연결 주문만 허용한다. public order 요청은 callback을 기다릴 때 DB 연결을 잡지 않는다. 비공개 취소 명령은 actorId를 입력받지 않고 AI 범위만 수행한다.

부모 주문·모든 상세 잠금, 소속 검사, 선택 상세가 전부 기취소면 204, 상태/승인/배송 차단 순서를 유지한다. 대상 ACTIVE 상세에 배송이 하나라도 있으면 원본대로 409다. 배송 상태와 무관하며 이미 취소된 상세의 배송은 대상이 아니다. 배송 생성/배송 변경은 이 API에서 수행하지 않는다. 배송 의존 장애는 변경을 커밋하지 않고 503이며 기존 관리자 로컬 조회와 기취소 상세의 no-op은 계속 가능하다.

상세별·부모·금액 감사 순서, DB trigger의 버전/최초 closed_at, 주소/물품/PIN 스냅샷을 보존한다. 기존 notPaid 요청은 무효화하고 잔액이 양수면 같은 payment_due_at으로 새 요청을 만든다. 기존 안내 SENDING 자체는 이 취소의 차단 조건이 아니다. 결제 승인 중만 차단하며 안내 상태를 임의로 바꾸지 않는다. 감사는 기존 outbox/확정 ACK/생산자 잠금 복구를 사용한다.

배포에는 기존 delivery DB Secret과 msa-customer-auth를 연결하고 order에 DELIVERY_URL=http://delivery:3003을 추가한다. 모든 서비스는 msa 공통 Docker context이며 delivery가 order보다 먼저 배포된다. DB changeset은 추가/수정하지 않는다. 분리 DB에는 업무 COMMIT과 원격 감사 ACK 사이가 있으며 응답 유실 시 전체 취소 재시도는 409, 기취소 상세 재시도는 204인 원본 규칙을 유지한다.

## 기업 월 청구 초기화

[기업 청구 조회·월 전환 계획](../../../docs/msa-billing-months-plan.md)을 따른다. 청구 원장은 order DB, 현재 기업 정보는 customer DB에만 둔다. customer의 공개 청구 GET은 이름과 삭제 여부를 잠금으로 확인한 후 내부 조회로 월 스냅샷·원래 정수 금액을 반환한다. 한국 시간 현재 월을 기본으로 하며 과거 원장을 새 이름으로 덮어쓰지 않는다. GET은 원장을 생성하거나 감사를 기록하지 않는다.

production의 10초 워커가 비삭제 기업을 발견하고 원본 generate_series 규칙으로 누락 월을 찾는다. 10건씩 customer 공유 잠금 → order callback → 원장·AuditCommitted 커밋 → operations 감사 확정 ACK를 기다린다. INACTIVE 기업도 포함하며 source와 같은 advisory lock `(20261030,139)`·유일성으로 중복 실행을 조정한다. 초기화한 월마다 credit/groupBilling 두 SYSTEM 감사를 남기고 직전 금액과 0을 기록한다. 청구 사용액을 이전 월에서 이월하지 않는다. test 환경은 자동 워커를 실행하지 않는다.

기존 CUSTOMER_URL/ORDER_URL/CUSTOMER_AUTH_TOKEN과 order 003·operations 010을 재사용한다. 비공개 `/internal/billing/*`는 Ingress와 OpenAPI에서 제외하며 조회/기업 응답을 inbox에 저장하지 않는다. 서비스 장애는 다음 tick에서 다시 확인한다. 원장 SQL·감사 준비 실패는 해당 배치 전체를 롤백한다. 이미 커밋된 응답 유실은 원장 유일성과 기존 감사 복구로 수렴한다. 분리 DB의 전역 원자성을 보장하지 않는다. 주문 결제 시 사용액 적립은 후속 결제/접수 단위에서 연결한다.

관리자 화면 목록은 원본과 같이 현재 고객·기업명, 미완료 초안의 예약 주문번호·draftSeq, 기업 필터와 statusCounts를 반환한다. COLLECTING 탭에는 INCOMPLETE 초안만 포함하며 상태별 건수는 선택 탭과 페이지 제한을 적용하지 않는다. 통화→고객→주문 순서로 읽기 스냅샷을 확보하고 내부 콜백은 확보한 연결을 사용한다. 상담/고객 장애 시 이 화면은 503이며 로컬 주문 목록·상세는 계속 조회할 수 있다.

다중 Pod 및 롤링 배포에서는 각 인스턴스의 `MSA_INSTANCE_IP`가 필요하다. k8s 매니페스트는 Downward API의 `status.podIP`를 주입한다. 이 값은 서비스 자격 증명으로 인증한 내부 읽기 콜백의 목적지로만 쓰며 사설 IPv4만 허용한다. 단일 인스턴스 로컬 실행은 미설정 시 기존 서비스 origin을 사용한다.

초안 조회의 AI 권한은 원본처럼 저장 고객을 우선하고, 연결이 없을 때만 활성 전화 고객을 찾는다. 미등록 발신자의 수집 이력은 보존된 전화와 통화 범위로 제한한다. 종료 통화는 자기 초안만 조회한다. 읽는 동안 통화·활성 고객의 공유 잠금을 유지하고, 원본과 같은 권한 결과를 보존하면서 참조를 일관되게 읽기 위해 스냅샷 충돌만 롤백 후 재판정한다. 조회는 초안 버전·보관 시각·감사·이벤트 이력을 변경하지 않는다.

기존 초안 복원·전화 복사 정리가 완료되면 하나의 10초 보관 워커를 시작한다. 원본과 같은 잠금으로 만료 초안 최대 100건, 주문 후보 최대 10건, 참조가 없는 오래된 청구 월 최대 100건을 정리한다. 주문은 closed_at/created_at 기준 5년, 최근 10초 접수 시도와 실제 결제·안내 I/O를 보호하며 결제 행 잠금 뒤 보호 조건을 다시 확인한다. consultation에 삭제·만료·legacy 통화를 포함한 모든 참조를 조회하고 장애 시 로컬 정리를 롤백한다. 기존 청구 합계는 재계산하지 않는다.

배송 삭제는 주문 데이터와 함께 커밋한 `OrderParcelsPurged` outbox를 기존 delivery 수신기로 전달한다. 이 보관 이벤트만 전송하므로 기존 배송 접수·다른 업무 intent를 가로채지 않는다. 중복 tick은 같은 실행을 기다리고, 실패한 전송은 기존 outbox 재시도로 복구하며 종료 시 진행 중인 실행을 기다린다. test 환경에서는 자동으로 시작하지 않는다.
