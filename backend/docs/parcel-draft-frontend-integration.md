# 프론트 배송 초안·미완료 연동 — 055

관리자 세션·허용 Origin과 기존 공통 응답을 사용한다. 프론트 코드는 이번 작업에서 수정하지 않았다. [배포 전환](parcel-draft-rollout.md)과 [AI 계약](parcel-draft-ai-integration.md)을 함께 확인한다.

## 리소스 구분

- `draftSeq`: 수집 중·미완료·재개 배송 단건. 실제 주문 번호가 아니다.
- `orderSeq`, `orderParcelSeq`: 종료 확정 이후 생성되는 실제 주문·상세 번호.
- `version`: 해당 초안의 동시 수정 버전. `intakeVersion`: AI 통화 전체 초안 집합의 버전. 관리자 단독 초안의 intakeVersion은 null이다.
- `sourceDraftSeq`: 재개 전 원본 번호. 원본 행이 삭제돼도 보존하는 논리 참조다.

## 조회·삭제

| API | 역할 |
| --- | --- |
| GET /api/parcel-drafts | 기본 INCOMPLETE 목록. status=ALL 또는 READY/EDITING/INCOMPLETE/CONVERTED/CANCELLED/RESUMED |
| GET /api/parcel-drafts/{draftSeq} | 주소·물품 사본, 소유 고객·통화·발신번호 사본, 버전·시각·원본/변환 번호 |
| DELETE /api/parcel-drafts/{draftSeq} | 관리자 soft delete. 실제 주문·원본·재개 초안 삭제/취소를 대신하지 않음 |
| GET /api/calls/{callSessionSeq}/order-intake | 신규 통화의 주문 확정 상태·결제/디버 상태·변환 매핑 |

목록 필터는 status·customerSeq·callSessionSeq·legacyOrderSeq·q다. q는 발송/수령 이름·전화·주소 부분 검색이다. limit 기본20·최대100, offset 기본0. 최신 생성 시각·draftSeq 내림차순. 응답은 `{data:[], hasNext, total_count}`다. 나머지 JSON은 `{data, meta}`다. 삭제·5년 만료 필터는 서버에서 적용한다.

초안 상세의 parcel은 양쪽 주소 객체와 documentCount/smallBoxCount/mediumBoxCount/bigBoxCount/otherItemDescription/clientComment/itemPrice/notifiedPrice/originPin을 가진다. 미수집 값은 null 또는 기존 기본 0·빈 문자열이다. 과거 가액은 조회에서 보존하지만 READY 저장은 현재 1원~1억원 정수 규칙을 적용한다. 과거 COMPANY PIN 참조는 출발지·PIN 번호가 같은 재개 사본에서 유지하며 새 선택에는 사용할 수 없다.

customerSeq가 없는 미등록 고객 초안도 목록에 표시한다. callerPhoneNumber는 최초 발신번호 사본이며 원본 통화 삭제 후에도 남는다. 고객·통화·주문의 현재 이름이나 상태를 반드시 얻을 수 있다고 가정하지 않는다. 원본 상세가 404여도 초안 자체를 숨기지 않는다.

## 관리자 보완 흐름

1. INCOMPLETE를 읽고 `POST /api/parcel-drafts`로 새 단독 초안을 만든다.
2. `PATCH /api/parcel-drafts/{새 draftSeq}`로 내용을 보완해 READY로 만든다.
3. `POST /api/admin/parcel-drafts/{새 draftSeq}/submit`으로 별도 ADMIN 주문을 만든다.
4. 반환 orderSeq로 기존 주문 상세·결제·디버 상태 화면을 사용한다. 과거 통화의 이미 확정된 주문에 상세를 추가하지 않는다.

```json
{
  "clientParcelId": "61e02fab-2b24-4ed5-a92d-59cfbcd5be46",
  "sourceDraftSeq": 31,
  "status": "EDITING"
}
```

원본에 customerSeq가 있으면 그 고객을 유지한다. 고객이 아직 없는 원본은 관리자가 활성 고객을 확인해 `customerSeq`를 명시한다. 다른 고객으로 이미 연결된 원본을 임의로 바꿀 수 없다. 응답의 새 draftSeq와 version을 보관한다. 생성 응답 유실 시 같은 clientParcelId와 원본 본문으로 재전송한다.

```json
{
  "expectedVersion": 1,
  "action": "SAVE",
  "status": "READY",
  "parcel": {
    "destination": {
      "name": "수령인", "phoneNumber": "01012345678",
      "roadAddress": "서울시 새 도로 1", "jibunAddress": "서울시 새 동 1",
      "dongName": "새동", "postalCode": "01234", "detailAddress": ""
    },
    "smallBoxCount": 1, "itemPrice": 10000, "notifiedPrice": 3500
  }
}
```

원본 출발지 등 생략 값은 유지한다. 필수값이 남아 있으면 READY는 422다. 이미 READY인 단독 초안을 다시 편집할 때는 먼저 `{expectedVersion, action:"START_EDIT", clearFields:["destination"]}`로 EDITING 전환한다. 변경한 주소·물품·가액의 배송비도 다시 입력한다. PATCH 응답 유실·409 VERSION_CONFLICT는 상세를 재조회한다.

```json
{
  "expectedVersion": 2,
  "paymentMethodType": "billing",
  "pickupRequestedAt": "2026-11-07T11:00:00+09:00"
}
```

최종 접수 응답은 기존 OrderResult 형식에 draftSeq·orderParcelSeq가 추가된다. 카드면 notPaid와 paymentRequest, 월·그룹결제면 결제·디버 현재 상태다. 같은 변환 초안의 재호출은 기존 주문의 현재 결과를 반환한다. HTTP 200만으로 접수 성공을 표시하지 않는다. ACCEPTED만 디버 성공이다.

통화 중 READY/EDITING은 관리자가 직접 수정·삭제하지 않고 통화 확정을 기다린다. 완료된 INCOMPLETE를 새 단독 초안으로 재개한다. 최종 확정 전 초안이 있는 통화 DELETE는 409다. 통화 확정·녹취 저장을 마치면 기존 통화 DELETE를 사용할 수 있고 초안은 별도로 남는다.

## 기존 화면 영향

- 055에서 이관한 COLLECTING 원본은 `GET /api/orders`, `GET /api/admin/orders`에서 중복 표시하지 않는다. 미완료 화면은 새 초안 목록을 사용한다. 이관 원본 주문의 알려진 번호로 상세를 읽는 것은 가능하지만 수정·취소·최종 접수는 409다. `GET /api/parcel-drafts?legacyOrderSeq={원본 orderSeq}`로 이동 대상을 찾는다.
- 과거 원본 주문·고객·통화·주문 상세를 자동 삭제하지 않는다. 새 초안의 참조는 논리 참조다. 원본이 없어도 초안의 주소·물품·발신번호 사본과 참조 번호를 표시한다.
- 기존 관리자 수기 `POST /api/admin/orders`, 실제 주문 내부 보정·결제/디버 재시도·미결제 취소는 유지한다. 이전 관리자 부분 주문 API와 055 이전 통화 호환도 유지한다. 이관되지 않은 기존 관리자 부분 주문은 기존 경로로 보완 가능하다.
- 새 AI 접수는 통화 중 실제 orders를 생성하지 않는다. 수집 중 내역은 `GET /api/parcel-drafts?callSessionSeq=...&status=ALL`로 확인한다.

## 통화 확정 상태

GET order-intake의 status는 COLLECTING/WAITING_AI/WAITING_PBX/FINALIZING/FAILED/NO_ORDER/FINALIZED다. FAILED는 errorCode를 함께 표시하고 저장 실패를 접수 성공으로 안내하지 않는다. PBX·AI 중 없는 신호는 기다리며 결제·전송하지 않는다. FINALIZED의 `order.status`로 카드 결제 대기/결제 완료/디버 접수 중/접수 완료/재시도 실패를 표시한다. orderSeq·parcelMappings는 보존하고 실제 주문이 삭제·만료되면 order는 null이다.

이 상태 조회는 읽기 전용이다. 새 SSE나 클라이언트 POST 카운터는 추가하지 않았다. 기존 통화 수 SSE는 그대로 사용한다. 필요할 때 통화 상세 진입·재조회와 기존 새로고침 주기에 맞춰 상태를 조회한다.

초안 DELETE 204는 soft delete다. 최초 보관 시작부터 5년이 지나면 실제 폐기하며 재개·수정·삭제일로 연장하지 않는다. 로그 7일 정책과는 별도다. 삭제된 원본 때문에 다른 초안이나 실제 주문을 함께 제거하지 않는다.
