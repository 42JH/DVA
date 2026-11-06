# 주문 전체·상세 취소 동등성 작업

- Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)
- 기준: MR !359 병합 `5c10eed630b3c8663a79c6b352ac91986dfd30fd`, backend tree `f5b00cd9f9d2f7e09805ed042cbc56a7e305c799`, 원본 054까지.
- 작업 브랜치: `feature/msa-order-cancellation` → `develop-backend`. msa/docs만 수정하고 frontend·AI·backend는 읽기 전용이다. Redis·브로커·새 런타임 앱·클라이언트 토큰을 추가하지 않는다.

## 범위와 원본 계약

`POST /api/orders/:id/cancel`, `POST /api/orders/:id/parcels/cancel`을 같은 관리자/AI 접근·DTO·OpenAPI·204/오류·감사로 이식한다. AI는 call_session_seq의 미삭제·보관 기간 내 통화와 현재 발신번호의 활성 고객을 사용한다. 종료 통화는 이미 연결된 주문에만 허용한다. 관리자도 전달한 잘못된 통화 헤더는 400이며 잘못된 cookie를 AI로 우회하지 않는다.

원본 취소는 부모 주문 → 모든 상세 순으로 잠근다. 상세 소속 오류 404, 이미 취소한 선택 상세만 요청하면 아무 쓰기 없이 204, 전체 취소 반복 409, COLLECTING/notPaid 외 상태 거절, 승인 진행 중 거절 순서를 보존한다. 대상 ACTIVE 상세에 배송이 하나라도 있으면 상태와 무관하게 거절하며 notPaid의 빈 상세도 거절한다. 따라서 이 API에서 배송 취소 UPDATE의 대상은 항상 없다. 배송은 변경하지 않고 소유 DB에서 실제 존재 여부를 확인한다. 후속 배송 생성 생산자는 부모 주문 잠금/최신 취소 상태 확인을 함께 지켜야 한다.

상세 선택 취소 시 상세별 ORDER_PARCEL_CANCELLED, 전부 취소 시 ORDER_CANCELLED, 활성 대상이 있으면 ORDER_AMOUNT_CHANGED를 원본 순서대로 남긴다. 원본 DB trigger의 버전 증가·최초 closed_at을 유지하고 ACTIVE 상세 가격으로 총액을 다시 계산한다(없으면 0, 미입력 가격이 남으면 NULL). 기존 notPaid에서는 미완료·미무효 결제 요청을 모두 무효화하고 남은 금액이 양수일 때 같은 payment_due_at으로 새 UUID 요청을 만든다. 안내 상태를 임의로 바꾸거나 결제 승인/디버 취소를 호출하지 않는다.

## 구현 영향 범위

- order: 공개 controller/DTO·service·repository, 감사 receiver 허용 동작/메타데이터, 비공개 AI 취소 callback, DELIVERY_URL 검증과 k8s 설정.
- consultation/customer: 기존 통화/고객 잠금 경로를 재사용하는 인증된 취소 이벤트. order 공개 요청은 DB 연결을 잡지 않고 consultation → customer → order callback을 기다린다. callback은 AI만 지정 가능하며 관리자 사칭 입력을 받지 않는다.
- delivery: 기존 NestJS에 PG 연결·실제 DB readiness·인증된 배송 존재 조회만 연결한다. 원본 선택 행/잠금 조건을 사용하고 DB 복제·이벤트 수신 이력/응답 캐시를 만들지 않는다. 기존 DB·기존 CUSTOMER_AUTH_TOKEN을 사용한다.
- shared/events: 엄격한 취소 명령/응답 검사. 조회 프로토콜은 읽기 전용 의미를 유지한다.
- CI/deploy: delivery의 공통 이벤트/PG 의존성·Docker context·Secret·배포 순서와 영향 서비스의 비교 검증 선택, fixture를 함께 연결한다. 적용된 Liquibase SQL은 수정하지 않는다.
- parity/docs: 원본 회귀와 production 동일 입력 HTTP·전체 업무 행/감사·동시성·실패 복구·개인정보 범위 검사 및 증거 기록.

## 검증 계획

1. Docker Linux lint·단위/E2E·TypeScript, 취소/배송 프로토콜과 감사 입력 위조 거절 검사.
2. 원본 migration 및 각 소유 DB Liquibase를 적용한 실제 production 앱 비교. 전체/부분/단건·혼합/전부 기취소, 8개 상태·삭제/보관·빈 주문, 금액 NULL/합계/0·버전/closed_at, 승인/배송/결제 요청·안내 상태, 모든 관리자 역할과 AI 통화·현재 고객 범위를 비교한다.
3. 잘못된 DTO/ID/헤더/Origin/cookie, 반복·동시 취소·주문 잠금 경합·감사 SQL 실패 rollback, 서비스 중단·응답 유실·생산자 종료 후 확정/중단을 확인한다. 분리 DB 커밋과 원격 감사 확정 사이를 전역 원자성으로 보고하지 않는다.
4. 기존 주문 GET/DELETE, customer/consultation/operations 영향 경로와 Linux 배포 회귀·목록 검사를 실행한다. DB DDL 변경이 없더라도 실제 delivery schema와 PG 연결/소유권 분리를 확인한다.
5. 성공한 명령·수치·제외 사항을 기록하고 작업 단위 커밋/Push/MR/Jira 코멘트로 연결한다. 사용자 병합 후 다음 작업으로 진행한다.

## 남은 범위

주문 생성·수정·접수/재시도, 공개 결제/청구 API 및 자동 워커, 배송 생성/후속 이벤트, 남은 상담과 교차 서비스 보관·전체 동등성 검증은 별도 후속이다. 실제 운영 Jenkins/k3s/HTTPS·외부 결제/디버/AI 검증은 로컬 production 비교와 구분한다.

## 구현 중 확인한 입력 경계

최초 production 비교에서 공개 원본 한도 아래인 102,321바이트 선택 목록은 원본 404였으나 MSA 내부 envelope의 기본 100KiB 파서가 413을 내고 공개 503으로 변환했다. 배송 내부 조회에도 같은 413을 재현했다. 공개 한도/원본 기대값은 유지하고 새 내부 경로만 기존 call-scope와 같은 256KiB 파서로 연결한다. 이 큰 입력 비교와 공개 413 회귀를 남기며 최종 재검증 결과는 아래에 기록한다.

공개 413 회귀는 내부 express.json을 직접 등록하면 Nest가 함수 이름 jsonParser만 보고 기본 공개 파서 등록을 생략한다는 추가 원인도 검출했다(설치된 express-adapter의 registerParserMiddleware/isMiddlewareApplied 확인). 기존 customer/consultation과 같은 익명 래퍼로 내부 파서를 등록해 공개 파서를 보존한다. 413 기대값과 실제 production 입력 비교는 유지한다.
