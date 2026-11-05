# Consultation PBX·녹취·진행 통화 단계

Jira [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160), 기준 !287 병합 `9e276db`, 브랜치 `feature/msa-consultation-pbx`. backend 트리 `12ad37a492879c47b6c1f78c3c3f3bdfdf98edda`는 이전 기준과 같다. 추적 변경은 msa/infra/docs만 허용하며 backend/프론트/AI는 수정하지 않는다.

## 범위와 구현 순서

1. consultation 후속 003에서 PBX 수신함·통화 도착/등록/삭제/보관 필드·녹취 claim을 추가한다. 기존 통화·발화·녹취·전달 이벤트와 기존 changeset을 보존한다. 원본처럼 근거 없는 과거 등록 시각은 NULL로 남기고 실제 PBX 시작 시각만 누락된 도착 시각으로 사용한다.
2. 기존 `POST /webhooks/pbx/call-ended`를 원본 Bearer·입력 검증·원문 응답·영속 저장 후 ACK·중복/충돌·5년 경계로 제공한다. 원본 PBX 종료 매칭과 녹취 워커를 이식한다. 유일한 통화만 연결하고, claim·재시도·무의미 수신 30분 정리·S3 중복 방지와 다운로드 보호를 유지한다. 새 저장소/브로커/Redis는 추가하지 않는다.
3. `GET /api/calls/active-count`, `GET /api/calls/active-count/stream`의 정확한 집계·PG NOTIFY/보완 조회·공유 구독·heartbeat·세션 회수 시 종료를 이식한다. 관리자/세션은 operations에만 보관하고 서비스 전용 토큰으로 기존 내부 세션 경로에 위임한다. 이 토큰으로 customer 감사 이벤트에 접근할 수 없게 한다.
4. 앱 스키마/readiness, k8s DB·PBX/S3·내부 인증 설정, operations 우선 배포, 서비스 토큰 최초 생성/기존 값 보존, Docker/CI·회귀·문서를 함께 연결한다.

통화 생성은 아직 제공하지 않는 고객 컨텍스트/주문 API와 연결되는 후속 작업이다. 이번 단계는 기존 유효 통화 데이터에 대한 종료·녹취와 독립 PBX 수신을 제공한다. 통화를 임의 생성하거나 다른 서비스 테이블을 consultation DB에 복제하지 않는다. 고객 컨텍스트/PIN·통화 목록/상세/삭제·분석/발화·AI 이벤트·대시보드·FAQ·주문·전체 보관 워커는 후속 범위이며 임시 성공 API를 등록하지 않는다.

## 검증 계획

- 실제 Liquibase/PostgreSQL 신규 설치·재적용·이전 002 데이터/이력 보존·003 후반 실패 rollback을 검사한다.
- 원본 PBX 수신·녹취 저장·진행 통화 집계 단위 테스트 중 이번 범위에 해당하는 원본 파일은 변경 없이 양쪽에서 실행한다. MSA에는 다른 업무 테이블을 테스트 목적으로 만들지 않는다.
- 변경하지 않은 모놀리식과 독립 consultation/operations에 같은 유효/오류/중복/만료 요청을 보내 HTTP·OpenAPI·PBX 수신함·통화·녹취를 비교한다. SSE 초기/변경/연결 복구·세션 회수, 녹취 실패/재시도/경합/재시작은 별도 실제 PG/HTTP 시나리오로 검증한다. S3·PBX 외부 호출은 기존 테스트의 모의 서버로 격리한다.
- customer 17개와 operations 11개, 공통 이벤트·DB·배포 회귀 및 임시 k3s 배포/실패 복구를 확인한다. 운영 Jenkins/공개 HTTPS·실제 PBX/S3 자격정보를 사용한 검증과 전체 95개 API 동등성으로 확대하지 않는다.

## 영향과 위험

PBX 수신함은 서명된 녹취 URL을 포함하므로 기존 로그 보호·호스트 허용 목록·사설 주소 차단·리다이렉트/크기/시간 제한을 유지한다. 운영 PBX 토큰과 S3 자격정보는 기존 Secret으로 주입하며 Git/명령 인자/로그에 넣지 않는다. 스키마를 먼저 적용하고 operations 후 consultation을 배포한다. 등록 시각이 없는 legacy 통화는 임의 활성 통화로 집계하지 않는다.

## 검증 기록 (2026-11-05)

- `python msa/parity/verify-consultation.py`: 변경하지 않은 원본 PBX 테스트 7개와 동일 신규 워커/SQL 시나리오 6개가 원본/consultation의 실제 DB·앱에서 각각 13개씩 통과했다. 미연결/복수 후보·저장소 미설정·업로드 응답 유실·경합·stale claim·실제 claimant SIGKILL 뒤 영속 lease 및 만료 후 복구를 확인했다. 만료 복구는 테스트에서 claim 시각을 조정하며 5분 실시간 대기를 뜻하지 않는다.
- production 이미지에 동일 HTTP 19건과 3개 OpenAPI operation/참조 DTO를 비교했다. 인증·Secure 쿠키·PBX 원문·중복/충돌·만료·검증 오류·공개 프록시 경로 및 매 응답 후 현재 업무 통화/녹취/수신함 전체 행이 일치했다. 수신/관측 시각은 범위를 검증한 후 정규화하고 고정 입력 시각/업무 값은 그대로 비교했다. 원본 047에서 폐기된 end_reason는 현행 비교 필드가 아니며 MSA 과거 값은 별도 이관 보존 검사에 포함한다.
- 실제 SSE 초기/변경 프레임·PG LISTEN 연결 강제 종료 후 보완 조회·heartbeat·세션 회수 이벤트와 HTTP 스트림 종료를 양쪽에서 확인했다. 조회 실패를 0이나 빈 성공 응답으로 바꾸지 않았다.
- consultation 이미지의 ESLint·TypeScript·단위 1개·E2E 5개, 인증/설정 연결 6개와 변경하지 않은 원본 진행 통화/녹취 저장 단위 12개(합계 18개) 통과. 다운로드/S3 검증은 기존 모의 HTTP/SDK 시나리오이며 실제 AWS 자격정보를 사용한 업로드가 아니다. 운영 의존성 audit 0건, 개발 도구의 기존 low 5/moderate 23은 남긴다.
- PostgreSQL 17.11/Liquibase 5.0.4 전체 245단계 통과. 기존 통화·녹취·발화·종료 사유·대기 메시지·이력 보존과 003 후반 실패 시 데이터/스키마/이력 rollback을 확인했다.
- 기존 customer production 조회/인증 77건 및 test 모드 요청 54건과 감사/복구 비교가 통과했다. operations 원본 인증 40개가 양쪽에서 각각 통과했고 설정 2개, production 11개 API HTTP/DB 비교·배포 probe, 새 E2E 7개도 통과했다. consultation 토큰으로 customer 감사나 공개 관리자 API에 접근할 수 없는 것을 확인했다.
- 공통 이벤트 단위 5개·PG/HTTP 15개·95개 API/migration/worker 기준 목록 1개와 Linux 배포/선택/실패 복구 57개 통과. 변경 Python 5개·Bash 13개·Jenkins shell 3개·XML 구문 및 원본 테스트 3개 파일의 SHA-256 불변도 확인했다.
- 운영 kubeconfig 없이 임시 k3s v1.35.5+k3s1의 실제 앱·DB·Secret·Liquibase로 최초 배포·정상 교체·readiness 실패 후 기존 리소스/이미지 복구를 확인했다. consultation HTTP 467건, operations 522건, 기존 customer 배포 회귀 442건에서 실패 모두 0건이다. 검증이 생성한 자원만 소유 라벨을 확인해 정리한다.
- 통화 생성/고객 컨텍스트·PIN·나머지 상담 기능/주문/운영 기능 및 전체 보관 워커·전체 95개 API 동등성은 후속이다. 실제 운영 Jenkins/HTTPS·PBX/S3 자격정보를 사용하는 외부 연동은 미검증이며 운영 설정은 기존 값으로 consultation-runtime Secret에 주입해야 한다.
