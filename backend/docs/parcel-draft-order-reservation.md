# 미완료 예약번호·관리자 주문 통합 목록

현재 유효한 초안의 기준은 [24시간·최신 확정 통화 정책](incomplete-expiry-latest-call.md)을 따른다. 만료된 초안은 전체/미완료 목록·건수에서 제외하며 번호는 재사용하지 않는다. 배포 시 059 조회 인덱스도 함께 적용한다.

기존 055의 초안·실제 주문 분리는 유지한다. 사용자 확정에 따라 미완료를 관리자 전체 목록에도 표시하고 주문번호를 사전 예약한다. 이 문서가 과거 명세의 `all`·COLLECTING 조회 설명보다 우선한다. 운영 배포 전 057·058 migration을 적용한다.

## 초안 예약번호

`GET /api/parcel-drafts`, `GET /api/parcel-drafts/{draftSeq}`와 초안 생성·수정 응답에 양의 정수 `reservedOrderSeq`를 제공한다. `DV-${String(reservedOrderSeq).padStart(5, '0')}`로 표시한다. 조회·보완에는 계속 draftSeq를 사용한다.

- 실제 orders의 identity 시퀀스에서 번호를 예약한다. 번호 예약만으로 orders·결제·외부 접수 행을 생성하지 않는다.
- 같은 생성 clientParcelId 재전송은 같은 초안·예약번호를 반환한다. 클라이언트는 예약번호를 지정하지 않는다.
- 원본 INCOMPLETE를 새 초안으로 재개하면 예약번호를 이어 쓴다. 원본은 RESUMED가 되고 기록용 번호를 보존하며, 현재 초안 한 개만 번호를 소유한다.
- 관리자 단독 초안을 접수하면 해당 예약번호가 실제 orderSeq가 된다.
- 한 AI 통화의 여러 READY 배송은 기존처럼 한 주문으로 묶는다. draftSeq 오름차순의 첫 READY 초안 예약번호를 실제 orderSeq로 사용하고 나머지 번호는 사용하지 않는다. 변환 후 실제 주문 이동은 응답 orderSeq를 따른다.
- 삭제·취소·롤백·묶음 전환으로 번호에 빈 구간이 생길 수 있다. 번호는 행 순번이 아니며 기존 실제 주문번호를 재정렬하지 않는다.
- 058은 기존 초안에도 새 예약번호를 부여한다. legacyOrderSeq·원본 주문·배송 사본과 생성/보관 시각은 보존한다. 이미 존재하는 원본 주문번호를 새 주문번호로 재사용하지 않는다.

## 관리자 주문 목록

`GET /api/admin/orders`의 전체 목록은 실제 주문과 조회 가능한 INCOMPLETE 초안을 함께 반환한다. 초안은 `status: "COLLECTING"`으로 표시한다.

| 필드 | 실제 주문 | 미완료 초안 |
| --- | --- | --- |
| orderSeq | 실제 주문번호 | 예약 주문번호(reservedOrderSeq) |
| draftSeq | null | 배송 초안 번호 |
| status | 기존 실제 주문 상태 | COLLECTING |
| createdAt | 주문 생성 시각 | 초안 생성 시각 |
| pickupRequestedAt | 기존 값 | null |
| parcels | 기존 주문 배송상세 배열 | 초안 사본 한 개의 배열 |
| parcels[].orderParcelSeq | 실제 상세 번호 | null |
| parcels[].status | 기존 ACTIVE/CANCELLED | ACTIVE |

`draftSeq !== null`이면 초안 상세·이어가기로 이동한다. 이 행의 orderSeq는 예약번호이므로 실제 주문 상세 API에 전달하지 않는다. 주소·물품은 해당 parcels 사본으로 표시한다. 실제 주문의 기존 필드는 유지한다.

- 상태 조건 생략: 실제 주문 + INCOMPLETE 초안.
- `statusGroup=COLLECTING`: INCOMPLETE 초안만.
- `notPaid`, `PAID`, `SUBMISSION_FAILED`, `CANCELLED`: 기존 실제 주문 상태 묶음.
- 정렬: 두 리소스를 함께 createdAt 내림차순·표시 orderSeq 내림차순으로 정렬한 뒤 limit·offset을 적용한다.
- `q`, `from` 포함·`to` 미포함, `organizationSeq`를 두 리소스에 적용한다. 초안 기간 필터는 이미 제공하던 생성 시각 기준을 재사용한다.
- 초안은 원본 고객·통화·주문 삭제와 독립적인 보관 기준을 유지한다. 삭제·5년 만료 초안은 제외한다.
- total_count는 선택 탭의 통합 기준 건수다. statusCounts.all은 실제 주문 + INCOMPLETE 건수, incomplete는 그중 초안 건수다. all에 incomplete를 다시 더하지 않는다.
- 목록·전체/상태 건수는 같은 읽기 전용 스냅샷으로 조회한다. 페이지가 비어도 건수를 유지한다.

별도 `GET /api/parcel-drafts?status=INCOMPLETE`도 유지한다. 홈의 todayOrderCount는 기존처럼 오늘 생성한 실제 주문 건수이며, 초안을 포함한 관리자 전체 목록의 total_count와 단위가 다르다.

## 기존 이어가기 흐름

1. 삭제·만료되지 않은 INCOMPLETE를 조회한다. 통화 중 READY/EDITING은 관리자 이어가기 대상이 아니다.
2. 새 clientParcelId와 sourceDraftSeq로 `POST /api/parcel-drafts`를 호출한다. 원본 고객이 있으면 그 고객을 유지하고, 없으면 활성 고객을 지정한다.
3. 새 초안은 원본 주소·물품 사본과 보관 시작 시각·예약번호를 이어 받는다. 원본은 RESUMED로 전환한다. 같은 원본의 동시 재개는 잠금으로 직렬화한다.
4. EDITING이면 PATCH로 필수값을 보완해 READY로 만든다. 이미 READY를 편집할 때는 START_EDIT·clearFields와 최신 expectedVersion을 사용한다.
5. `POST /api/admin/parcel-drafts/{새 draftSeq}/submit`으로 접수한다. 반환 orderSeq가 예약번호다. 동일 초안의 접수 재전송은 기존 결과를 반환한다.
6. 원본 통화의 기존 주문에 배송상세를 추가하지 않고 별도 ADMIN 주문을 만든다. HTTP 200만으로 디버 성공을 표시하지 않으며 ACCEPTED만 접수 성공이다.

필수값·결제 자격·409 VERSION_CONFLICT·멱등성·감사 실패 롤백은 기존 [055 상세 명세](parcel-draft-frontend-integration.md)를 따른다.
