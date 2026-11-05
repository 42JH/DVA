# Customer 쓰기 MR 계획

Jira [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160), 기준 !281 병합 `9b07aab`, 브랜치 `feature/msa-customer-writes`.

이번 MR은 고객 등록 1개, 기업·부서·구성원 쓰기 각 3개, 총 10개를 기존 조회 7개 위에 추가한다. 통화/주문 의존성이 있는 컨텍스트·고객 PATCH·월 청구·PIN 3개는 6개 선언을 그대로 후속 범위로 남긴다. frontend/AI/backend는 읽기 전용이며 추적 변경은 msa/infra/docs만 허용한다.

성공 감사는 operations가 소유한다. customer 업무 트랜잭션 중 원본 INSERT·제약·트리거로 감사 행을 준비하고 운영 조회에는 아직 노출하지 않는다. 고객 업무와 감사 확정 outbox를 함께 COMMIT한 뒤 operations의 inbox+확정 감사 COMMIT/ACK까지 확인해야 성공 응답한다. 업무 rollback은 abort outbox를 남기며 늦은 준비 이벤트는 트랜잭션 단위 tombstone으로 차단한다. COMMIT 응답 유실에는 실제 커밋 여부를 임의로 단정해 abort하지 않는다. 감사 조회는 준비 행이 있으면 customer에 결정 확인 이벤트를 보낸다. customer는 업무 트랜잭션의 PG 잠금이 유지되면 대기 상태를 보존하고, 잠금 해제 후 확정 outbox가 있으면 전달하며 없으면 중단을 확정한다. 이를 실제 생산자 SIGKILL·중복·지연 확인으로 검증한다.

공통 @dva/events를 그대로 의존성으로 연결한다. customer/operations Docker 빌드 context는 msa/로 바뀌므로 Jenkins·비교 검증기·k3s fixture·README의 모든 호출자를 함께 갱신한다. 새 Redis·브로커·외부 앱은 추가하지 않는다.

customer 005는 기업 PIN의 부서·soft delete 및 원본의 좌표 제거 규칙을 적용한다. 좌표 제거는 원본 043처럼 PIN 버전/소유권을 보존하며 기존 값을 임의 생성하지 않는다. 유일하게 증명되는 정규화 부서명만 기존 기업 PIN에 연결한다. 운영 적용 전 별도 백업이 필요한 변환이며 기존 changeset은 변경하지 않는다. operations 005는 비공개 감사 준비 상태를 추가한다. 중단된 트랜잭션의 미확정 준비 상태는 잠금·outbox로 복구하며 기술 상태의 장기 보관/정리 정책은 후속 전체 보관 단계에서도 검증한다.

원본 production의 OrderMaintenanceWorker가 기업 생성 뒤 월별 청구 초기화와 시스템 감사를 자동 수행하는 경로를 비교 중 확인했다. 해당 주문/청구 워커는 아직 이식하지 않았으며 원본을 수정하거나 감사 비교에서 행을 제외하지 않는다. production 이미지의 조회·Secure 쿠키 검사를 유지하고, 쓰기 비교는 양쪽의 기본 NODE_ENV=test에서 자동 업무 워커를 제외한 요청 처리·감사·DB를 전체 비교한다. compiled 앱 코드와 원본 입력 검증 테스트는 변경하지 않는다. 이는 production의 전체 워커 동등성이나 월별 청구 데이터 검증을 의미하지 않는다.

검증 순서는 입력/컴파일/이미지 → 실제 PG schema/이관/rollback → 양쪽 HTTP·고객 데이터·감사 DB 비교 → 준비 실패/업무 rollback/중복/늦은 이벤트/재시도·직후 감사 조회 → 기존 operations·이벤트·배포 회귀 → 임시 k3s 배포/복구다. 전체 분산 장애·운영 Jenkins/공개 HTTPS·남은 6개 및 전체 95개 API가 통과한 것으로 확대하지 않는다.

## 검증 기록 (2026-11-05)

- `python msa/parity/verify-customer.py`: production 조회/인증 77건과 7개 GET OpenAPI, 원본 직원 입력 테스트 4개 통과. 동일 compiled 이미지의 NODE_ENV=test에서 쓰기/조회/인증 54건과 추가 쓰기 OpenAPI 10개 및 참조 DTO를 대조했다. 각 응답 후 고객 업무 6개 테이블과 감사 전체 행이 일치했다. 원본 테스트·backend 소스·기대값은 수정하지 않았다.
- 준비 단계 감사 제약 실패 시 고객 rollback, 업무 SQL 실패, 동일 이벤트 재수신과 payload 변조, 중단 뒤 늦은 준비, 확정 전달 지연 후 직후 감사 조회, 실제 생산자 SIGKILL 시 업무 rollback과 잠금 해제 뒤 미확정 감사 중단을 검사했다. 준비 행을 임의 시간 초과만으로 폐기하지 않는다. COMMIT 응답 미확정 시 abort를 보내지 않는 경계는 별도 DB wrapper 단위 테스트에 포함한다.
- customer 이미지의 ESLint·TypeScript·단위 1개·E2E 5개와 인증 연결 6개·DB 감사 경계 4개 통과. 3,001개 감사의 확정 본문이 HTTP 제한을 넘던 실패를 재현하고 1,000개씩 같은 업무 트랜잭션의 outbox에 저장해 마지막 ACK까지 확인하도록 보완했다. 실제 PG/HTTP에서는 첫 확정만 끝나고 마지막 확정이 지연될 때 감사 조회가 일부만 반환하지 않는 것을 확인했다. operations 이미지의 ESLint·TypeScript·단위 1개·E2E 6개 통과. `verify-operations.py`에서 변경하지 않은 원본 인증 테스트 40개가 양쪽에서 각각 통과했고 operations 설정 2개·기존 11개 API의 production HTTP/DB 비교·실제 배포 probe도 통과했다.
- PostgreSQL 17.11 + Liquibase 5.0.4 검증 보고서 `passed=true`, 228단계 통과. 5개 서비스 신규 설치·기존 이력·대기 메시지·업무 함수·005 이관과 후반 실패 rollback을 확인했다. customer/operations의 기존 적용 changeset은 수정하지 않았다.
- `python msa/shared/events/verify.py`: 이벤트 단위 5개, 실제 PG/HTTP 통합 15개, 기존 95개 API·migration·worker 기준 목록 1개 통과. 직접 전송도 기존 릴레이와 같은 URL 검증을 적용해 잘못된 목적지에 서비스 토큰을 보내지 않는다. Linux 배포/변경 선택/실패 복구 54개와 변경 Python 5개·Bash 13개·Jenkins shell 블록 3개 구문 검사 통과. customer/operations 운영 의존성 `npm audit --omit=dev`는 각각 0건이다.
- 기존 운영 kubeconfig를 쓰지 않는 임시 k3s v1.35.5+k3s1에서 실제 이미지·별도 DB·Liquibase·Secret으로 최초 배포·정상 교체·readiness 실패 후 이전 리소스/이미지 복구를 확인했다. 최종 customer HTTP 457건, operations 450건에서 실패 0건이다. 테스트가 생성한 Docker 자원만 라벨을 확인해 정리했다.
- 현재 production의 월별 청구 초기화/자동 감사는 아직 이식 전이다. 쓰기 비교의 test 모드 성공을 production 자동 워커·전체 DB·95개 API 동등성으로 확대하지 않는다. 실제 운영 Jenkins/공개 HTTPS·장기 보관·전체 분산 장애 및 남은 customer 6개는 후속 검증이다. 005의 기존 PIN 좌표 제거는 운영 백업을 먼저 준비해야 한다.
