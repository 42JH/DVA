# Order 서비스

최신 모놀리식과 같은 주문 조회 4개 및 관리자 삭제 API를 제공한다. [계획과 검증 근거](../../../docs/msa-order-reads-plan.md), [전체 이식 계획](../../../docs/msa-parity-plan.md)을 따른다. [삭제 계획과 검증 근거](../../../docs/msa-order-deletion-plan.md)를 함께 따른다. 주문 생성·수정·취소·결제·청구·접수/배송 업무 이벤트·보관 워커는 후속이다.

| API | 동작 |
| --- | --- |
| `DELETE /api/orders/:id` | 관리자 soft delete·통화/결제 진행 차단·감사 확정 |
| `GET /api/orders` | 관리자 전체/AI 통화 고객 범위의 요약, 검색·기간·페이지·전체 개수 |
| `GET /api/orders/:id` | 저장 버전·상세/주소/PIN/청구 스냅샷·유효 결제 요청 |
| `GET /api/admin/orders` | 관리자 목록 화면의 검색·상태 탭·상세 |
| `GET /api/customers/:id/addresses` | ACCEPTED·ACTIVE 이전 주소, 방향/기간/검색/페이지 |

관리자 cookie·역할·입력·보관/삭제 조건·응답 envelope·에러 문구를 유지한다. 잘못된 cookie를 AI로 우회하지 않는다. AI는 기존 `call_session_seq`로 현재 발신번호의 활성 고객만 조회한다. 종료 통화는 연결된 주문 상세 한 건만 허용한다. 클라이언트에 추가 토큰이나 API를 요구하지 않는다. 원본 API의 기존 AI 접근 정책을 유지하는 범위다.

order DB에는 주문/상세/결제 요청/청구만 두고 타 소유자 테이블을 복제하지 않는다. 상담/고객 확인은 [인증된 조회 이벤트](../../shared/events/README.md)로 연결하며 같은 조회 재시도도 최신 상태를 확인한다. GET 조회는 업무/감사·outbox/inbox 쓰기를 만들지 않는다. 소유 행의 공유 잠금과 로컬 REPEATABLE READ를 사용하므로 동시 통화 종료·고객 상태 변경은 조회가 끝날 때까지 짧게 대기한다. 서비스 의존 장애는 503이며 관리자 로컬 주문 조회는 계속 제공한다.

## 실행과 배포

Node.js 24와 기존 PostgreSQL을 사용한다. `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `OPERATIONS_URL`, `CUSTOMER_URL`, `CONSULTATION_URL`, `CUSTOMER_AUTH_TOKEN`을 설정한다. `PORT` 기본값은 3002, 운영에는 기존 `SECURITY_LOG_HMAC_KEY` 64자리 hex와 `CORS_ORIGINS`를 주입한다. Liquibase order 003까지 먼저 적용해야 한다. 별도 토큰/로그 Secret 종류를 추가하지 않고 기존 최초 생성·값 보존 정책을 사용한다.

저장소 루트에서 실행한다.

```sh
docker build --target checks -t dva-order-checks -f msa/services/order/Dockerfile msa
docker build -t dva-order:local -f msa/services/order/Dockerfile msa
python3 msa/parity/verify-order.py
python3 -m unittest discover -s msa/deploy/tests -v
# 운영 kubeconfig를 사용하지 않는 로컬 Docker/k3s에서만 실행
python3 msa/deploy/tests/integration_app_rollout.py --service order --image dva-order:local
```

이미지는 기존 MSA 패키지 버전·공통 이벤트 파일 의존성을 재사용한다. Redis·브로커·새 런타임 앱은 추가하지 않는다. Jenkins `Verify Order Parity`는 operations/customer/consultation/order가 선택되면 실행하고 실패 시 배포를 중단한다. 각 서비스의 실제 배포 이력을 유지하며 모두 선택되면 operations → customer → consultation → order 순으로 배포한다.

- `/order/health`: 프로세스 상태. `/order/health/ready`: 실제 order DB와 operations 세션 인증 의존 확인.
- `/order/docs`, `/order/docs-json`: 네 업무 조회·삭제와 health만 공개한다. `/internal/order-read`, `/internal/audit/flush`는 Ingress/OpenAPI에서 제외한다.
- Ingress는 기존 `/api/orders`, `/api/admin/orders`를 전달한다. 고객 주소는 `/api/customers/[^/]+/addresses/?$`만 `ImplementationSpecific`/`PathRegexp`로 선택한다. 나머지 customer 경로와 일반 Prefix 경로는 유지한다. [Traefik 공식 설정](https://doc.traefik.io/traefik/reference/routing-configuration/kubernetes/ingress/) 및 [v3.5.4 구현의 경로별 matcher 선택](https://github.com/traefik/traefik/blob/v3.5.4/pkg/provider/kubernetes/ingress/kubernetes.go#L640)을 근거로 한다.
- 기존 RollingUpdate·앱 패키징·실패 복구를 사용한다. 운영 Jenkins/k3s/HTTPS 확인은 로컬 컨테이너·격리 k3s 검증과 구분해 보고한다.

## 삭제와 감사 확정

기존 관리자 cookie·역할·허용 Origin을 요구한다. COLLECTING/CANCELLED/ACCEPTED에서만 삭제하며 활성 통화, 승인 중 결제, SENDING 안내가 있으면 409다. 이미 삭제되거나 보관 기간이 끝난 주문은 404다. 주문 행과 결제 요청을 잠그고 consultation의 `/internal/order-deletion-check`에 `OrderDeletionCheckRequested`를 보내 boolean만 확인한다. 같은 이벤트도 현재 통화를 읽고 캐시·수신 이력·통화 변경은 만들지 않는다. 종료되지 않은 과거 통화도 원본처럼 차단한다. 의존 장애는 503이며 삭제를 커밋하지 않는다.

order 로컬 트랜잭션은 대기 결제 안내 상태와 deleted_at을 바꾸고 operations에 성공 감사를 준비한다. 업무와 AuditCommitted outbox를 함께 커밋한 뒤 감사 COMMIT/ACK까지 확인해야 204를 반환한다. 실패는 rollback/AuditAborted와 기존 FAILED/DENIED 감사를 따른다. 릴레이는 기존 250ms 재시도이며 operations는 생산자 트랜잭션 잠금 증명을 확인해 강제 종료 후 미확정 준비를 중단하거나 커밋된 감사를 확정한다. 이미 커밋된 응답 유실은 실패로 단정해 되돌리지 않는다. 분리 DB의 전역 원자성을 보장하지 않으며 장애 응답 뒤 확정 결과는 기존 GET과 감사 조회로 확인한다.

operations Liquibase 010을 앱보다 먼저 적용하고 operations → consultation → order를 배포한다. operations에 `ORDER_URL=http://order:3002`를 주입하며 기존 CUSTOMER_AUTH_TOKEN을 재사용한다. 새로운 프론트/AI 토큰과 공개 API는 요구하지 않는다. 수거/결제 취소와 물리 폐기는 이 DELETE의 역할이 아니다.
