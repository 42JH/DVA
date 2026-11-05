# MSA 페르소나 설정·AI 적용 동등성 계획

Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)

!306 병합 `7af2376`에서 `feature/msa-personas`를 분리했다. 원본 backend tree는 `a86433ae1728c2a4681a3fce35cfc33fd3eee335`다. 상담 분석이 실제 페르소나 버전을 참조하므로 operations의 설정·불변 버전·AI 적용 기반을 먼저 연결한다. 추적 변경은 `msa/`, `infra/`, `docs/`만 허용하며 backend·프론트·AI는 읽기 전용이다.

## 구현 범위

- 기존 `/api/personas` 목록/생성, `/:id` 상세/초안 저장, `/:id/versions` 이력/확정, `/:id/activate` publish의 7개 선언과 `/api/ai/options`, `/api/ai/config`, `/api/ai/config/apply-result`를 제공한다. 별도 클라이언트 API를 요구하지 않는다.
- 원본 Controller·DTO·Guard·Service·Repository·AI client·알림 워커를 재사용한다. 현재 관리자 역할·Origin·잘못된 세션의 AI 강등 금지, 초안 revision/HEAD 충돌, 불변 이력·작성자 이름·이전 ACTIVE 참조, publish UUID와 대기/실패/성공·재전송·감사 트랜잭션을 유지한다.
- AI 연동은 기존 `AI_AGENT_URL`·`AI_PERSONA_TOKEN`과 `/internal/persona/options`, `/internal/persona/refresh` 계약이다. Redis·브로커·신규 앱/패키지를 추가하지 않는다. 토큰 미설정은 원본처럼 의존 오류로 응답하며 임의 옵션·ACTIVE를 만들지 않는다.
- operations 추가 changeset에서 최신 버전/초안 스키마를 제공한다. 적용된 001~006은 수정하지 않는다. 구 MSA 프롬프트에는 버전 당시의 전체 음성·이름 스냅샷이 없으므로 최신 값으로 과거를 꾸미지 않는다. 구 identity/prompt 테이블은 별도 legacy 이름으로 모든 행·ID·시각·제약·설정을 보존하고 기존 SQL 활성화 함수를 해당 테이블에 유지한다. 새 계약의 이력은 비어 있는 상태에서 시작하며 구 프롬프트를 자동 publish하지 않는다. 기존 데이터의 실제 상담 설정 이관은 검증된 전체 스냅샷을 준비한 별도 작업이다.
- AppModule·스키마 기동 검사·환경·Secret 참조·Ingress·Jenkins 비교 검증·문서를 함께 연결한다. 기존 operations 인증/감사와 customer/consultation 내부 토큰·경로는 보존한다.

## 검증 순서

1. 변경하지 않은 backend 페르소나 단위/HTTP 통합 테스트를 원본과 operations에 실행한다. 스키마 준비 helper만 독립 Liquibase DB를 사용한다.
2. 동일 요청·초기 업무 데이터로 HTTP 상태/본문/쿠키/헤더/OpenAPI와 전체 설정·초안·감사 DB 값을 대조한다. 무작위 UUID/서버 시각은 형식·관계·유효 범위를 먼저 검증한다. 정상/권한/검증/충돌/동시 수정·감사 실패 롤백과 AI 오류/응답 복구를 포함한다.
3. 실제 워커의 동일 UUID 재알림·오래된 회신 거절·재시작 복구와 변경 없는 기존 인증/고객/상담 비교를 확인한다. foreground 비교와 자동 워커 검증의 환경을 구분한다.
4. Linux lint·TypeScript·단위/E2E, 전체 Liquibase 신규/업그레이드/기존 이력 보존/추가 DDL 실패 롤백, 배포 스크립트 회귀·임시 k3s 교체/실패 복구를 수행한다.
5. 근거를 기록한 뒤 작업 단위 커밋·push·develop-backend 대상 MR을 만들고 Task 160에 연결한다. 직접 병합하지 않고 사용자 병합 확인 후 다음 범위로 진행한다.

## 후속 범위와 완료 기준

이번 범위는 operations 페르소나 10개 선언과 해당 AI 알림이다. FAQ·상담 분석/이벤트/조회 나머지·주문/결제/배송·기업 청구·전체 5년/7일 보관 워커·공개 HTTPS/운영 Jenkins·전체 95개 API 동등성은 후속이다. 기존 AI의 통화별 설정 고정·신규 통화 진입 잠금은 원본과 같은 외부 계약이며 실제 AI 코드·다중 AI 인스턴스 동기화는 수정/검증하지 않는다.
