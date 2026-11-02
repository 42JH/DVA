# 모놀리식 DB 마이그레이션

Jira: S15P31D109-129 · 브랜치: `feature/monolith-db` · MR 대상: `develop-backend`.

## 적용 기준

`041-call-summary-metrics.sql`은 `call_analyses`에 신규 고객 여부, 접수 확정 배송 상세 수, FAQ 답변 건수, 접수 조회 건수, 취소 배송 상세 수, 상담원 연결 요구 여부의 nullable 컬럼 6개를 추가한다. 기본값·기존 행 보완은 없으며 기존 해시·시각·페르소나 참조를 보존한다. 네 건수는 0 이상 int32다. AI가 실제 사용 버전과 요약 값을 전송하고 백엔드는 집계하지 않는다. 생략·null은 미수집, 0·false는 확인한 없음이다. [수신·재전송·프론트 조회 계약](../api/call-analysis.md)을 따른다.

`042-remove-call-analysis-result.sql`은 같은 테이블의 대표 분류 `result`와 해당 CHECK를 삭제하고, 기존 분석 전체의 `payload_hash`를 result 없는 정규화 본문으로 갱신한다. 요약·불만·시각·실제 페르소나·PK/FK와 다른 테이블의 데이터는 보존한다. 041·042를 순서대로 적용하며 실제 운영 적용은 별도다. 컬럼 값은 삭제되므로 기존 백엔드 중지 → 백업 → runner·verify → 새 계약의 앱 실행 순서로 진행한다. AI 요청·프론트 표시·목록 필터도 함께 전환하고 구버전 앱으로의 이미지 단독 복귀를 금지한다. 042는 분석 행 전체 갱신·배타 잠금이 필요하므로 데이터가 많은 환경의 적용 시간은 별도로 측정한다. 실패 시 SQL·이력은 트랜잭션으로 롤백된다.

`monolith.dbml`은 사용자가 전달한 2026-10-25 ERD에 현재 migration을 반영한 문서다. 단일 PostgreSQL DB,
042까지 public 업무·운영·관리자 테이블 29개와 public FK 25개를 사용한다. PBX 수신함까지 ERD 30개 테이블·284개 컬럼·물리 FK 26개이며, 고객·주문·상담·배송·운영 모듈별 주석으로 구분한다.
실제 모놀리식 배포 원본은 `backend/migrations/`이며 `msa/`는 적용하지 않는다.

- `001-pbx-call-ended.sql`: 기존 PBX 웹훅 수신 테이블. 기존 앱 시작 시의 생성 동작을 유지한다.
- `002-monolith-initial.sql`: 업무 테이블·제약·특수 인덱스·함수·생성 컬럼·트리거.
- `003-admin-auth-sessions.sql`: 관리자 이름과 PostgreSQL 세션 저장소. 기존 관리자 데이터가 있다면 이름 보완 정책이 필요하며 자동 채우지 않는다.
- `004-organization-creation-requests.sql`, `005-customer-creation-requests.sql`, `007-order-creation-requests.sql`: 과거 기업·고객·주문 생성 요청 기록. 적용 이력과 체크섬 보존을 위해 파일을 유지한다.
- `008-simplify-creation-requests.sql`: orders.creation_request_id UUID UNIQUE 추가 → 기존 주문 요청 키 이전 → 기업·고객·주문 요청 기록 테이블 및 api_idempotency 스키마 제거. 업무 데이터·주문 version·updated_at·감사·통화 연결·PBX 기록은 보존한다.
- `009-membership-write-requests.sql`: 과거 구성원 등록·CSV 처리 기록. 이미 적용된 원본·체크섬·이력을 그대로 보존한다.
- `010-remove-membership-write-requests.sql`: 구성원 요청 기록 테이블과 전용 스키마를 제거한다. 009를 포함한 기존 적용 이력과 고객·기업·소속·주문·감사·PBX 데이터는 보존한다.
- `011-call-recording-correlation.sql`: `call_sessions.incoming_at`에 OpenAI 이벤트 시각을 보관하고, 기존 PBX 수신함에 `call_session_seq`·`last_attempt_at`을 추가한다. 녹취 연결 고정과 재처리에 필요한 변경이며 테이블은 추가하지 않는다. 기존 행은 새 컬럼을 NULL로 유지한다.
- `015-admin-deletion-audit.sql`: 감사 작업자·대상 관리자 이름 보존, AI 주체 구분, 관리자 INACTIVE 상태 허용, 관리자 참조 5개를 논리 참조로 변경. 세션의 삭제 cascade는 유지하며 테이블은 추가하지 않는다.
- 과거 actor별 키가 서로 다른 주문에서 중복되거나 한 주문에 여러 키가 있으면 008 전체를 롤백하고 중단한다. 임의 키 재발급이나 주문 병합은 하지 않는다. 기존 생성 키가 없는 주문은 NULL을 유지하고 신규 API 생성은 키를 필수로 저장한다.
- 미완료 주문은 기존 orders·order_parcels의 COLLECTING 상태다. 별도 상담 테이블은 추가하지 않는다. MR 초안의 미배포 006-incomplete-consultations.sql은 제외했으며 운영 DROP/초기화는 수행하지 않는다.
- `db_migrations.applied_versions`: 파일명·SHA-256·적용 시각. ERD 업무·운영 테이블과 별도다.
- `pbx_webhooks.call_ended_events`: 기존 연동 수신함이며 ERD에는 상담 모듈로 표시한다.

고객 상태는 ACTIVE/WITHDRAWN, 기업 상태는 ACTIVE/INACTIVE, 관리자 상태는 ACTIVE/PENDING/INACTIVE다.
사번은 TEXT NOT NULL이며 기업별로 고유하다. 문자열 그대로 비교하므로 공백 제거·대소문자 통합,
직원 JSON 단건·복수 등록·갱신은 [구성원 계약](../api/members.md)을 따른다. `auth_version`과 기본 관리자 계정은 생성하지 않는다.

## 부서·주문 결제 전환 — 138

현재 배포에는 016~019가 함께 필요하다. 적용된 001~015의 파일·체크섬은 변경하지 않는다.

- 016: 상세별 가변 배송비와 주문 total_amount, AI 배송 이력 주체를 추가한다.
- 017: departments와 구성원의 필수 department_seq, 개인·기업 월결제 및 부서 그룹결제 자격을 추가한다. 기존 구성원이 있으면 [실제 부서 배정표](../api/departments.md)를 먼저 준비한다. 누락·기업 불일치·잘못된 이름은 추정하여 채우지 않고 중단한다.
- 018: 주문 status를 결제 대기·완료·디버 접수중·완료·실패·취소로 연결하고 order_payment_requests를 추가한다. 기존 COLLECTING/CANCELLED 이외 주문이 있으면 결제 여부를 추정하지 않고 중단한다. 배포 전에 현황과 별도 이관 정책을 확인한다.
- 019: order_billing_charges의 주문당 1회 기업 청구 원장과 organization_billing_months의 월결제·그룹결제 별도 합계를 추가한다. 이미 018에서 결제된 주문은 실제 paid_at과 기업 스냅샷으로 보완한다.

월별 행은 KST 첫날 0원으로 시작하고 이전 월은 보존한다. 증가·새 월 초기화는 SYSTEM 감사와 함께 저장한다. 부분 취소는 상세 원래 금액을 보존하며 남은 합계로 결제 요청을 교체한다. 만료·취소가 상세·통화·녹취·감사를 삭제하지 않는다.

최초 전환은 기존 백엔드 중지 → 백업 → 실제 배정 확인 → migration·검증 → 새 앱 실행 순서다. 전환 뒤에는 019가 없는 구버전 앱으로 복귀하지 않는다. 배포 스크립트가 해당 복귀를 차단하며, 실패 시 호환 앱으로 복구하거나 중지 후 백업을 별도 DB로 복원·검증한다. 이번 브랜치의 migration은 임시 DB에서 검증하며 실제 운영 적용은 별도다.

## FAQ 변경 알림 — 020

`020-faq-change-notifications.sql`은 `faq_change_notifications` 한 테이블과 미전송 행의 부분 인덱스를 추가한다. 기존 FAQ·관리자·감사 데이터는 바꾸지 않는다. FAQ 번호 배열은 삭제 후에도 보존해야 하므로 FAQ에 실제 FK를 두지 않는다.

관리자 API와 초기 등록 명령은 FAQ·감사·알림 대기를 같은 트랜잭션에 저장한다. 워커는 점유·결과와 SYSTEM 감사를 각각 커밋하고 외부 HTTP는 트랜잭션 밖에서 호출한다. `sent_at`은 AI 202 수신 확인이며 색인 완료가 아니다. 새 앱 실행 전에 020을 적용한다. 이미 존재하던 FAQ의 알림을 소급 생성하지 않으므로 최초 AI 원본 확인은 [연동 규격](../api/ai-faq-integration.md)을 따른다.

## 기업·부서 삭제와 기록 보존 — 021

021은 주문의 청구 기업/부서와 청구 원장·월별 합계를 현재 기업/부서의 FK에서 분리하고 당시 번호·이름을 보존한다. 고객·소속·부서·PIN의 현재 관계 FK는 유지한다. PIN에는 같은 기업의 부서 번호를 추가하며 기존 부서명으로 유일하게 확인되는 항목만 연결한다. 애매한 항목을 임의로 기업 공용으로 바꾸지 않는다.

기존 주문 이름은 이관 시 확인 가능한 현재 이름으로 보완하며 주문 내용·버전·updated_at은 유지한다. 과거 실제 이름의 소급 복원은 불가능하다. 기업·부서 삭제의 범위·미배정 PIN 처리·감사·AI 영향은 [삭제 API 계약](../api/company-deletion.md)을 따른다. 이관 전 쓰기 중지와 백업이 필요하며 021 없는 앱으로의 배포·롤백·자동 복귀는 차단한다. 실제 주문 결제 연동은 022로 이어진다.

## 검증 실행

Docker Desktop의 Linux 컨테이너 모드와 `postgres:17-alpine` 이미지가 필요하다.

```powershell
./infra/database/test-monolith.ps1
```

포트·호스트 볼륨·외부 네트워크 없이 tmpfs 기반 임시 DB를 사용한다. 기존 동명 검증 컨테이너가
있으면 중단한다. 검증 종료 시 이번 실행에서 만든 컨테이너만 정리한다. SQL 검증 데이터는 롤백한다.

검증 범위:

- public 테이블 27개·FK 25개·트리거 10개, 기존 PBX 데이터 보존.
- 고객·기업·관리자 상태값, 기업별 사번 중복·공백·NULL.
- 주소 검증·정규화된 PIN 중복 방지·검색용 생성 컬럼·PIN 소유권 및 버전.
- 주문 헤더·상세 변경 버전, 접수 후 상세 복사본 수정 방지, 주문 생성 UUID 유일성, 기존 요청 키 이전·업무 데이터 보존·키 충돌 거절·테이블 삭제 롤백.
- 통화 시각 제약, 녹취 객체 경로, 배송 참조 무결성·작업 주체 제약.
- 전역 ACTIVE·PENDING 각각 최대 1개·페르소나 전체 설정 이력 수정 방지, FAQ 수정 시각·감사 JSON 객체.
- FAQ 삭제 후에도 알림 번호 보존, UPDATE 알림 단건 제약, 점유·전송 상태와 입력 배열 제약.
- 마이그레이션 전 백업의 별도 DB 복원, 재실행 건너뛰기, 적용 파일 변조 거부.
- 후속 SQL 실패 시 신규 변경 전체 롤백, 최초 적용 실패 시 테이블·이력 전체 롤백.

검증 스크립트는 Docker 호스트용 runner를 테스트 컨테이너 안에서 실행하기 위해
`backend/database-tests/docker`를 해당 컨테이너의 임시 PATH에만 넣는다. 실제 서버에서는
실제 Docker CLI를 사용한다. 다른 환경의 PATH에 이 테스트 파일을 추가하지 않는다.

## 서버 적용

008·010은 구버전 앱이 사용하는 요청 기록 테이블을 삭제한다. 이 전환은 [릴리스 배포 절차](../../infra/deploy/README.md)에 따라
기존 백엔드 중지 → DB 백업 → migration/검증 → 새 앱 실행 순서로 적용한다. 아래 수동 runner만 실행해
구버전 앱을 계속 켜 두면 등록 API가 실패할 수 있다. 직접 적용할 때도 같은 중지·백업·앱 교체 순서를 지킨다.

서버에는 다음 구조를 가진 전용 적용 폴더를 전송한다. 앱 이미지·배포 릴리스는 변경하지 않는다.

```text
backend/migrations/*.sql
infra/database/migrate.sh
infra/database/verify.sql
docs/database/monolith.dbml
SHA256SUMS
```

전송 파일의 체크섬과 기존 서버 테이블을 먼저 확인한 뒤 실행한다. 비밀번호는 서버 DB 컨테이너의
환경변수를 사용하며 출력하지 않는다. DB 포트를 외부에 개방하지 않는다.

```sh
sha256sum -c SHA256SUMS
sudo sh infra/database/migrate.sh dva-prod-db-1 /home/ubuntu/dva-deploy/shared/db-backups
sudo docker exec -i dva-prod-db-1 sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < infra/database/verify.sql
```

runner는 먼저 권한 600인 PostgreSQL custom-format 백업과 SHA-256 파일을 만든다.
archive 목록 확인 후 advisory lock과 하나의 트랜잭션으로 미적용 migration을 실행한다.
동일 파일은 건너뛰고 이미 적용한 파일의 체크섬이 다르면 중단한다. SQL 오류 시 미커밋 변경은
전체 롤백된다. 기존 업무 테이블과 충돌하면 자동 삭제·덮어쓰기하지 않고 실패한다.

백엔드 자체는 시작 시 001만 실행한다. Jenkins 배포는 릴리스에 포함된 runner를 앱 교체 전에 실행한다.
일반 개발 배포는 `--no-backup`으로 DB 백업을 생략하며, 적용 이력·체크섬·트랜잭션은 유지한다.
008과 010의 최초 전환은 예외로 기존 백엔드를 중지하고 `shared/db-backups`에 백업한 뒤 실행한다.
마이그레이션 이후 `verify.sql` 검증까지 성공해야 새 앱을 시작한다. 앱을 직접 실행하는 경우에는 runner를 별도로 실행한다.

```sh
# 중지·백업이 필요한 008·010 전환을 제외한 개발 DB 적용
sudo sh infra/database/migrate.sh --no-backup dva-prod-db-1
```

위의 기존 수동 명령처럼 `--no-backup`을 생략하면 백업을 만드는 동작은 유지된다.

## 생성 중복 처리 기준

기업 등록은 독립 요청이며 같은 이름을 허용한다. 고객은 phone_number UNIQUE, 직원은 기업+사번, PIN은 기존 주소 UNIQUE를 사용한다. 기업·고객·구성원 등록은 별도 요청 기록을 사용하지 않는다. 구성원 기록은 010으로 제거했으며 기존 고객 연결 중복은 고유 제약, 이름·전화번호 JSON 재등록은 기업·사번 기준 갱신으로 처리한다.
주문은 orders.creation_request_id와 통화 연결을 사용한다. 재시도는 기존 주문의 현재 버전을 반환하며 최초 본문·응답은 보관하지 않는다.
배송 상태 이력의 request_id, PBX 수신 기록, 기존 version·감사·세션 테이블은 유지한다.
57번 최종 접수는 기존 orders의 order_seq·status·version·updated_at을 사용한다. 주문 행을 잠근 뒤 SUBMITTING을 커밋한 요청만 외부로 전송한다. 재호출은 상태만 반환하며 별도 접수 키·컬럼·테이블·migration을 추가하지 않는다. 과거 cat 결제도 일괄 변경하지 않는다. 상세 계약은 [ORD-06](../api/order-submit.md)을 따른다.

## 이후 변경 및 복구

022은 실제 주문의 토스 결제 식별자·처리권·안내 발송 상태를 기존 `order_payment_requests`에 추가한다. 새 테이블은 만들지 않는다. [결제 연동](../api/order-payment-integration.md)을 따른다.

023은 결제 완료 안내 상태·시도 시각·성공 시각을 같은 `order_payment_requests`에 추가한다. 이미 완료된 결제 요청은 완료 안내 발송 대기로 이관하며, 기존 결제·주문·요청 안내 발송 이력은 보존한다.

024-call-analyses.sql은 통화당 최종 분석을 저장하는 call_analyses 한 테이블을 추가한다.
통화·실제 사용 페르소나 버전 FK, 통화당 PK, 시각·횟수·불만 배열·본문 해시 제약을 둔다.
기존 통화·주문·페르소나·FAQ 데이터는 수정하거나 추정 보완하지 않는다. 새 앱 실행 전에 024를 적용한다.
이벤트·미답변 테이블과 조회용 뷰는 이 migration에 포함하지 않는다. [ANL-01](../api/call-analysis.md)을 따른다.

025는 기존 분석의 불만 위치를 offsetMs에서 정수 초 offsetSeconds로 변환하고 같은 요청의 재전송 해시를 갱신한다. 분석 저장 시각은 보존한다.

026은 call_insight_events와 미답변 참조 기반 unanswered_questions를 추가한다. 이벤트 UUID·통화별 순번·발화 연결을 고유하게 보존하고, 위치는 정수 초다. AI 동작 status는 저장하지 않는다. 질문은 [UNQ-01](../api/unanswered-questions.md)로 수집하고 [UNQ-02](../api/unanswered-questions-read-spec.md)로 목록·검색 조회한다. [UNQ-03·UNQ-04](../api/unanswered-questions-management.md)는 기존 전환·삭제 상태 필드를 사용한다. FAQ 삭제를 막는 FK는 추가하지 않는다. [EVT-01](../api/call-events.md)을 따른다. UNQ-01·UNQ-02는 기존 026을 사용하며 추가 migration이 없다. 통계용 뷰는 별도 후속 작업이다.

027-faq-categories.sql은 faq_entries에 필수 category를 추가하고 기존 32개 질문을 [검토한 분류표](faq-category-assignments.md)대로 보완한다. 기본값은 없으며 미확인 추가 질문이 있으면 적용을 중단한다. 원문·관리자·시각·AI 알림 대기는 보존한다. 분류 보완 동안 두 FAQ 트리거만 같은 트랜잭션·배타 잠금 안에서 정지하고 복구하며 실패 시 스키마와 함께 롤백한다. SHA-256은 e6485628eb55e7bb930fc8499b0d39b8cb1a89de78b79b65c31302ab5df01dc9다. 실제 DB 적용은 이번 작업에서 제외한다.

이미 적용한 SQL 파일을 수정하지 않고 다음 migration은 `031-설명.sql`부터 순서대로 추가한다.
체크섬은 파일의 실제 바이트를 사용한다. `.gitattributes`로 신규 migration의 줄바꿈을 LF로 고정하고,
기존 001은 최초 서버 적용 바이트와 같은 CRLF로 유지한다. 플랫폼 간 줄바꿈 변환으로 인한
허위 체크섬 불일치를 방지하기 위한 설정이다.
기존 데이터가 있는 필수 컬럼 추가는 nullable 추가 → 데이터 보완 → 제약 적용 순으로 진행한다.
상태 축소는 제거될 값의 현황과 변환 정책을 먼저 확인한다.

적용 중 실패하면 트랜잭션 롤백 후 원인을 수정한다. 성공 후에는 앱 이미지 롤백만으로 DB가
되돌아가지 않는다. 보완 migration을 우선 고려하고, 백업 복원이 필요하면 서비스를 정지하고
별도 DB에 복원·검증한 뒤 전환한다. 운영 DB에 `--clean`, 테이블 삭제 또는 볼륨 초기화를 실행하지 않는다.
008·010 적용 후에는 삭제된 테이블을 요구하는 구버전 앱 자동 복귀와 수동 롤백을 배포 스크립트에서 차단한다.
백업/SQL 실패로 해당 전환이 커밋되지 않았으면 중지한 기존 앱을 다시 시작한다. 전환이 커밋된 뒤 실패하면
API가 중지된 상태로 남을 수 있으므로 호환되는 앱을 재배포하거나 위 복구 절차를 수행한다.

```sh
# 별도 복구 DB를 먼저 생성한 뒤 실행. BACKUP은 서버 적용 기록의 경로로 지정한다.
sudo docker exec -i dva-prod-db-1 pg_restore --exit-on-error --no-owner -U dva -d monolith_restore_check < "$BACKUP"
```

## 업무 기능 구현과의 경계

주문의 허용 상태 전이·접수 시 필수 내용 검증, 디버 접수 재시도, 배송 상태와 이력의 원자적 저장,
인증·권한, 직원 JSON 복수 등록, 녹취 보관·삭제 작업은 관련 API에서 구현한다. 57번은 접수 결과·초기 배송·이력·감사를 함께 저장하며 결과 불명인 요청을 자동 재전송하지 않는다.
DB의 CHECK와 FK만으로 전체 업무 흐름이 완성되는 것은 아니다.

새 AI 상담 결과는 ORD-01 한 번으로 저장하며 COMPLETE일 때 개인 카드는 결제를 기다리고 월·그룹결제는 결제 완료 후 디버 접수까지 처리한다. 기존 주문 보완은 ORD-04·ORD-06을 유지한다. OpenAI 세션 ID·이벤트 시각과 PBX 발신번호·시각 매칭은 [AI·PBX 계약](../api/ai-pbx-recordings.md)을 따른다. 녹취와 DB의 객체 참조는 업로드 성공 후 연결한다.

관리자 세션 검증은 이름 필수·공백 거절, 토큰 해시·만료 시각·FK 제약, 관리자별 세션 삭제와 계정 삭제 cascade를 포함한다.
015 전환은 과거 로그의 확인 가능한 이름 보완, 업무 참조·페르소나 이력 보존, 계정 삭제 시 세션만 제거되는지, 전환 실패의 전체 롤백까지 검증한다.
003은 기존 관리자 행이 없는 DB를 전제로 한다. 운영 데이터가 있으면 사전 검토 후 이름 보완 migration으로 조정해야 한다.

## 관리자 삭제·감사 이름 보존

관리자 이름 보존의 015를 포함하며 현재 새 앱 실행 전 023까지 적용한다. 기존 migration 파일은 수정하지 않는다.
audit_logs.actor_name은 작업 당시 관리자 이름 또는 AI, target_admin_name은 ADMIN_USER 대상 이름이다.
기존 로그는 전환 시점의 admin_users.name으로만 보완하며 이미 알 수 없는 이름은 NULL로 남긴다.
다른 업무 테이블에 관리자 이름 컬럼을 중복 추가하지 않는다.

handoff_requests.assigned_admin_user_seq, shipment_status_history.actor_admin_user_seq,
ai_persona_versions.created_by_admin_user_seq·requested_by_admin_user_seq, faq_entries.updated_by_admin_user_seq는
FK를 제거하고 번호를 보존한다. 계정 삭제로 해당 이력·업무 행을 지우지 않는다.
admin_sessions의 ON DELETE CASCADE는 유지한다.
관리자 삭제 API는 SYSTEM_ADMIN만 사용하고 SYSTEM_ADMIN 대상은 거절한다. 상세는 [감사 계약](../api/audit-logs.md)을 참고한다.

## 주문 취소 — 64

`014-order-cancellation.sql`은 새 테이블 없이 `order_parcels.status`를 추가한다. ACTIVE는 취소되지 않은 상세, CANCELLED는 취소된 상세다. 결제·배송 상태를 뜻하지 않는다. 기존 취소 주문의 상세만 CANCELLED로 보완하며 주문 버전·시각·주소·물품은 보존한다.

014는 과거 접수 취소 이력의 `parcel_no`와 `dver_received_at`을 보존한다. 현재 018 이후 정책은 COLLECTING·notPaid에서만 취소하고 결제 완료 이후 취소는 거절한다. 접수된 상세는 상태만 취소로 바꿀 수 있고 주소·물품 수정과 취소 복원은 막는다. 주문 전체가 CANCELLED로 바뀌면 DB 트리거가 남은 상세도 취소한다. 일부 상세 취소 시에는 기존 주문 상태를 유지한다.

현재 API는 주문 잠금으로 미결제·승인 선점 여부를 확인하고 취소·합계 재계산·결제 요청 교체·감사를 함께 저장한다. 접수 성공 시 초기 배송 상태는 paid이며 주문 진행은 orders.status 하나로 관리한다. 운영 적용 전 기존 runner의 백업·검증 절차를 따른다.

## 페르소나 전체 버전 — 94·98

012-order-creation-source.sql은 주문 생성 주체를 보존한다.
013-ai-persona-versions.sql은 기존 ai_prompt_versions를 ai_persona_versions로 이름 변경하고 이름·음성·속도·대기·프롬프트를 버전별로 보관한다. 새 테이블은 추가하지 않는다. ACTIVE와 PENDING은 서비스 전체에서 각각 최대 1개다.

과거 프롬프트 기록에는 당시 음성 설정이 없으므로 기존 ai_personas 또는 ai_prompt_versions에 데이터가 있으면 013은 변경 전에 중단한다. 배포 전 두 테이블이 비어 있는지 확인해야 하며, 데이터가 있으면 원본을 보존한 별도 전환 정책이 필요하다. 과거 설정을 현재 값으로 추정하거나 삭제하지 않는다. 운영 DB 적용은 별도다.

## 028 고객 내 주소와 선택 부서

028-customer-address-optional-department.sql은 customers.address_data jsonb와 주소 형식 CHECK를 추가한다.
미등록은 SQL NULL이며 기존 PIN·주문에서 채우지 않는다. memberships.department_seq의 NOT NULL만 제거하고 같은 기업 부서 복합 FK는 유지한다.
기존 고객·소속·부서 배정·PIN·주문·감사 데이터는 수정/삭제하지 않는다. 001~027 원본과 체크섬은 유지한다.
DB 백업 → 028 migration·verify → 새 앱 순서다. 실제 DB 적용은 이번 작업에서 제외한다.
부서 없는 구성원을 생성한 후에는 부서 필수 가정의 구버전 앱으로 복귀하지 않는다. 복귀 전 실제 배정과 호환성 확인이 필요하다.

## 029 FAQ 질문 중복 방지

029-faq-question-uniqueness.sql은 FAQ 질문의 NFC·대소문자·앞뒤/연속 공백을 정규화한 SHA-256 키에 고유 인덱스를 추가한다. 원문은 보존하며 1,000자 질문의 인덱스 길이 제한을 피한다. 생성·수정·복수 등록·미답변 전환·동시 쓰기에 동일하게 적용한다.
기존 중복이 있으면 FAQ 번호 그룹만 보고하고 적용을 중단한다. 자동 삭제·통합·분류/답변 선택은 하지 않는다. 적용 전후 질문·답변·분류·관리자·시각·감사·알림 행은 변경하지 않는다. 실제 DB 적용은 이번 작업에서 제외한다.

## 030 관리자 주문 편집

030-admin-order-edit.sql은 기존 상세 편집 guard에 관리자 트랜잭션의 주문별 편집 허용을 추가한다. 애플리케이션이 관리자 세션·소유 범위·expectedVersion·승인 진행 여부를 검증하고 해당 트랜잭션에만 dva.admin_order_edit=orderSeq를 설정한다. AI와 일반 SQL의 확정 주문·취소 상세 보호는 유지한다. 제거는 CANCELLED 표시이며 실제 행·결제/통화/배송 참조를 삭제하지 않는다. 취소된 주문의 새 상세도 CANCELLED다. 기존 테이블·행·다른 트리거·원결제 기록을 변경하지 않는다. 백업 → 030 migration·verify → 새 앱 순서이며 실제 DB 적용은 별도다.
