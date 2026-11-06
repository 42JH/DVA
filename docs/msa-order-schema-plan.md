# 주문·배송 저장 구조 최신 계약 동기화

Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)

## 기준과 범위

MR !341 병합을 확인하고 develop-backend `497bce5353d51e15ae36042a46cd9999c4ab447c`에서 feature/msa-order-schema를 분리했다. backend tree `f5b00cd9f9d2f7e09805ed042cbc56a7e305c799`, 원본 054까지가 읽기 전용 계약이다. 원본의 최신 주문 물품가액 1원~1억원 검증은 앱 정책이며 임의의 새 DB 제약으로 과거 행을 지우지 않는다.

다음 통화 이벤트의 주문 소유권·미답변/통화 목록의 주문 연결·주문 API/결제·청구 구현을 위해 order/delivery DB가 먼저 최신 필드·상태를 표현할 수 있어야 한다. 현재 order/delivery는 초기 001과 이벤트 전달 002뿐이며 주문 상태·좌표·배송 정책이 최신 원본과 다르다. 이번 MR은 이 선행 저장 구조와 이관 검증에 한정한다. 새로운 공개 API나 아직 미구현인 주문 업무를 완료했다고 보고하지 않는다.

수정은 msa/infra/docs 내부로 한정한다. backend/frontend/ai·루트 파일은 수정하지 않는다. 새 앱·Redis·브로커·의존성을 추가하지 않는다. 기존 적용 SQL/체크섬과 outbox/inbox 대기/이력은 보존한다.

## 계획 → 구현 → 검증

1. 원본 전체 migration을 실제 임시 PostgreSQL에 적용해 최종 order/order_parcels·결제 요청·청구/빈 AI 결과·shipment/history의 컬럼·타입·기본값·인덱스·CHECK·함수/트리거를 확인한다. 다른 서비스 FK는 소유권을 유지하는 논리 참조로 명시하고 실제 로컬 FK는 보존한다. 고객/기업/통화/관리자 테이블을 복제하지 않는다.
2. 기존 001/002를 바꾸지 않고 order/delivery 후속 changeset을 추가한다. 원본에서 제거한 좌표·폐기 SQL workflow는 후속 변환으로 정리하고 ID·실제 업무 값·시각·시퀀스·대기 이벤트를 보존한다. 원본의 확인된 이관 규칙만 적용하고 분리 서비스의 알 수 없는 과거 관계/결제 결과를 추정하지 않는다. 필요한 원본 연결 정보가 없으면 이를 보존한 채 적용을 명시적으로 거절한다.
3. 신규 설치/재적용과 기존 채워진 002 DB의 업그레이드를 검사한다. 모놀리식과 동일 초기 업무 행을 원본 규칙으로 변경해 최종 필드·상태·함수 결과를 비교한다. 보존/삭제·금액·결제 claim/재시도·유일성·로컬 FK·이력/시퀀스, SQL 후반 강제 실패의 DDL/행/이력 전체 rollback과 부적합 행 거절을 검증한다.
4. 전체 Liquibase 실제 PG 검증·이벤트/기준 목록·영향받는 배포 선택/패키징 회귀를 실행한다. 계획/구현/검증 단위로 커밋하고 같은 Task에 연결한 develop-backend 대상 MR을 생성한다. 사용자 병합 확인 후 주문/교차 서비스 API 구현을 진행한다.

## 구현 범위

- order 003: 주문 헤더·상세 상태/운임·결제 요청/승인 claim/안내·완료 안내·승인 재조회·기업 월 청구/주문별 청구·빈 AI 최종 결과·5년 보관/접수 재시도 필드와 인덱스를 추가한다. 주문/결제/청구의 로컬 FK 3개는 실제 FK로, 고객/기업/부서/통화/관리자는 논리 참조로 유지한다. 원본 043의 상세 좌표 4개를 제거한다.
- 기존 002의 COLLECTING/CANCELLED만 이관한다. 원본 018처럼 SUBMITTING/ACCEPTED/AUTH_FAILED/REVIEW_REQUIRED/EXPIRED를 결제로 추정하지 않고 SQL 전체를 거절한다. 원본 014처럼 취소 상세를 변환하되 버전/시각은 바꾸지 않는다. 확인 가능한 취소 감사가 없는 초기 MSA에서는 원본 045의 created_at fallback만 사용한다. 작성자·실제 결제·청구·생성 요청은 만들지 않는다.
- 원본의 현재 헤더 시각/최초 종료·상세 잠금/버전·취소·검증된 관리자 수정 범위·실제 보관 만료 예외 함수 5개와 트리거 4개를 이식했다. 기존 MSA의 결제 전 접수/잘못된 회복·모든 상세를 암묵적으로 발행하던 SQL 함수와 이벤트 트리거는 제거했다. 호출자는 초기 SQL fixture와 설계 문서뿐이며 현재 앱에는 등록되어 있지 않다. 대기 이벤트 자체는 보존한다.
- delivery 003: 최신 ADMIN/AI/SYSTEM 및 주체 번호 제약을 반영한다. 주문 접수 후 paid로 생성하는 현재 원본과 충돌하는 notPaid 생성/수신·임의 상태 쌍 변경 함수는 제거했다. 배송 행·명령 UUID·버전·배송/상태 이력 시각은 재작성하지 않는다. 공개 API·주문→배송 이벤트 구현은 후속이다.
- 원본 migration 전체를 실제 별도 DB에 적용하여 최종 컬럼·타입·NULL·기본값·identity·CHECK/유일성/로컬 FK·인덱스·트리거와 함수 원문을 비교한다. 원본 고객/주문 상세 외부 FK 두 개만 이름을 확인해 제외한다. 초기 SQL workflow 검증은 002에 그대로 실행하고 새 저장 규칙 검증을 원본/새 MSA 양쪽에 실행한다.

## 검증 중 확인한 원인과 수정

- 최초 전체 실행은 검증기의 외부 FK 판별에서 중단됐다. 주문·배송 테이블을 한 묶음으로 보아 배송→주문 상세를 내부 참조로 잘못 분류한 원인이다. 각 서비스의 소유 테이블 집합으로 판별하도록 수정하고 원본 외부 FK 두 개의 이름을 정확히 확인하는 기대값은 유지했다.
- 다음 전용 실행에서는 테이블 카탈로그 8개가 모두 일치했으나 함수 원문 비교가 중단됐다. Windows의 text 표준 입력이 원본 SQL의 LF를 CRLF로 바꾼 것이며 5개 함수의 차이가 해당 줄바꿈뿐인 것을 확인했다. 공통 검증기의 SQL 입력을 UTF-8 bytes로 전달하도록 수정했다. 함수 비교에서 줄바꿈을 지우거나 기대값을 완화하지 않았다.
- 수정 후 주문·배송 전용 실행은 `passed=true`, 실행 label 129개를 통과했다. 실제 원본 migration 53개, 테이블 8개·함수 5개, 원본/새 MSA 저장 규칙, 동일 초기 행의 이관 비교, 5개 과거 상태 거절, DDL/함수/데이터/이력 전체 rollback·이벤트/시퀀스 보존·재적용을 포함한다. label은 독립 테스트 개수가 아니다.
- 초기 MSA에서 자동 생성된 로컬 constraint 이름은 유지하고 정의를 비교한다. 원본 주문·배송 경로는 constraint 이름으로 분기하지 않으며 공통 HTTP 오류 변환도 SQLSTATE를 사용한다. 외부 FK만 서비스 경계에 따라 논리 참조로 대체한다.

## 최종 검증 (2026-11-06)

- `python msa/liquibase/verify.py`: PostgreSQL 17.11·Liquibase 5.0.4 전체 재실행 `passed=true`, 실행 label 545개. 위 주문·배송 전용 범위와 함께 5개 DB의 신규/재적용·preview 무변경·기존 업그레이드·부적합 행 거절·후반 SQL 실패 rollback·대기 이벤트와 기존 changeset 보존을 통과했다. label은 독립 테스트 개수가 아니다.
- 최종 검증 이미지 ID는 `sha256:e9702f50a6f52e3fa1b8e3ac35c535b310b8f97611251bbc269bf2edeefe3aa3`이다. 실제 Liquibase 이미지의 신규 order 8개 테이블/로컬 FK 3개/changeset 3개와 delivery 4개 테이블/로컬 FK 1개/changeset 3개를 확인했다. 검증 후 해당 임시 PostgreSQL 컨테이너와 network를 제거했다.
- `python msa/shared/events/verify.py`: 실제 PG·HTTP 전달/경합/충돌/rollback/응답 유실·SIGKILL/재시작 통합 15개, API/migration/worker 기준 목록 1개 통과. 원본 migration은 054까지 53개이며 이번 공개 API 선언 증가는 없다.
- Linux Python 3.13의 `python3 -m unittest discover -s msa/deploy/tests -v`: 배포 선택·패키징·적용 해시·DB 실패 중단·앱 복구 회귀 61개 통과. 기본 WSL에는 Bash가 없어 suite가 실행되지 않았으며 별도 Linux Docker에서 같은 suite를 실행했다. 운영 kubeconfig/SSH/DB는 사용하지 않았다.
- Python 구문·새 파일 LF/공백·Git diff 검사 통과. 기준 `497bce5`와 backend tree `f5b00cd9f9d2f7e09805ed042cbc56a7e305c799`가 최종 fetch 후에도 동일하다. 수정은 msa/docs 12개 파일이며 기존 001/002 SQL·backend/frontend/ai·루트·의존성·앱 코드는 변경하지 않았다. 앱 HTTP/전체 동등성·Jenkins/k3s/실제 외부 연동을 통과했다고 확대하지 않는다.

## 영향과 미검증 범위

서비스별 changelog·새 SQL·SQL fixture/비교 검증기·카탈로그 기대 수치·README/전체 계획·DB 패키징/선택 검증이 영향 범위다. 기존 공개 앱 계약과 자동 운영 배포의 선택/복구 정책은 유지한다. 실제 서버 DB·Jenkins/k3s·외부 결제/디버/AI 연동은 임시 DB 검증과 구분한다. 이 단계는 저장 계약 기반이며 주문/배송/결제/청구 API·통화 이벤트 수집·FAQ 전환·보관 워커와 전체 동등성은 계속 후속이다.
