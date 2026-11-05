# 고객 확인·통화 등록 단계

Jira [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160), 기준 !293 병합 `198dc54`, 작업 브랜치 `feature/msa-caller-context`. backend 트리는 `12ad37a492879c47b6c1f78c3c3f3bdfdf98edda`다. backend·프론트·AI는 읽기 전용이며 변경은 msa/infra/docs만 허용한다.

## 범위와 순서

1. 기존 `POST /api/customers/context` 한 개의 조회·통화 등록 계약을 완전히 연결한다. call 없는 조회는 업무 데이터를 저장하지 않는다. call이 있으면 최초 번호·수신 시각과 providerCallId를 유지하고 같은 통화를 재사용한다. 고객·주문을 임의 생성하지 않는다.
2. consultation이 통화 트랜잭션과 공개 요청 처리를 소유한다. customer에 서비스 인증을 거친 조회 이벤트로 현재 고객·소속·결제 자격·개인 PIN을 조회한다. 조회 이벤트는 재시도마다 새 스냅샷을 읽으며 개인정보 응답을 inbox/outbox에 복제하지 않는다. 프론트/AI의 요청·응답·인증 계약은 변경하지 않는다.
3. PBX와 같은 발신번호 잠금·미연결 종료 매칭, 유일 통화·중복/충돌·5년/삭제 경계를 유지한다. 후속 consultation 004로 고객 논리 참조를 추가하며 과거 연결은 추정하지 않는다. 고객 조회 실패는 통화·PBX 매칭을 롤백한다.
4. 성공 CALL_STARTED 감사는 기존 customer의 준비/확정/중단·생산자 종료 복구 방식을 consultation에도 적용한다. operations는 서비스별 허용 action·인증·준비 테이블을 분리하며 consultation의 토큰으로 customer 감사를 조작할 수 없게 한다. operations 006은 별도 준비 테이블만 추가하고 기존 customer 감사/이력은 보존한다.
5. 후속 SQL·시작 스키마 검사·Secret·정확한 Ingress 경로·배포 의존 순서·Docker context·Jenkins 비교 검증과 모든 호출자를 함께 연결한다. 통화 트랜잭션/감사 ACK 전에 성공 응답하지 않는다.

## 검증

- 입력/인증·OpenAPI operation과 참조 DTO, 등록/미등록/탈퇴·소속/결제/PIN·정규화·중복/충돌·삭제/만료·통화 재사용을 원본과 동일 HTTP/실제 분리 DB로 비교한다.
- PBX 선도착·진행 통화 수·고객 참조·한 번만 생성되는 감사, 동시 요청과 실패/재시작/응답 유실·직후 감사 조회를 검사한다. 고객 조회/감사 준비 실패가 통화나 성공 감사를 남기지 않는지 확인한다.
- 조회 이벤트의 토큰/형식·리다이렉트/잘못된 응답·서비스별 감사 권한, 기존 customer/consultation/operations와 이벤트·배포·DB 이관/rollback을 회귀 검증한다.
- 실제 운영 Jenkins/HTTPS·외부 PBX/S3 및 전체 95개 API 동등성과 구분해 결과를 기록한다.

고객 PATCH·개인 PIN 3개·기업 청구 및 나머지 상담/주문/운영 기능·전체 보관 워커는 후속 MR이다. 별도 프론트/AI API나 Redis/브로커를 추가하지 않는다. 개인정보 조회의 서비스 경계와 외부 의존성 장애를 숨기지 않는다.
