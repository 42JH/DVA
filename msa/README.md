전체 동등성 최종 검증은 사용자 요청에 따라 최초 기준 `6a141a0`(052, HTTP 선언 95개)으로 고정한다. [검증 계획](../docs/msa-final-parity-plan.md)과 [실행 결과](../docs/msa-final-parity-results.md)를 따른다. 이후 API 변경 이식은 보류하며 현재 구현을 보존한 상태에서 최초 계약과의 차이를 기록한다. 기존 Jenkins의 055 inventory 검사는 !369의 고정 원본 CI 작업공간에서 유지한다. 아래 내용은 단계별 구현 당시 기록이다.

055 배송 초안 변경이 포함된 `develop-backend` `9624b7789ee7876648b6c56b5e7a4a7a5a9ef378`을 기준으로 [초안 저장 구조·기존 API 호환](../docs/msa-draft-compatibility-plan.md)을 동기화한다. 원본 기준 목록은 공개 선언 104개·SQL 54개 파일(마지막 번호 055)·워커 6개다. order 004/consultation 008 이관, 기존 주문 목록·취소·통화 삭제, 초안의 최초 5년 보관과 배포 전환 검사를 연결한다. 신규 초안 CRUD/재개·관리자 보완·통화 주문 완료/확정 API와 결제/배송·남은 상담·전체 동등성은 후속이다.

MR !360 병합 `cf85fe37ff9b4426f25859fa8e2a5f6a71031021`에서 [기업 청구 조회·월 전환](../docs/msa-billing-months-plan.md)을 연결한다. customer의 기존 `GET /api/companies/:id/billing`은 order의 청구 원장을 읽으며 공개 customer 선언은 24/24개다. order의 10초 워커는 한국 시간 누락 월을 10건씩 초기화하고 기업명 스냅샷·감사 확정/복구를 유지한다. 결제 완료 시 사용액 적립과 주문 생성/수정·접수/배송·남은 상담/보관·최종 전체 동등성은 후속이다.

MR !359 병합 `5c10eed630b3c8663a79c6b352ac91986dfd30fd`를 기준으로 [주문 전체·상세 취소 2개 API](../docs/msa-order-cancellation-plan.md)를 연결한다. 원본 054/backend tree `f5b00cd9f9d2f7e09805ed042cbc56a7e305c799`가 기준이다. order의 공개 선언은 조회 4개·삭제 1개·취소 2개이며 AI 통화/현재 고객 범위·배송 존재 확인·결제 요청 교체·감사 확정/복구를 포함한다. 생성·수정·접수/결제·청구 워커와 배송 생성/후속 이벤트, 남은 상담·교차 소유자 보관·최종 전체 동등성은 후속이다.

MR !355 병합 `256d8157c68cc8a252253484ab3ab8086cd4d95e`를 기준으로 [주문 삭제 API](../docs/msa-order-deletion-plan.md)를 이식한다. backend tree `f5b00cd9f9d2f7e09805ed042cbc56a7e305c799`·원본 054까지가 기준이다. order는 기존 조회 4개와 관리자 DELETE를 제공하며 통화 차단 조회·결제 안내 상태·감사 확정/복구를 연결한다. 주문 생성·수정·취소·결제·청구·접수/배송 이벤트·남은 상담과 보관 워커·최종 전체 동등성은 후속이다.

MR !352 병합 `c400c72`를 기준으로 [주문 조회 4개 API](../docs/msa-order-reads-plan.md)를 이식한다. 원본 054/backend tree `f5b00cd9f9d2f7e09805ed042cbc56a7e305c799`가 기준이다. 주문 목록·상세·관리자 목록·이전 주문 주소와 기존 관리자 세션/AI 통화·고객 범위를 연결한다. 주문 쓰기·결제·청구·접수/배송 이벤트·통화 이벤트/미답변 목록/FAQ 전환·보관 워커와 전체 동등성은 후속이다.

# MSA CI/CD

MR !337 병합 기준 `1597c62`에서 착수하고 최신 `ad40526`(고객 등록 주소 필수·주문 가격 정책)을 반영해 [미답변 수집·삭제와 통화 콘텐츠 조회·삭제 6개 API](../docs/msa-call-content-plan.md)를 이식한다. 원본 054와 동일 입력/응답·삭제 조건·감사를 유지하며 통화 이벤트 수집/FAQ 사례 생성·미답변 목록/전환·주문과 전체 동등성은 후속이다.

MR !326 병합 기준 `3d8bf7b9`로 착수한 뒤 최신 `bae5074`(원본 054·보안 기록/녹취 재시도)를 동기화하며 [FAQ 6개 API·AI 알림 워커 및 상세 원본 통화 조회](../docs/msa-faqs-plan.md)을 이식한다. 질문 사례 생성·통화 이벤트 수집과 전체 동등성은 후속이다.

모놀리식 업무 동등성 구현은 [전체 계획](../docs/msa-parity-plan.md)과 [이벤트 전달 기반](shared/events/README.md)을 따른다. [operations의 인증·관리자·감사 11개 API](services/operations/README.md)와 [customer 조회 7개·쓰기 10개 API 및 세션/감사 연결](services/customer/README.md)을 구현했다. 남은 업무 API·자동 워커·이벤트 연동은 후속 MR이며 전체 기능 동등성을 의미하지 않는다. Jenkins는 `Verify Event Transport`의 임시 PostgreSQL·HTTP 검증과 기준 목록 검사, 선택한 서비스의 `Verify Operations Parity`/`Verify Customer Parity`에서 원본 모놀리식과 HTTP·DB 비교를 실행하고 실패 시 이후 배포를 중단한다. customer 쓰기 비교는 자동 업무 워커를 제외한 기본 test 환경이며 production 조회 검증과 구분한다.

[consultation의 PBX 수신·녹취·진행 통화 수/SSE](services/consultation/README.md) 3개 API와 customer의 [고객 확인·통화 등록](../docs/msa-caller-context-plan.md)을 연결했다. customer 공개 선언은 고객 수정·개인 PIN 4개를 포함해 23/24개다. 고객 확인 API는 call 없는 조회에서 쓰기를 하지 않고, call이 있으면 consultation 통화·PBX·operations 감사 확정 후 응답한다. Verify Consultation Parity는 production PBX/SSE와 별도 test 환경의 고객 확인·실제 분리 DB·등록 SSE·응답 유실/강제 종료 복구를 비교한다. [고객 수정·개인 PIN 비교](../docs/msa-customer-pins-plan.md)도 같은 단계에서 네 공개 API·통화 잠금 경합·재수신/프로세스 종료 복구를 확인한다. 상담 분석의 실제 페르소나 버전 참조를 준비하기 위해 [operations 페르소나 10개 API·초안/HEAD/publish·AI 알림](../docs/msa-personas-plan.md)을 먼저 연결해 operations는 21개 선언을 제공한다. 기업 청구 조회·자동 월별 청구·나머지 상담/주문·FAQ·전체 보관 워커/96개 API 동등성은 후속이다.

[Jenkins #29 복구 및 최신 계약 동기화](../docs/msa-build-29-fix.md)는 새 관리자 사원 검색, 인증 제한·AI 업무 Bearer와 기업 PIN 퇴역을 포함한다. 프론트·AI 요청은 최신 backend와 같은 형식을 사용한다.

[통화 최종 분석·이탈 단계·응답 대기시간 3개 API](../docs/msa-call-analysis-plan.md)를 consultation에 연결했다. 실제 페르소나 버전은 operations 조회 이벤트와 감사 확정에 연결한 FK 참조로 보호한다. 공개 Ingress는 기존 `/api/ai/calls`를 그대로 사용하고 새 토큰을 만들지 않으며 기존 AI_INSIGHTS_TOKEN을 consultation-runtime에 주입한다. 전체 상담 조회/발화·주문·FAQ·보관 워커는 후속 MR이다.

Jenkins의 Linux 빌드 노드에서 검증하고, MSA 서버 `k15d109.p.ssafy.io`의 k3s에 배포한다. 모놀리식 `backend/`와 루트 `Jenkinsfile`은 별개다.

현재 5개 서비스 DB의 Liquibase CI/CD와 customer·order·delivery·consultation·operations NestJS 서비스의 테스트·이미지 빌드·k3s 배포를 지원한다. **develop-backend Push Webhook은 변경된 앱의 CI부터 CD까지 자동 실행한다.** 앱 배포용 체크박스를 매번 켤 필요가 없다. DB changeset도 같은 실행에서 자동 적용한 뒤 앱을 배포한다. 별도 배포 체크박스나 승인 입력은 없다.

## 실행 흐름

[CI 비용·#40 전환 실패 보완](../docs/msa-ci-runtime-plan.md)은 앱 배포와 회귀 선택을 분리하고,
전체 선택 시 13개 checks/production/Liquibase 이미지를 공유한다. 기존 회귀의 원본은
`baseline.json`의 055 커밋 `9624b778`로 고정하며 `msa/.ci-source/`에서 현재 MSA와 검증한다.
원래 `backend/`는 변경하지 않는다. 이후 056/API는 이 검사에 섞지 않는다.
임시 원본의 업무 테스트 helper 3개에는 !371의 반복 로그인 제거만 적용한다.
API·migration·테스트 기대값은 그대로이며 승인된 fixture patch 이외의 backend 차이는 거부한다.
실제 checkout의 backend와 최초 052 수동 진단 기준은 보존한다.
최초 052 전체 동등성 진단은 별도 MR !364의 수동 검증이며, 현재 업무 동등성 완료를 의미하지 않는다.
다섯 서비스의 npm 다운로드는 기존 BuildKit의 잠금 캐시로 공유한다. 다운로드 캐시는 운영 이미지에
포함하지 않으며, 이벤트 검증 파일 변경은 의존성 설치 레이어를 무효화하지 않는다.

```text
Webhook → develop-backend checkout → 스크립트 검사 → 고정 원본 격리 → 실제 배포 이력 조회
  → 검증/배포 범위 선택 → 필요한 이미지 각 1회 빌드 → DB/동등성 회귀 → 패키징
  → 앱 SSH 전송·이미지/manifest 사전 검증 → 모든 DB의 SQL/대기 fingerprint 확인
  → 055 pending: 통화/PBX/이벤트 확인 → 두 앱 중지 → 두 DB 백업/검증
  → 변경된 모든 DB 적용·확인 → 이전 리소스 보관 → RollingUpdate
  → 내부 health/OpenAPI + 외부 HTTPS health/Swagger/OpenAPI 확인
  → 성공: 배포 커밋 기록 / 실패: 이전 리소스 복원 후 빌드 실패
```

앱은 서비스별 **실제 배포 성공 커밋**과 비교한다. CI만 성공했거나 배포가 실패한 변경을 누락하지 않는다. 기존 정상 customer는 이미지 태그의 커밋으로 최초 이력을 이어받는다. 클러스터 이력 조회 실패는 배포를 중단한다.

- 서비스 폴더 변경: 해당 서비스만 빌드한다. 앱 공통 배포 코드 변경: 모든 서비스를 빌드한다.
- 5개 서비스 이미지는 `@dva/events` 파일 의존성을 포함하도록 `docker build -f msa/services/<서비스>/Dockerfile msa`로 빌드한다. delivery도 같은 context를 사용한다. Jenkins·비교 검증기·k3s fixture도 같은 경로를 사용한다.
- customer/consultation은 operations에 현재 세션을 확인하며 consultation은 customer 조회 이벤트에도 의존한다. order는 AI 범위 확인을 위해 customer·consultation, 취소 시 배송 확인을 위해 delivery에 의존한다. delivery readiness는 자기 DB만 검사한다. 모두 선택되면 operations → customer → consultation → delivery → order 순서로 배포한다. 기존 서비스 Secret 값은 보존하며 customer의 조회에는 consultation의 readiness를 요구하지 않아 의존 순환을 만들지 않는다. 통화 등록 요청의 의존 장애는 503으로 반환한다.
- DB·서비스 회귀·이벤트·배포 회귀의 성공 commit/build는 각 단계가 통과한 즉시 기록한다. 뒤의 CD 실패도 이 기록을 없애지 않는다. 다음 실행은 각 검사의 마지막 성공 입력과 비교하며, 없는 기록·잘못된 기록·이력 분기는 다시 검사한다.
- DB CI는 migration·실행기·검증기·고정 기준 정책 변경으로 선택한다. 배포 pending·SSH 코드·DB 문서 변경만으로 전체 DB 검증을 반복하지 않는다. 동일 입력을 재사용한 DB 패키지에는 이전 검증 commit/build와 이번 이미지 ID를 함께 기록하며, 실제 서버의 fingerprint·migration·백업·복구 검사는 유지한다.
- 준비된 이미지는 선택된 검사와 배포에 필요한 것만 빌드한다. 검증이 끝난 배포 재시도는 checks/monolith 이미지를 만들지 않는다. 배포 없는 CI는 앱·DB 전송 패키지를 만들지 않는다. inventory와 최종 검증기 회귀 6개는 별도 Node 단계에서 빠르게 확인한다.
- Webhook을 통한 앱 자동 배포는 `develop-backend`에서만 허용한다. MR/작업 브랜치에서는 배포하지 않는다.
- `develop-backend` 실행은 CI와 CD를 함께 수행한다. 수동 재실행도 동일한 흐름이다. 작업 브랜치는 CI만 수행한다.
- DB는 namespace의 `dva.ssafy.io/db-<서비스>-commit`부터 서비스별 changelog 변경을 비교한다. DB만 변경되어도 자동 적용한다. 성공한 DB만 적용 커밋을 갱신하므로 이후 실패한 DB는 재실행 시 누락되지 않는다.
- DB 적용 이력이 없는 첫 실행은 5개 DB 모두 Liquibase로 확인·적용하여 기준을 기록한다. 이미 적용된 changeset은 다시 실행하지 않는다. 이후 변경된 DB만 적용한다.
- 서비스 디렉터리 삭제나 manifest에서 리소스를 제거하는 변경은 기존 서버 리소스를 자동 삭제하지 않는다.

## CI 검사

Webhook 경로 필터를 통과한 실행에서 클러스터 배포 이력을 조회하고 검사 대상을 결정한다. 서비스 빌드·배포와 DB 검사는 실제 변경 및 배포 이력에 따라 생략한다. 선택 결과는 `Select Build Scope` 로그에서 확인한다.

자동 실행은 Generic Webhook Trigger를 사용한다. 기존 GitLab 직접 트리거와 Poll SCM은 끈다. GitLab MSA Webhook 주소는 `https://13.209.59.180/jenkins/generic-webhook-trigger/invoke`이며, `develop-backend` Push events와 기존 Secret token·SSL 검증을 유지한다. Secret은 Jenkins의 Generic Webhook Trigger Token과 일치시킨다.

Jenkins는 `object_kind=push`, `project.id=1462697`, `ref=refs/heads/develop-backend`, 삭제가 아닌 after SHA를 확인하고 `$.commits[*]['added','modified','removed'][*]`에 `msa/` 경로가 있을 때만 작업을 생성한다. `backend/`만 바뀐 일반 push는 빌드 기록이나 노드를 할당하지 않는다. GitLab이 commit 목록을 최대 20개로 제한하므로 20커밋 초과 push는 누락 방지를 위해 작업을 실행하고 내부에서 비교한다. 테스트용 Custom webhook template과 `gwt-dry-run` 헤더는 실제 운영 설정에서 비워둔다.

Webhook 설정은 Jenkins·GitLab에서 관리한다. 앱과 DB 자동 배포는 동일 실행에서 처리하며, 동시에 여러 push가 오면 checkout 시점의 최신 코드 기준으로 비교한다.

| 검사 | 내용 |
|---|---|
| 실행 환경 | Linux amd64, Docker 엔진, Python 3, Bash, SSH/SCP 및 체크섬 도구 |
| 배포 스크립트 | Bash 구문과 Python unittest; 손상된 패키지, 잘못된 적용 해시, 실패한 Job 등 실패 경로 포함 |
| 이미지 빌드 | 버전·체크섬을 고정한 Liquibase/JDBC 이미지 빌드, 실제 이미지 ID 기록 |
| 신규 설치 | 임시 PostgreSQL 17.11에 5개 스키마 설치, 테이블·제약·인덱스·함수·트리거 등 검증 |
| 업무 규칙 | 서비스별 SQL 테스트, 참조 무결성 및 상태·사번 등 제약 검사 |
| 반복 실행 | 재적용 시 중복 변경 없이 Liquibase 이력 유지 |
| 업그레이드 | customer/operations의 001 → 002, 기존 데이터 보존과 부적합 데이터 차단 |
| 실패 처리 | 초기 설치/후속 changeset 실패 시 해당 트랜잭션 롤백 |
| 대상 일치 | 미리보기·적용 명령 실행, 잘못되거나 오래된 대기 changeset 해시 차단 |
| 배포 산출물 | 성공 보고서의 이미지 ID와 현재 이미지 ID가 일치해야 패키징 |

테스트 DB는 전용 임시 Docker 네트워크에 만들며 호스트 DB 포트를 공개하지 않는다. 종료 시 해당 컨테이너와 네트워크를 제거한다. 실제 서버 DB는 CI에서 사용하지 않는다.

## CD 검사와 적용

1. 커밋 SHA와 Jenkins 빌드 번호로 릴리스를 식별한다. CI에서 검사한 이미지를 다시 빌드하지 않고 tar로 저장한다.
2. 고정된 SSH 호스트 키로 서버를 확인한다. 이미지·실행 스크립트·보고서의 SHA-256을 전송 전후 검사한다. 기존 릴리스 디렉터리를 덮어쓰지 않는다.
3. k3s가 단일 Linux amd64 Ready 노드인지, 스케줄 가능한지, `dva` 네임스페이스가 있는지 검사한다. 이미지를 containerd에 가져온 뒤 CI 이미지 ID와 대조한다.
4. 선택 서비스의 DB Secret 존재를 검사하고 일회성 Job에서 `validate`, 상세 `status`, `update-sql`을 실행한다. SQL과 대기 changeset 목록은 `preview.log`로 보관한다.
5. SQL과 대기 changeset 목록을 로그에 남기고 자동 적용한다. 적용 직전 목록 해시를 비교하여 대상이 달라지면 중단한다. 사람의 추가 승인은 기다리지 않는다.
6. `update` 후 `validate`와 `status`를 검사하고 미적용 changeset이 없어야 성공 처리한다. DB 적용 커밋을 기록한다.
7. 선택한 모든 DB가 성공해야 앱 배포로 진행한다. DB 실패 시 앱을 배포하지 않는다. DB와 앱 단계 전체가 하나의 Jenkins 배포 잠금을 공유한다.

055 최초 전환은 두 앱이 모두 멈춘 뒤 order/consultation DB를 서버의
`/home/ubuntu/msa-deploy/backups/<release>/`에 백업한다. 디렉터리는 0700, dump/상태는 0600이며
CI로 전송하지 않는다. checksum과 pg_restore 목록을 검사하고, DDL 전 준비 실패는 이전 복제 수로 복구한다.
DDL 보호 표식 이후에는 구형 앱을 자동 재개하지 않는다. 일반 DB 변경과 별도 복구용 백업 정책은 운영자가 관리한다.
외부 AI outbox/유입 전환과 새 계약 준비는 이 코드가 확인하지 않으며 기존 운영 협업 조건을 유지한다.

미리보기는 배포용 SQL 확인 단계다. 별도 프리뷰 웹사이트를 생성하지 않는다. `update-sql`만으로 실제 DDL 성공을 보장하지 않으므로 CI에서 SQL을 실제 실행하고 CD에서도 적용 결과를 검사한다. Liquibase 조회 과정에서 관리 테이블이 만들어질 수 있다.

대기 목록 해시는 미리보기와 적용 대상 changeset의 일치 검사다. 임의의 데이터 변경이나 수동 DDL까지 감지하는 스키마 비교 기능은 아니다. 배포 중에는 별도 수동 마이그레이션을 수행하지 않는다. Jenkins 전체 DB 배포 잠금과 서버 작업 잠금을 사용하며, Liquibase DB 잠금도 유지한다.

## Jenkins 연결 설정

기존 Jenkins Job과 SSH credential을 사용한다. 아래는 재구성 시 필요한 설정이다.

1. Linux amd64 빌드 노드에 `msa-builder` 라벨을 지정한다. Docker 데몬 사용 권한과 `git`, `python3`, `bash`, `ssh`, `scp`, `sha256sum`, `realpath`가 필요하다. 빌드는 이 서버 노드에서 실행한다.
2. Pipeline/Declarative, Git, Credentials Binding, SSH Credentials, Lockable Resources, Timestamper, Generic Webhook Trigger 플러그인을 준비한다.
3. 신뢰할 수 있는 배포용 Pipeline Job을 만들고 Git SCM 브랜치는 `*/develop-backend`, Script Path는 `msa/Jenkinsfile`로 설정한다. 저장소 접근용 credential은 팀 설정을 사용한다. 설치 후 webhook 또는 수동 실행을 설정한다.
4. 해당 배포 Job/폴더에만 SSH private key credential `dva-msa-ssh`를 등록한다. 접속 사용자는 스크립트에 `ubuntu`로 고정되어 있다. PEM은 Git에 넣지 않는다. MR 등 비신뢰 코드 실행 Job에 배포 credential을 공유하지 않는다. 브랜치 조건만으로 악의적인 Jenkinsfile을 방어할 수는 없다.
5. MSA 서버는 `python3`, `flock`, `sha256sum`, Bash, SCP를 제공하고 ubuntu가 비밀번호 없이 `sudo -n k3s kubectl`, `ctr`, `crictl`을 실행할 수 있어야 한다. `/home/ubuntu/msa-deploy`에 쓸 수 있어야 한다.
6. `dva` 네임스페이스와 DB, DB 사용자를 준비한다. 각 `<service>-db` Secret에는 `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`가 필요하다. 생성/복원은 이 파이프라인 범위가 아니다.
7. 병합 후 Webhook 실행에서 DB 적용 성공 로그와 앱 배포 성공 로그를 확인한다.

`known_hosts`에는 사용자가 서버에서 확인한 ED25519 공개키를 고정했다. 서버 교체로 키가 바뀌면 새 지문을 별도로 확인한 뒤 갱신한다. 호스트 키 검사를 끄지 않는다.

## 파일과 산출물

| 파일 | 역할 |
|---|---|
| `Jenkinsfile` | CI/CD 단계, 브랜치 제한, credential과 로그 보관 |
| `liquibase/verify.py` | 이미지 빌드와 실제 PostgreSQL 통합 검사 |
| `liquibase/ci-command.sh` | 컨테이너 내부 미리보기·대상 비교·적용 후 검증 |
| `liquibase/run-service.sh` | Kubernetes Job 생성, 성공/실패/시간 초과 확인 |
| `deploy/package.sh` | 검증한 이미지 패키징과 체크섬 생성 |
| `deploy/upload.sh`, `ssh-common.sh` | SSH 검증과 산출물 전송 |
| `deploy/run-remote.sh`, `remote.sh` | 원격 이미지 준비, k3s 검사와 Job 실행 |
| `deploy/tests/test_deploy.py` | 외부 통신 없이 배포 제어·실패 경로 검사 |

Jenkins에서 `verification.json`, `verification-logs/`, `msa-release/<커밋>-<빌드>/`, `preview.log`, `apply.log`를 보관한다. 최근 빌드 10개, 산출물은 2개 빌드분을 보관한다. 이미지 tar가 커질 수 있으므로 디스크 용량을 확보한다. 서버 릴리스와 containerd 이미지의 자동 삭제는 하지 않으며 사용 중인 이미지 확인 후 별도로 정리한다.

## 실패·복구 및 검증 범위

- Job은 자동 재시도하지 않으며 실행 제한은 10분, 완료 후 TTL은 1일이다. Jenkins 단계 재시작도 막았다.
- Jenkins 중단/SSH 단절이 이미 시작한 Job의 중단을 보장하지 않는다. 재실행 전 `kubectl -n dva get jobs,pods`, 해당 Job 로그, Liquibase 이력을 확인한다. 잠금을 무조건 해제하지 않는다.
- 실패한 changeset은 트랜잭션으로 되돌리지만 이전에 성공한 changeset까지 자동 복구하지 않는다. 복구는 검토한 후속 changeset 또는 검증된 백업으로 처리한다.
- 현재 단일 노드에서 로컬 이미지 import를 사용한다. 노드가 늘면 이미지 저장소 또는 노드별 배포 방식을 먼저 설계한다.
- 로컬 Docker PostgreSQL 통합 검사와 격리된 배포 스크립트 테스트는 실제 Jenkins 플러그인 조합, SSH 네트워크, 운영 k3s Job의 종단간 검증을 대체하지 않는다. 서버 연결 후 첫 실행에서 이를 확인해야 한다.

## 애플리케이션 배포와 복구

customer 주소:

- https://k15d109.p.ssafy.io/customer/health
- https://k15d109.p.ssafy.io/customer/docs
- https://k15d109.p.ssafy.io/customer/docs-json

Traefik의 `websecure`와 `letsencrypt`를 사용한다. 앱은 `/<서비스>` 접두어와 `/health`, `/docs`, `/docs-json`을 제공한다. 배포 성공 전에 내부 Service와 외부 HTTPS 응답을 검사한다.

`maxUnavailable=0`, `maxSurge=1`로 새 Pod가 준비될 때까지 기존 Pod를 유지한다. readiness, 시작 검사, 종료 유예를 함께 사용한다. 이는 단일 노드 장애나 DB 호환성까지 해결하는 고가용성 보장은 아니다.

적용 전에 해당 서비스의 Deployment·Service·Ingress를 `previous-resources.json`으로 보관한다. rollout 또는 응답 검사 실패 시 이전 리소스를 적용하고 복구 응답을 확인한다. 복구에 성공해도 실패한 릴리스의 Jenkins 빌드는 실패 처리한다. 다른 이미지가 이미 배포되었다면 이를 덮어쓰지 않고 복구를 중단한다. 최초 배포는 이전 버전이 없으므로 진단용 리소스를 남긴다. SSH 단절·강제 종료·노드 장애에서는 자동 복구 완료를 보장하지 않는다.

앱/DB 단계 전체는 한 배포 잠금을 공유한다. 앱 롤백은 DB를 되돌리지 않는다. 055 최초 전환은 위의 정지·백업·구형 앱 차단을 적용하며, 그 외 파괴적 DB 변경의 백업은 별도로 준비한다. 추가 Jenkins 승인은 받지 않는다.

| 파일 | 역할 |
|---|---|
| `deploy/plan-apps.py`, `read-app-state.sh` | 실제 배포 커밋 조회와 서비스·DB 검사 범위 결정 |
| `deploy/package-app.sh`, `upload-app.sh` | 검증된 이미지와 실행 파일 패키징·전송 |
| `deploy/remote-app.sh`, `app-release.py` | 서버 잠금, 이미지 검증, 배포·응답 검사·복구 |
| `deploy/tests/integration_app_rollout.py` | 격리된 로컬 k3s에서 정상 교체와 의도적인 readiness 실패·복구 확인 |

서버 패키지는 `/home/ubuntu/msa-deploy/apps/<릴리스>/<서비스>`에 저장한다. Jenkins 앱 로그는 `msa-release/app-logs`에 보관한다. 성공 마커는 `DVA_APP_ROLLOUT_COMPLETE`, 복구 성공 마커는 `DVA_APP_ROLLBACK_COMPLETE`다.

## 검증과 다음 서비스 작업 단위

일반 Jenkins 검사에는 다음 unittest가 포함된다. 실제 k3s 장애 검증은 매 빌드에 실행하지 않는다.

```bash
python3 -m unittest discover -s msa/deploy/tests -v
# 배포 동작을 바꾸었을 때만, 운영 kubeconfig를 사용하지 않는 로컬 Docker 환경에서 실행
python3 msa/deploy/tests/integration_app_rollout.py --image dva-customer:local
```

다음 서비스는 아래 작업을 **하나의 MR → develop-backend**로 묶고 커밋을 나눈다.

1. NestJS 서버와 서비스 접두어, health·Swagger, 필요한 테스트 구성.
2. Dockerfile 및 k3s Deployment·Service·HTTPS Ingress 구성.
3. 변경 서비스 선택·자동 배포·실패 복구와의 연결 확인, 문서 정리.

이미 지원되는 공통 CI/CD 코드를 서비스마다 복사하지 않는다. DB 변경이 있으면 해당 changeset을 같은 작업에서 준비하되 실제 DB 적용은 동일한 Webhook에서 앱보다 먼저 자동 실행한다. 첫 배포는 외부 Swagger와 배포 완료 로그까지 확인한다.

## 이번 변경의 검증 기록 (2026-10-26)

- Linux Python 3.13 배포 회귀 검사 41개 통과, Bash 구문 및 Jenkinsfile Groovy 구문 통과.
- 격리된 k3s `v1.35.5+k3s1`에서 실제 customer 이미지로 최초 배포 → 정상 교체 → readiness 실패 → 이전 버전 복구 확인. 교체·복구 중 HTTP 요청 456건, 실패 0건.
- 현재 운영 customer의 HTTPS health·Swagger·OpenAPI 모두 HTTP 200 확인.
- 신규 파이프라인의 운영 Jenkins 실행과 운영 장애 주입은 수행하지 않았다. 병합 후 첫 Webhook 실행에서 실제 배포 성공 마커와 외부 주소를 확인한다.

## DB 자동 배포 연결 보완

DB와 앱은 별도 수동 실행으로 나누지 않는다. `Release Delivery` 안에서 `Stage Application Images` → `Database Delivery` → `Application Delivery` 순서로 실행한다. 사전 전송은 앱을 적용하지 않으며, 모든 DB 적용이 성공해야 rollout한다. DB만 변경된 MR도 실제 서버에 적용한다. 변경이 없는 DB만 생략한다. 이전 검증 기록의 41개 검사는 당시 앱 배포 중심 기록이다.

보완 검증: Linux Python 3.13 회귀 검사 46개와 Bash·Jenkinsfile Groovy 구문 검사 통과. DB 전용 변경 선택, 다중 DB 순차 적용, 적용 실패 시 중단, 미적용 DB 재선택을 확인했다. 신규 자동 DB 흐름의 운영 Jenkins 실행은 병합 후 확인한다.

## Order 서비스 추가 (MR 전 준비)

- 서버·Swagger·Docker·k3s 구성: [services/order/README.md](services/order/README.md)
- 예정 HTTPS 경로: `/order/health`, `/order/docs`, `/order/docs-json` (포트 3002).
- 공통 서비스 자동 검색을 사용하므로 Jenkinsfile에 order 전용 분기를 추가하지 않는다.
- 작업 브랜치에서는 운영 배포하지 않는다. 병합 후 첫 Webhook에서 order 선택, 변경 없는 customer·DB 생략, `DVA_APP_ROLLOUT_COMPLETE=order`, 외부 HTTPS 응답을 확인한다.
- 교체·실패 복구 검사는 기존 도구에 `--service order --image dva-order:local`을 전달한다. 기본 customer 검증도 유지한다.

## Delivery 서비스 추가

- 구성과 실행: [services/delivery/README.md](services/delivery/README.md)
- 포트 3003, 경로: /delivery/health, /delivery/docs, /delivery/docs-json.
- 공통 서비스 검색·선택 배포·실패 복구를 재사용한다. Jenkinsfile과 DB changeset은 변경하지 않는다.
- 병합 후 Delivery 자동 배포와 외부 HTTPS를 확인한다. 정상 Customer·Order와 변경 없는 DB는 생략한다.

## 5개 서비스 실행 기반

| 서비스 | 포트 | HTTPS Swagger 경로 |
|---|---|---|
| Customer | 3001 | /customer/docs |
| Order | 3002 | /order/docs |
| Delivery | 3003 | /delivery/docs |
| Consultation | 3004 | /consultation/docs |
| Operations | 3005 | /operations/docs |

공통 호스트는 https://k15d109.p.ssafy.io 이며 각 서비스는 같은 접두어 아래 health와 docs-json을 제공한다. Consultation·Operations의 운영 주소는 병합 후 배포 완료 확인이 필요하다.

남은 두 서비스는 하나의 MR에서 추가하되 Jenkinsfile·DB changeset은 변경하지 않는다. 자동 검색·선택 빌드·패키징·HTTPS 배포·실패 복구를 재사용한다. 정상 Customer·Order·Delivery 및 변경 없는 DB는 생략한다. 다중 앱 배포는 서비스별 성공을 기록하며 전체 원자적 롤백은 하지 않는다. 재실행 시 아직 배포하지 못한 서비스만 선택한다.

각 서비스의 README에 실행법과 검증 결과를 기록한다. 이 구성은 업무 API와 DB 연결 전의 서버 인프라 기반이다.
