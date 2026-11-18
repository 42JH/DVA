# AI 배송 단건 초안 연동 — 055

적용 대상: backend 모놀리식. AI 코드는 이 저장소 작업에서 변경하지 않았다. [전환 순서](parcel-draft-rollout.md)대로 AI·백엔드를 함께 전환한다.

## 호출 순서

1. 업무 의도가 확인되면 기존 `POST /api/customers/context`에 phoneNumber와 최초 call(providerCallId·incomingAt)을 보내 callSessionSeq를 받는다. 새 접수는 더 이상 `POST /api/orders`로 보내지 않는다.
2. 배송 단건마다 `POST /api/parcel-drafts`를 호출한다. 완성한 단건은 READY, 수집 중·단절 정리는 EDITING이다. 신규 고객 등록 전이라도 EDITING은 보존된다. READY에는 활성 고객 등록이 필요하다.
3. 수정 시작과 동시에 PATCH START_EDIT를 전송한다. 이후 PATCH SAVE로 수집값을 보완한다. 같은 배송 단건을 새 UUID로 다시 생성하지 않는다.
4. 통화 종료 후 미완료·수정·취소 요청까지 **모두 저장 성공을 확인한 다음** `POST /api/calls/{callSessionSeq}/order-intake/complete`를 보낸다. FAQ·STT·분석·대시보드 전송 완료를 기다릴 필요는 없다.
5. PBX 종료와 AI 완료가 모두 확인되면 READY만 실제 주문 하나로 변환된다. GET order-intake로 결과와 번호 매핑을 확인한다.

모든 신규 AI API는 `Authorization: Bearer <AI_BUSINESS_TOKEN>`이 필수다. 초안 API에는 `call_session_seq: <DB 통화 번호>`도 필수다. 완료·상태 API는 경로의 통화 번호를 사용한다. 관리자 쿠키를 섞지 않는다. 공통 JSON 응답·오류 형식을 유지한다.

| API | 용도 |
| --- | --- |
| POST /api/parcel-drafts | 단건 생성·이전 미완료 재개 |
| PATCH /api/parcel-drafts/{draftSeq} | 수정 시작·부분 저장·취소 |
| GET /api/parcel-drafts | 기본 INCOMPLETE 목록. status·callSessionSeq·q·limit·offset 지원 |
| GET /api/parcel-drafts/{draftSeq} | 저장값·version·현재 intakeVersion 확인 |
| POST /api/calls/{callSessionSeq}/order-intake/complete | 주문 데이터 전송 완료 확정 |
| GET /api/calls/{callSessionSeq}/order-intake | 대기·확정 결과·실주문 상태·번호 매핑 |

## 단건 생성

```json
{
  "clientParcelId": "75773374-3598-4216-ab9c-67b75603e914",
  "status": "EDITING",
  "parcel": { "origin": { "roadAddress": "서울시 수집 중인 주소" } }
}
```

clientParcelId는 **통화 내 같은 배송 단건의 고정 UUID**다. 생성 응답이 유실되어도 같은 UUID·같은 원본 본문으로 재전송한다. 서버는 현재 초안을 반환하고 내용이 다른 생성 재사용은 409 IDEMPOTENCY_KEY_REUSED다. 응답이 유실된 단건을 새 UUID로 만들면 중복 단건이 될 수 있다.

201의 `data`에는 draftSeq·version·intakeVersion·status·customerSeq·callSessionSeq·callerPhoneNumber·parcel·sourceDraftSeq·orderSeq·orderParcelSeq·시각이 있다. 생성 시 version=1, 변환 전 주문 번호는 null이다. customerSeq가 없는 EDITING도 callerPhoneNumber 사본과 통화 번호로 보존한다. 입력에 발신번호 사본을 직접 지정하지 않는다.

READY의 parcel은 기존 ParcelInputDto와 같다. 양쪽 주소의 name·11자리 phoneNumber·roadAddress·jibunAddress·dongName·5자리 postalCode, 물품 수량 또는 기타 설명, itemPrice, notifiedPrice가 필요하다. detailAddress는 선택이다. itemPrice는 1~100,000,000원 정수다. 배송비는 기존 양의 int32 범위만 검증하며 새로운 요율 일치 검사는 없다. 좌표는 보내지 않는다. 개인 originPin 선택 시 소유권을 확인한다. 신규 COMPANY PIN은 사용할 수 없다. 과거 이관·재개 사본의 기존 COMPANY PIN은 출발지 주소와 PIN 번호가 그대로인 경우에만 유지한다. 출발지를 바꾸면 PIN도 비워야 한다.

신규 고객 단독 등록은 기존 `POST /api/customers`의 이름·11자리 번호·주소 필수 계약을 따른다. 주소가 완성되기 전에는 고객을 임의로 등록하지 말고 EDITING을 저장한다. 등록 후 같은 call로 context를 다시 조회하거나 첫 초안 쓰기를 하면 통화 고객과 해당 통화의 미연결 초안이 연결된다. 이미 연결된 고객 번호를 다른 고객으로 바꾸지 않는다.

## 수정과 취소

```json
{ "expectedVersion": 1, "action": "START_EDIT", "clearFields": ["destination"] }
```

START_EDIT는 해당 값을 즉시 비우고 EDITING으로 바꾼다. clearFields: origin, destination, items, itemPrice, notifiedPrice, originPin, clientComment. 주소·물품·가액을 변경하면 배송비도 비운다. origin 변경은 originPin도 비운다. 수정 시작을 늦게 보내면 서버는 이미 받은 READY가 수정 중이라는 사실을 알 수 없다.

```json
{
  "expectedVersion": 2,
  "action": "SAVE",
  "status": "EDITING",
  "parcel": { "destination": { "roadAddress": "수정 중 새 주소" } }
}
```

SAVE는 생략 필드를 유지하고 허용된 null은 비운다. READY는 START_EDIT 이후 전체 필수값이 다시 충족될 때만 가능하다. 주소·물품을 덜 받은 채 끊기면 같은 draftSeq에 EDITING으로 정리한다. 이전 주소를 되살려 READY로 보내지 않는다.

```json
{ "expectedVersion": 3, "action": "CANCEL" }
```

PATCH 성공마다 version·intakeVersion이 증가한다. 409 VERSION_CONFLICT나 응답 유실은 GET으로 확인한다. PATCH는 오래된 expectedVersion으로 자동 재적용하지 않는다. AI는 현재 통화의 초안만 수정·취소한다. 다른 통화의 미완료는 반드시 새 초안으로 재개한다.

## 미완료 재개

GET `/api/parcel-drafts?status=INCOMPLETE&limit=20&offset=0`은 같은 고객의 미완료만 반환한다. 아직 고객 번호가 없는 미완료는 같은 최초 발신번호 사본으로 범위를 확인한다. 다른 고객으로 이미 연결된 이력을 전화번호만으로 가져오지 않는다. 종료된 현재 통화에서는 그 통화의 초안만 조회한다.

```json
{
  "clientParcelId": "61e02fab-2b24-4ed5-a92d-59cfbcd5be46",
  "sourceDraftSeq": 31,
  "status": "EDITING"
}
```

서버는 새 행을 복사하고 원본을 RESUMED로 바꾼다. 새 version은 1이다. 원본 내용과 최초 보관 시각은 유지한다. 같은 원본의 동시 재개는 한 요청만 성공한다. 같은 새 UUID 재전송은 그 결과를 조회한다. 새 통화에서 완성한 단건은 새 통화 주문으로 들어가며 과거 주문에는 추가하지 않는다.

## 전송 완료 확정

```json
{
  "expectedIntakeVersion": 7,
  "paymentMethodType": "billing",
  "pickupRequestedAt": "2026-11-07T11:00:00+09:00"
}
```

여러 저장을 병렬 전송했다면 모두 await하고 성공 응답의 **가장 큰 intakeVersion**을 사용하거나 GET order-intake로 최신 버전을 확인한다. 응답 도착 순서만으로 버전을 선택하지 않는다. 버전이 다르면 봉인하지 않고 409다. READY가 있으면 paymentMethodType이 필수이며 월·그룹결제 자격과 배송비 합계를 검증한다. READY가 없으면 `{ "expectedIntakeVersion": 7 }`만 보내도 된다.

PBX가 먼저 와도 완료 확정 전 정리 전송은 허용한다. 완료 수신 후 새 단건·수정·취소는 거절한다. 이미 저장한 같은 생성 UUID의 재전송은 현재 결과 조회만 수행한다. 완료 본문의 동일 재전송은 현재 결과를 반환하고 다른 본문은 409 EVENT_PAYLOAD_CONFLICT다. 최초 본문을 보관하고 그대로 재전송한다.

| status | 의미 |
| --- | --- |
| COLLECTING | PBX·AI 완료 전 |
| WAITING_AI | PBX 종료 수신, AI 완료 필요 |
| WAITING_PBX | AI 완료 수신, PBX 종료 필요 |
| FINALIZING | 두 신호가 있고 처리 대기 |
| FAILED | 봉인 보존·로컬 확정 실패. errorCode 확인, 같은 완료 본문 재호출 또는 워커 복구 |
| NO_ORDER | READY 없음. 미완료·취소 초안은 보존, 실제 주문·결제 없음 |
| FINALIZED | 실제 주문 생성 완료. 디버 성공과 구분 |

두 신호 중 하나가 없으면 결제 링크·디버 전송을 시작하지 않는다. 종료가 나중에 도착한 건은 기존 10초 워커에서 복구하며 장애 재시도는 1분 간격으로 제한한다. 서버 재시작으로 완료 신호나 초안이 사라지지 않는다.

FINALIZED 응답은 `orderSeq`, `parcelMappings: [{ "draftSeq": 31, "orderParcelSeq": 82 }]`, 현재 `order`를 포함한다. 후속 업무 이벤트의 주문 번호에는 실제 orderSeq·orderParcelSeq를 사용한다. draftSeq를 실주문 번호로 보내지 않는다. 기존 FAQ·미답변·STT·최종 분석 API 자체는 유지한다. 접수 요약 건수는 완성된 배송 단건 기준이고 카드 결제 대기도 포함한다.

개인 카드: notPaid → 검증된 결제 승인 PAID → 디버 전송. credit/groupBilling: 종료 확정 후 기존 원장 처리와 디버 전송. `order.status=ACCEPTED`만 디버 접수 성공이다. SUBMITTING_FAILED는 기존 최초 전송부터 10분 안의 1분 재시도, SUBMISSION_FAILED는 자동 재시도 종료다. 실제 결제 승인·디버 재시도는 AI가 대신 신고하지 않는다.

수거 시각은 기존대로 AI 값을 보존한다. 그 시각 이후 결제하면 결제 +1시간을 한국시간 09:00~17:00으로 보정하며 17시 초과는 다음날 09시다. 입력 시각 자체에는 새 제한을 추가하지 않았다.

초안은 soft delete와 최초 수집 기준 5년 보관을 따른다. 재개·수정·삭제로 기한을 연장하지 않는다. 원본 고객·통화·주문이 삭제돼도 초안 사본과 번호는 연쇄 삭제하지 않는다. 삭제·만료된 초안은 일반 조회와 재개에서 제외한다.
