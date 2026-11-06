# FAQ MSA 이식 계획

Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)

기준은 MR !326이 병합된 `develop-backend`의 `3d8bf7b9d742e1571b7508139ea61c064bf89a99`다. backend tree `c19c5594540415c579b00eee1917df1cbd954a93`와 원본 migration 053까지를 계약으로 삼는다. 작업 브랜치는 `feature/msa-faqs`이며 수정은 msa/infra/docs에 한정한다.

## 범위와 순서

1. operations에 관리자 FAQ 목록·상세·단건/복수 등록·수정·삭제와 AI FAQ 목록, 총 6개 선언을 이식한다. 동일 DTO·정규화 중복·권한·Cookie/Origin 우선순위·오류·204/Location·페이지네이션을 보존한다.
2. operations 009에서 기존 FAQ의 ID·내용·시각을 보존하며 분류, 활성 질문 유일성, soft delete, 알림 대기와 최근 질문 스냅샷을 연결한다. 원본 027의 확인된 분류표만 사용하고 알 수 없는 분류/중복 행은 전체 롤백한다. 신규 FAQ나 과거 사례를 만들지 않는다. consultation 006은 원본 이벤트/미답변 저장 구조를 추가해 상세의 원본 이벤트·통화 조회를 지원한다.
3. FAQ 상세는 operations의 최근 10개 스냅샷을 조회하고 원본 event UUID들의 현재 통화 연결을 consultation의 인증된 비공개 조회 이벤트로 확인한다. 통화 삭제·보관 만료·원본 이벤트 삭제 뒤에는 사례를 보존하며 callSessionSeq만 null이다. 교차 DB SQL·고객 데이터 복제·공개 내부 경로는 사용하지 않는다.
4. 원본 FAQ 변경 알림 outbox·claim·순서·재시도·2초 timeout·202 ACK·SYSTEM 감사를 보존한다. 기존 AI_AGENT_URL과 AI_FAQ_TOKEN을 사용하며 토큰이 없으면 대기를 보존한다. 초기 FAQ CLI와 데이터도 원본 방식으로 연결한다. 새 의존성·Redis·브로커·클라이언트 API는 추가하지 않는다.
5. 독립 커밋 후 원본 테스트, production HTTP/DB/감사 대조, 알림 실패·재시작 복구, 신규/기존 DB와 SQL 실패 롤백, 기존 운영/상담/배포 회귀를 검증한다. 검증 근거와 미검증 범위를 기록하고 같은 Jira Task로 develop-backend 대상 MR을 생성한 뒤 사용자 병합을 기다린다.

## 영향 범위

operations의 FAQ 모듈·앱 등록·기존 인증 메타데이터·환경 검증·이미지의 초기 데이터·Ingress/Secret 연결, consultation의 비공개 조회·전역 prefix 제외·모듈 등록, 양 DB changelog와 검증 수치/fixture, parity 검증기·CI·문서를 함께 확인한다. 기존 적용 changeset과 backend/frontend/ai는 변경하지 않는다.

## 검증의 한계

AI 통화 이벤트 수집과 FAQ 질문 사례의 교차 서비스 생성은 다음 단계다. 이번에는 원본과 같은 기존 업무 행을 주입해 상세 조회를 비교하며 이를 수집 API 검증으로 보고하지 않는다. 미답변 FAQ 전환·주문/청구·전체 보관 워커·전체 API 동등성도 후속이다. 실제 Jenkins/k3s/공개 HTTPS 및 실제 AI/PBX/S3 연동은 로컬 임시 PostgreSQL·HTTP 검증과 구분한다.
