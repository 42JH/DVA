# 주문 삭제 API 이식 계획

- Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)
- 기준: MR !355 병합 `256d8157c68cc8a252253484ab3ab8086cd4d95e`, backend tree `f5b00cd9f9d2f7e09805ed042cbc56a7e305c799` (원본 054까지).
- 브랜치: `feature/msa-order-deletion` → `develop-backend`.
- 수정 범위: `msa/`, `docs/` (필요한 경우에만 `infra/`). backend·프론트·AI는 읽기만 한다.

## 이번 MR의 완료 조건

기존 `DELETE /api/orders/:id` 하나를 원본과 같은 입력·HTTP·업무 데이터·감사 결과로 제공한다. 생성·수정·취소·접수·결제·청구·배송 이벤트·보관 워커는 후속 MR이다. API를 일부 상태에서만 성공하도록 축소하지 않는다.

1. 관리자 세션과 기존 허용 Origin, OPERATOR/SUPERVISOR/SYSTEM_ADMIN 역할, ID 검증, 204/400/401/403/404/409·실패 감사와 OpenAPI를 유지한다. AI 읽기 예외를 DELETE에 적용하지 않는다.
2. 주문 행을 잠그고 삭제·5년 만료 행을 숨긴다. COLLECTING/CANCELLED/ACCEPTED만 허용하고 결제 승인 중·안내 SENDING·진행 통화가 있으면 거절한다. 결제 요청의 PENDING 안내와 WAITING/PENDING 완료 안내를 FAILED로 바꾸고 주문의 deleted_at만 기록한다. 하위 행·스냅샷·최초 보관 기산일과 원본 trigger의 버전 규칙을 보존한다.
3. 진행 통화 여부는 consultation 소유 DB에 인증된 고정 조회 이벤트로 확인한다. 원본 SQL처럼 deleted_at/ended_at만 검사하고 과거 통화의 보관 시각으로 차단 조건을 완화하지 않는다. 이 조회는 캐시·inbox/outbox·업무 쓰기를 만들지 않는다. order의 잠금/결제 확인 뒤 호출하며 의존 장애를 성공으로 처리하지 않는다.
4. 기존 customer/consultation의 AuditPrepared → 로컬 업무+AuditCommitted outbox → operations 확정/ACK 패턴을 재사용한다. order 전용 감사 준비 테이블을 후속 operations changeset으로 추가하고 기존 이력·준비 행을 보존한다. 실패 rollback·중복 전달·COMMIT 응답 불확실·생산자 종료 후 복구도 확인한다. 새 토큰/브로커/런타임 의존성은 추가하지 않는다.
5. operations의 order 복구 주소는 선택 설정으로 추가하고 배포·fixture에 연결한다. 기존 조회·인증·감사 호출자와 배포 검증을 함께 확인한다. 비공개 경로는 Ingress와 OpenAPI에서 제외한다.

## 검증 순서

1. Linux Docker lint·TypeScript 빌드·기존 단위/E2E·작은 프로토콜/트랜잭션 검사.
2. 원본 migration과 MSA Liquibase를 별도 임시 PostgreSQL DB에 적용한다. 원본을 수정하지 않은 삭제 관련 회귀와 동일 fixture의 DELETE/후속 GET 요청·OpenAPI·업무/감사 행을 대조한다. 현재 시각/독립 identity는 의미와 범위를 검증하고 그 외 필드는 그대로 비교한다.
3. 전체 상태·결제 안내/승인·통화 삭제/종료/보관 경계, 반복/동시 삭제, 잠금 timeout, 감사 준비 실패 rollback·ACK 유실·강제 종료 복구, 위조 이벤트·비공개 경로를 확인한다. 기존 주문 읽기·customer/consultation/operations 감사 회귀를 실행한다.
4. operations changeset 초기 설치·채워진 009 업그레이드·후반 실패 rollback·재적용/기존 checksum 보존과 배포 회귀를 검증한다. 운영 Jenkins·k3s·HTTPS·외부 서비스 확인은 로컬 증거와 구분한다.
5. 검증 결과를 기록하고 작업 단위로 커밋·push·MR 생성, 같은 Jira Task에 연결한 뒤 사용자 병합을 기다린다.

## 범위와 한계

분리 DB의 전역 원자 트랜잭션을 주장하지 않는다. 성공 응답은 업무 커밋과 감사 확정 ACK 뒤에만 반환하고, 확정 응답 유실은 기존 영속 릴레이/생산자 잠금 증명으로 복구한다. 향후 통화-주문 연결 쓰기도 order 잠금·삭제 상태 검사와 연결해야 한다. 원본의 진행 통화 조회 자체는 행 잠금을 요구하지 않는다.

## 실행 결과

구현·검증 후 실제 명령과 결과를 기록한다.
