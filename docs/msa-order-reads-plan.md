# 주문 조회 4개 API 이식

- Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)
- 기준: MR !352 병합 `c400c7231d1383577734b42da7b586e4e9b991c3`, backend tree `f5b00cd9f9d2f7e09805ed042cbc56a7e305c799`, 원본 migration 054까지.
- 브랜치: `feature/msa-order-reads`. 기존 worktree와 변경은 보존한다.
- 수정 범위: `msa/`, `infra/`, `docs/`. backend·프론트·AI는 읽기 전용이다.

## 계약과 작업 범위

| API | 유지할 동작 |
| --- | --- |
| `GET /api/orders` | 관리자 전체/AI 현재 발신번호의 활성 고객 범위, AND 검색·날짜 경계·정렬·페이지·전체 개수 |
| `GET /api/orders/:id` | 실제 저장 버전·상세·주소/PIN/청구 스냅샷·현재 유효 결제 요청, 타 고객과 없는 주문 모두 404 |
| `GET /api/admin/orders` | 관리자 세션, 상태 탭 묶음·NFC/전화번호/일반 문자 검색·상세 순서 |
| `GET /api/customers/:id/addresses` | 고객 존재 확인, ACCEPTED·ACTIVE 상세만, 양 방향 주소/기간/검색/페이지 |

원본 DTO·SQL·응답 envelope·에러 문구·보관/삭제 조건을 사용한다. call header는 기존 형식 그대로 받고, 만료·잘못된 관리자 cookie가 있으면 AI로 우회하지 않는다. AI는 저장된 call.customer_seq가 아닌 **현재 발신번호와 일치하는 활성 고객**을 사용한다. 종료된 통화는 연결된 주문 상세만 허용하며 목록·이전 주소 조회는 409다. 읽기가 주문/상세/고객/통화/배송/감사/이벤트 업무 데이터를 변경해서는 안 된다.

주문 생성·수정·취소·삭제·결제·청구·접수·배송 업무 이벤트·보관 워커는 다음 MR이다. 이번에 쓰기 API의 일부 성공 응답을 임시로 제공하지 않는다.

## 구현 순서와 영향 범위

1. order에 기존 MSA의 PostgreSQL·설정·관리자 세션 조회·HTTP 검증/에러/보안 기록 기반을 적용하고 네 조회 controller·DTO·repository·service를 연결한다. 기존 패키지 버전을 재사용하며 새 종류의 의존성/앱/Redis/브로커를 도입하지 않는다.
2. 내부 `OrderReadRequested` 조회 이벤트를 order → consultation → customer → order로 전달한다. consultation은 유효한 통화의 상태/발신번호를, customer는 활성 고객 또는 관리자 주소 조회 고객 존재를 확인한다. 해당 행의 공유 잠금을 유지하는 동안 order가 로컬 REPEATABLE READ 스냅샷으로 조회한다. order는 원격 대기 중 자기 DB 연결을 점유하지 않는다. 다른 소유자의 테이블과 개인정보 응답 캐시를 복제하지 않는다. 조회 재시도는 현재 상태를 다시 읽으며 outbox/inbox 업무 이력을 생성하지 않는다.
3. 기존 내부 토큰·보안 로그 Secret을 재사용한다. 내부 source/type/payload/응답 ID·구조·크기·timeout을 검증하고 오류/응답 유실은 안전한 오류로 반환한다. 내부 controller는 공개 Ingress·OpenAPI에서 제외한다. 고객 잠금은 원본과 동일한 일관된 접근 판정을 위한 것으로, 동시 쓰기는 짧게 대기할 수 있다.
4. Docker context·health/readiness·k3s 환경/기존 공개 경로·Jenkins parity 단계·서비스 선택/배포 순서와 문서를 함께 연결한다. `/api/customers/:id/addresses`는 customer Prefix보다 구체적인 order 라우트로 보낸다. 기존 customer API 경로를 덮어쓰지 않는다.

## 검증 및 완료 조건

- Linux Docker lint·단위/E2E·TypeScript 빌드, 이벤트/기준 목록 검사.
- 실제 원본 migration과 MSA Liquibase DB를 각각 설치하고 동일 고정 fixture를 저장한다. 원본과 4개 API의 정상·잘못된 입력·cookie/권한·통화 상태·발신번호/고객·기간·정렬/페이지·삭제/보관·결제 요청/청구 스냅샷 응답을 비교한다. requestId 등 의도한 비결정 값만 명시적으로 처리한다.
- 조회 전후 소유 DB 업무 행·버전·시각·감사/이벤트 수가 동일한지 확인한다. 다른 고객·배송 개인정보가 응답에 나타나지 않는지 확인한다.
- 같은 조회 이벤트 재수신, 잘못된 내부 인증/본문/ACK, 응답 유실·의존 장애, 통화 종료·고객 상태 변경과 조회 잠금 경합, 주문/상세 동시 수정의 스냅샷 일관성을 검증한다.
- 변경되는 customer/consultation 내부 경로의 기존 정상 API 회귀와 Linux 배포 회귀를 수행한다. 검사 완화나 원본 테스트 기대값 수정으로 차이를 숨기지 않는다.
- 계획/구현/검증 근거를 커밋하고 최신 원격을 다시 확인한 뒤 Task 160에 연결한 MR → develop-backend를 생성한다. 승인·병합·자동 병합·브랜치 삭제는 하지 않고 사용자 병합 확인을 기다린다.
- 로컬 정적 검사·컴파일·테스트·실제 컨테이너 실행을 구분하며, 운영 Jenkins/k3s/HTTPS와 외부 AI/디버/결제 및 전체 API 동등성은 별도 미검증 범위로 보고한다.
