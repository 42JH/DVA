# 기업 청구 조회·월 전환 이식

## 기준과 작업 범위

- Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160).
- MR !360 병합 `cf85fe37ff9b4426f25859fa8e2a5f6a71031021`, backend tree `f5b00cd9f9d2f7e09805ed042cbc56a7e305c799`와 원본 054까지를 기준으로 한다.
- 전용 브랜치 `feature/msa-billing-months`에서 `msa/`, `docs/`만 수정한다. backend·프론트·AI는 읽기 전용이며 외부 API·입력·인증 형식은 유지한다.
- 이번 단위는 `GET /api/companies/:id/billing`과 `OrganizationBillingService.rollover`다. 결제 완료 시 사용액 적립은 주문 접수/결제 이식에서 연결한다. 기존 주문 금액·결제 요청·배송은 이번 워커가 변경하지 않는다.

## 구현 계획

1. 원본 청구 DTO·월 기본값·응답·404를 customer 공개 경로에 연결한다. 현재 기업명은 customer에서 확인하며 order는 자기 원장의 보존된 이름·금액을 우선 반환한다. 삭제된 기업도 과거 원장이 있으면 조회한다. GET은 원장을 생성하지 않는다.
2. order의 10초 워커가 한국 시간 기준 누락 월을 원본 `generate_series` 규칙으로 찾고 10건 단위로 처리한다. customer의 비삭제 기업 공유 잠금 동안 order callback이 원장을 초기화한다. INACTIVE 기업도 포함하고 삭제 기업은 제외한다. 원본 advisory lock·중복 방지·이전 금액 감사·배치 롤백을 유지한다.
3. 기존 CUSTOMER_AUTH_TOKEN·HTTP 이벤트·AuditPrepared/Committed/Aborted와 생산자 잠금 복구를 재사용한다. 내부 이벤트 source/type/payload/응답을 검사하고 비공개 경로는 Ingress/OpenAPI에서 제외한다. 같은 초기화 재수신은 원장 유일성으로 no-op이며 조회/기업 스냅샷을 inbox에 저장하지 않는다.
4. customer/order 모듈·환경·테스트·검증기·Jenkins 검사 범위·문서를 함께 확인한다. 기존 Liquibase 원장을 사용하고 타 소유자 테이블·Redis·브로커·새 런타임 의존성을 추가하지 않는다.

## 검증 계획

- 원본 청구 관련 회귀를 backend 파일 수정 없이 실행한다.
- 실제 원본 migration/MSA Liquibase와 분리 DB에서 같은 조회 입력의 HTTP/OpenAPI를 비교한다. 기본 한국 월·명시 월·삭제/상태/이름 스냅샷·0/큰 정수 금액·인증/DTO 오류를 포함한다.
- 원본 rollover와 MSA의 원장·감사 순서/actor/target/metadata를 비교한다. 새 기업·누락 월·과거/미래 월·이전 사용액·10건 배치 경계·반복/동시 실행·삭제/수정 경합·배치 뒤쪽 실패 롤백을 확인한다.
- 실제 워커 자동 실행·재시작, 감사 준비/커밋 뒤 종료·ACK 유실·중복 전달과 의존 장애를 확인한다. 복구 후 중복 원장/감사가 없어야 한다.
- 영향받는 customer/order/operations의 빌드·lint·타입·단위/E2E와 기존 동등성 회귀를 실행한다. 배포 제어를 바꾸면 해당 회귀와 격리 실행을 추가한다.
- 실행한 명령과 결과만 완료 근거로 기록한다. 운영 Jenkins·DB·HTTPS와 외부 결제/디버/AI는 로컬 검증과 구분한다.

## 한계와 후속

분리 DB의 전역 원자성은 보장하지 않는다. 기업 공유 잠금과 order 로컬 원장/감사 결정 커밋을 연결하며 확정 응답 유실은 기존 감사 복구와 원장 유일성으로 수렴시킨다. 주문 생성·수정·접수/재시도·결제/사용액 적립·배송 생성/후속 이벤트, 남은 상담·교차 소유자 보관·최종 전체 동등성은 후속이다.
