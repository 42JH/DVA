# 고객 수정·개인 PIN 이식

Jira [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160), !300 병합 `5cefb2e`, backend 트리 `a86433ae1728c2a4681a3fce35cfc33fd3eee335`, 작업 브랜치 `feature/msa-customer-pins`를 기준으로 한다. backend·프론트·AI는 읽기 전용이다. 추적 수정은 msa/infra/docs로 한정하고 별도 프론트/AI API·Redis·브로커를 추가하지 않는다.

## 구현 범위

1. 기존 PATCH `/api/customers/:id`, GET/POST `/api/customers/:id/pins`, PATCH `/api/pins/:id`를 원본 Controller/DTO/Service/SQL 계약으로 이식한다. customer 공개 API는 22/23개가 된다. 기업 청구 GET과 자동 청구 워커는 주문·청구 단계에서 연결한다.
2. 이름 단독 AI 수정·관리자 세션/Origin·상태/월결제 관리자 전용·탈퇴 복구 거절·내 주소 null/전체 교체를 유지한다. AI 기본 주소는 진행 중 본인 통화만 허용한다. PIN 조회는 진행 중 통화만, 쓰기는 종료 후에도 허용하며 삭제/5년 보관 만료·다른 고객/전화번호 재사용은 거절한다.
3. PIN의 NFC/문자열/11자리 전화번호·완성 주소 검증, 리터럴 검색/페이지/total_count·삭제 숨김, DB 정규화 주소 중복, 지정 필드만 변경·호환 expectedVersion 무시·실제 변경 버전 증가·소유권/기존 주문 스냅샷 보존을 유지한다. 기존 customer 006까지의 함수/트리거/인덱스를 재사용하고 적용 changeset은 수정하지 않는다.
4. 공개 인증/검증을 마친 AI 요청은 인증 이벤트로 consultation에 통화 범위 처리를 요청한다. consultation은 원본처럼 통화를 읽고 쓰기에는 FOR SHARE를 유지한 채 customer의 고정 내부 실행 경로에 위임한다. customer가 자기 DB/감사 결정을 커밋하고 감사 ACK를 확인할 때까지 통화 잠금을 유지한다. 교차 DB 쿼리·HTTP 너머로 SQL 클라이언트 전달·세션 복제는 하지 않는다.
5. 내부 실행은 원본 업무 서비스에 통화 스냅샷을 주입한다. 쓰기의 동일 이벤트는 업무·감사와 같은 트랜잭션의 customer inbox로 중복 방지하며 입력은 해시, 결과는 식별자/버전만 보관한다. 조회 결과/주소/전화번호를 메시지 수신 기록에 저장하지 않는다. 기존 준비/확정/중단·SIGKILL 감사 복구를 재사용하고 operations의 customer 허용 목록에 해당 감사 action/target만 추가한다.
6. 모든 호출자·내부 토큰/경로·Swagger·Ingress·Docker/CI·배포 fixture·문서·테스트를 함께 확인한다. 추가 공개 경로나 도구/런타임 앱은 만들지 않는다.

## 검증 순서

- 원본 고객/PIN 통합 테스트를 수정 없이 모놀리식에서 실행한다. 동일 HTTP/초기 데이터를 실제 customer/consultation/operations 분리 DB에 보내 네 API와 참조 DTO, 응답/오류/쿠키/메타·매 요청 후 고객/PIN/감사 전체 업무 행을 비교한다.
- 이름/상태/주소와 PIN 생성/검색/부분 수정·버전·중복·삭제/탈퇴·통화 번호/종료/삭제/만료·전화번호 재사용·현재 관리자 권한/세션 회수·입력 검증/오류 우선순위를 확인한다. 기존 주문 주소 스냅샷을 건드리지 않는 원본 SQL과 독립 DB 소유권도 확인한다.
- 실제 PG 잠금으로 통화 종료 앞/뒤 경합을 재현하고, 동시 PIN 부분 수정/중복 생성·감사 실패 rollback·내부 동일 이벤트/변조/잘못된 토큰·성공 응답 유실/생산자 종료 복구를 확인한다. 모의 장애와 실제 프로세스/DB 장애를 구분해 보고한다.
- Linux lint/build/단위/E2E, 기존 customer/consultation/operations·이벤트·DB·배포 회귀를 수행한다. production PBX/읽기와 NODE_ENV=test 전경 업무를 구분하며 전체 자동 워커 동등성으로 확대하지 않는다.
- 계획 → 구현 → 검증 결과를 작업 단위로 커밋하고 같은 Jira Task에 연결한 MR → develop-backend를 생성한다. 직접 승인/병합·자동 병합·이슈 상태 변경은 하지 않는다. 사용자 병합 확인 후 다음 MR을 시작한다.

실제 운영 Jenkins/HTTPS·실제 PBX/S3·전체 95개 API/자동 워커·모든 분산 장애는 후속 검증이다. 기술 수신 기록의 전체 보관 정책은 기존 보관 워커 이식 단계에서 연결한다.
