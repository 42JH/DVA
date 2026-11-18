# Delivery 서비스

기존 NestJS에서 자기 PostgreSQL DB와 인증된 주문 배송 조회·생성 이벤트를 처리한다. [주문 취소 계획](../../../docs/msa-order-cancellation-plan.md)을 따르며 기존 delivery Liquibase 스키마를 사용한다.

## 실행과 배포

기존 Node.js 24·NestJS·pg·@dva/events와 CUSTOMER_AUTH_TOKEN을 사용한다. DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME을 자기 delivery DB로 설정한다. PORT 기본값은 3003이다. k8s는 기존 delivery-db의 PG* 값과 msa-customer-auth의 customer-token을 주입하며 새 Secret 종류를 만들지 않는다.

```sh
# 저장소 루트; 다른 서비스와 같은 msa 공통 context
# builder에서 현재 단위/e2e를 한 번 검사한 production 이미지
docker build -t dva-delivery:local -f msa/services/delivery/Dockerfile msa
python3 msa/parity/verify-order.py
python3 -m unittest discover -s msa/deploy/tests -v
# 운영 kubeconfig를 사용하지 않는 격리 Docker/k3s 검증
python3 msa/deploy/tests/integration_app_rollout.py --service delivery --image dva-delivery:local
```

- `/delivery/health`: 기존 프로세스 상태. `/delivery/health/ready`: 실제 자기 DB/schema 확인.
- `/delivery/docs`, `/delivery/docs-json`: health만 공개하며 내부 조회는 제외한다.
- 비공개 `POST /internal/order-shipment-check`: 기존 token을 timingSafeEqual로 확인하고 고정 source=order/type=OrderShipmentCheckRequested, 양수 int32·중복 없는 orderParcelSeqs만 받는다. 빈 배열도 원본처럼 배송 없음이다.
- 원본과 같은 정렬된 shipment 행 FOR UPDATE 조회 뒤 같은 eventId/processed와 blocked boolean만 반환한다. 매번 현재 상태를 읽고 개인정보·응답 캐시·inbox/outbox를 저장하지 않는다. 실패는 503이며 원시 SQL 오류를 노출하지 않는다.

공개 Ingress는 기존 `/delivery`만 유지한다. `/internal/...`는 Service 내부에서만 접근한다. readiness는 자기 DB만 의존하므로 order와의 시작 순환이 없다. operations → customer → consultation → delivery → order 순으로 배포하고 기존 RollingUpdate·실패 복구를 재사용한다. 실제 운영 Jenkins/HTTPS 검증과 로컬 production/격리 k3s 검증은 구분한다.

원본 취소는 대상 배송이 존재하면 상태에 관계없이 거절하므로 배송 취소 UPDATE는 실행할 대상이 없다. 배송 생성 생산자는 order 부모 잠금과 최신 상태 검증을 지켜야 한다. 이 조회만으로 분리 DB의 전역 원자성을 보장하지 않는다.

`POST /internal/order-accepted`는 기존 토큰으로 order 이벤트를 인증한다. `OrderSubmissionDeliveryRequested`는 배송과 최초 이력을 같은 트랜잭션에서 생성한다. `OrderParcelsPurged`는 원본 보관 만료 SQL과 같은 순서로 이력·배송을 삭제하고 inbox에 개인정보 없는 parcel ID만 남긴다. 두 경로가 같은 parcel 잠금을 사용하므로 삭제와 동시에 처리되거나 뒤늦게 도착한 생성 이벤트가 만료 배송을 다시 만들지 않는다. 이벤트 inbox와 모든 데이터 변경을 함께 커밋하며 실패·중복 수신은 기존 수신기의 재시도·충돌 검사를 따른다.

## MR 전 검증 기록 (2026-10-26)

- Docker Linux Node.js 24: ESLint, 단위 1개, E2E 3개, TypeScript 빌드 통과.
- 설치 시 전체·운영 의존성 audit 취약점 0건.
- Linux Python 3.13 배포 회귀 검사 48개 통과. 신규 Delivery만 선택하고 정상 Customer·Order 및 변경 없는 DB를 생략하는 경로 포함.
- 실제 이미지 package-app.sh 패키징과 6개 파일 체크섬 통과.
- 격리 k3s v1.35.5+k3s1에서 Deployment·Service·Ingress 서버 dry-run 통과.
- 같은 격리 클러스터에서 최초 배포·정상 교체·readiness 실패 후 이전 버전 복구 통과. HTTP 413건 중 실패 0건. 실패를 의도한 배포의 progress deadline 오류는 복구 시나리오의 일부다.
- 운영 Jenkins 실행과 외부 HTTPS는 아직 실행하지 않았다. 병합 후 확인한다.
