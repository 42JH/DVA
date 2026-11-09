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

## 최종 검증 결과 (2026-11-06)

계획 커밋 `6e57230`, 구현 커밋 `4c5a2506adf1b493ba7bb783d12bac276180d00e`에서 검증했다. 커밋 전 fetch한 원격 develop-backend는 여전히 `5c10eed630b3c8663a79c6b352ac91986dfd30fd`이고 backend tree는 동일하다. 수정은 msa/docs뿐이며 적용된 SQL changeset·backend·frontend·AI는 변경하지 않았다.

| 검증 명령/경로 | 확인한 결과 |
| --- | --- |
| order Docker checks/runtime | Linux lint·단위 1개·E2E 6개·TypeScript·보안 기록 5개·프로토콜/트랜잭션 11개 통과 |
| delivery Docker checks/runtime | Linux lint·단위 1개·E2E 5개·TypeScript·인증/입력/소유 SQL 경계 2개 통과. 자기 DB readiness 실패 시 프로세스 health 유지·오류 값 비노출 포함 |
| `python3 msa/parity/verify-order.py` | passed=true, `dva-order-check-018e8208dbca`, 134개 실행/검사/정리 label. 실제 원본 migration·각 소유 DB Liquibase·6개 분리 DB·production 앱에서 취소 **168쌍**, 기존 GET **136쌍**, DELETE **69쌍** 비교 |
| 원본 회귀 | 원본 파일 수정 없이 조회 9개·삭제 4개·취소 18개 통과. NODE_ENV=test이며 자동 업무 워커 제외 |
| 취소 비교/복구 | 비교 Node 12개·취소 복구 6개 통과(부모 test 포함). DELETE 비교 9개·복구 5개, 조회 13개와 배송/상담 중단 각 1개도 통과 |
| `python3 msa/parity/verify-customer.py` | passed=true, `dva-customer-check-8c66f5c24a89`, 71개 실행 label. 기존 고객 조회/쓰기/인증 회귀 |
| `python3 msa/parity/verify-consultation.py` | 최종 파서 확장 이후 재실행도 passed=true, `dva-consultation-check-56992e6d7efe`, 143개 실행 label. 기존 PBX/SSE·녹취/재시도·고객 확인/PIN·분석/콘텐츠·감사/프로세스 종료 복구 회귀 |
| `python3 msa/parity/verify-operations.py` | passed=true, `dva-operations-check-27d2ba419aaa`, 164개 실행 label. 기존 인증·관리자·감사·페르소나·FAQ 및 워커 종료/재시작 회귀 |
| `python3 msa/liquibase/verify.py` | passed=true, **565개 실행/검사 label**. 신규 설치·반복·업그레이드·SQL 실패 원자성·원본 주문/배송 schema/함수·기존 감사/이벤트/이력/체크섬 보존 회귀. 이미지 ID `sha256:1427727fbb11cc1dee59b83a57bc5edd79989d58b48e8d7c363c6177a6d26014` |
| Linux 배포 회귀 | Python 3.13/Bash **62개** 통과, 실행 `dva-order-deploy-56d5912c4d`. 배송을 주문보다 먼저 선택하고 기존 정상 서비스 생략·Secret 보존·실패 복구 유지 |
| 격리 k3s 배송 적용 | 최종 이미지, `dva-delivery-check-9556c63b`, v1.35.5+k3s1. 기존 DB/Secret·Deployment/Service/Ingress server dry-run·최초/정상 교체·의도적 readiness 실패·기존 리소스 복구 통과, HTTP **518건/실패 0건**. progress deadline 오류는 주입한 실패다 |
| 목록/구문 | 원본 96개 API·migration/worker 목록 1개, 이번에 변경한 CJS 13개 구문 검사 통과 |
| 의존성 | 최종 order/delivery 런타임 `npm audit --omit=dev`: 알려진 취약점 **0개**. 기존 개발 의존성 low 8개는 유지 |

실행 label은 Node/Jest 테스트 개수가 아니다. 원본 53개 migration(054까지)을 사용한다. 비교는 각 요청의 HTTP status/body/추적 ID/cache와 전체 order 업무 6개 테이블·배송/이력을 대조하고 통화/고객 행 불변을 확인한다. 생성 UUID는 v4 형식·유일성·이전 요청과 구분·연결을, 생성/무효화/갱신/최초 마감·감사 시각은 실제 요청 구간 및 감사 그룹의 동일 transaction timestamp로 검사한다. 그 값만 관계를 유지해 대조하며 상태·금액·버전·스냅샷 차이를 제거하지 않는다.

- 전체/단건/복수·혼합/역순·전부 기취소와 반복, 모든 주문 상태·빈 주문·삭제/보관 기간, NULL 가격과 총액 0/잔액·정수 오버플로 롤백·최초 closed_at·DB trigger 버전을 확인했다.
- 결제 안내 5 × 완료 안내 6 조합, 미완료 승인/완료/무효, 기존 요청 보존/무효화·새 UUID/잔액/기존 만료일을 확인했다. 배송 7개 상태 각각의 대상 차단과 대상 밖/기취소 상세의 배송·이력 불변을 확인했다.
- 관리자 세 역할·잘못된 cookie/Origin/ID/헤더/DTO, AI의 현재 발신 활성 고객(통화의 과거 customer_seq 무시)·다른 고객·종료/삭제/보관 통화·연결된 종료 주문을 확인했다. 102,321바이트 공개 입력의 내부 전달과 공개 한도 초과 413을 함께 유지했다.
- 동시 전체 요청·같은 상세·중첩 상세와 결제 상태 COMMIT 경합, AI 실행 중 통화 종료/고객 탈퇴의 대기를 확인했다. 뒤쪽 성공 감사 SQL 실패 시 앞선 상세/금액/결제/준비 감사가 함께 롤백된다.
- 감사 준비 뒤와 업무 COMMIT 뒤 실제 SIGKILL, 준비/확정 ACK 유실, 같은 ID 중복 전달·커밋 결과에 abort 미발행, 최종 callback ACK 유실 후 동일 상세 재수신의 결제/감사 불변을 확인했다. 잘못된 source/token/actor/target/금액 metadata도 거절한다.
- 실제 배송/상담 컨테이너 중단 시 해당 취소 503·업무 행 불변, 관리자 로컬 조회와 이미 취소된 상세 no-op은 유지된다. 조회/배송 확인은 같은 eventId도 현재 상태를 읽으며 개인정보 결과를 inbox에 저장하지 않는다.

재현 로그는 ignored `msa/liquibase/verification-logs/`와 각 verification.json에 있다. 최종 검증기들은 소유 라벨을 확인해 생성한 컨테이너/네트워크/임시 이미지를 정리한다. 재검토용 런타임 이미지는 `dva-order-cancellation:local`, `dva-delivery-cancellation:local`로 남긴다.

## 완료 범위와 미검증

이 MR은 기존 두 주문 취소 API와 소유자 조회·감사·배포 연결을 완료한 단위다. 새 공개 API·프론트/AI 변경·Redis/브로커·새 런타임 앱은 없다. 취소에서 결제 승인/디버 취소나 배송 행/이력 변경은 하지 않는다.

실제 운영 Jenkins/DB 적용/k3s/HTTPS·외부 결제/디버/AI는 검증하지 않았다. 로컬 production 비교와 격리 k3s 성공을 운영 성공으로 확대하지 않는다. 분리 DB의 전역 원자성은 보장하지 않으며 업무 COMMIT 뒤 응답/감사 ACK가 유실되면 기존 GET/감사와 원본의 전체 재시도 409·상세 기취소 204로 확인한다. 후속 배송 생성 생산자는 부모 주문 잠금/최신 취소 상태를 확인해야 한다. 전체 보관 워커/교차 소유자 물리 폐기와 생성·수정·접수/재시도·공개 결제/청구·배송 이벤트·남은 상담·최종 전체 동등성은 계속 후속이다.
