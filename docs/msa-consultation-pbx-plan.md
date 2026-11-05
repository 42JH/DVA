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
