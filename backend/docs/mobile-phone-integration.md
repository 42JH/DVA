# 휴대전화 번호 11자리 입력 계약

신규 업무 입력의 `phoneNumber`는 하이픈·공백 없는 ASCII 숫자 문자열 정확히 11자리다. 예: `"01012345678"`. 별도 `010` 접두사 제한은 추가하지 않는다. 숫자 타입, 9·10·12자리, 하이픈, 공백, 국가번호, 줄바꿈은 400 `INVALID_REQUEST`다. 서버가 잘못된 값을 잘라내거나 0을 덧붙여 저장하지 않는다.

## AI 전달 사항

- `POST /api/customers/context`: 국내 표기로 정규화한 발신 휴대전화 번호 11자리를 전송한다.
- `POST /api/customers`와 `POST /api/orders`의 `customer.phoneNumber`, 주문 `parcels[].origin.phoneNumber`·`destination.phoneNumber`에도 같은 규칙을 적용한다.
- 주문 수집 중 출발·도착 연락처의 생략·null은 기존처럼 허용한다. 값을 전송할 때에는 11자리여야 한다. 최종 접수 시에는 출발·도착 연락처가 필수다.
- 개인 PIN 등록·수정의 `addressData.phoneNumber`도 11자리다. 통화 도중 고객 전화번호를 수정하는 기능은 추가하지 않는다.
- PBX 종료 웹훅과 주문 `call.callerPhoneNumber`는 기존 원문 수신·국제번호 정규화 계약을 유지한다. 업무 연락처 입력 필드와 구분한다.

## 프론트 전달 사항

| API | 적용 필드 |
| --- | --- |
| `POST /api/customers` | `phoneNumber` |
| `GET /api/customers` | 정확히 일치 검색 `phoneNumber` |
| `POST /api/companies` | `members[].phoneNumber` |
| `POST /api/companies/{id}/members` | 이름·전화번호 방식의 `phoneNumber` 또는 `items[].phoneNumber` |
| `POST /api/customers/{id}/pins`, `PATCH /api/pins/{id}` | `addressData.phoneNumber` |
| `POST /api/orders`, `POST /api/admin/orders`, `PATCH /api/orders/{id}` | 고객 입력 및 출발·도착 연락처 |

- 폼 검증은 기존 10~11자리 허용을 정확히 11자리로 변경한다. 전송할 때 문자열을 유지한다.
- 고객 목록의 `phoneNumber`는 완성 번호 필터다. 10자리 부분 번호는 빈 목록 대신 400을 반환한다. 별도 `q` 부분 검색 계약은 유지한다.
- 기존 저장 데이터와 조회 응답은 일괄 변경하지 않는다. 기존 주문의 연락처가 11자리가 아니라면 최종 접수 시 422 `VALIDATION_FAILED`, 상세 `field=parcels.{index}.{origin|destination}.phoneNumber`, `reason=mobilePhone`을 반환한다. 번호를 바로잡은 뒤 접수한다.
- 새 API·DB 컬럼·migration은 없다. Swagger의 요청 스키마도 같은 11자리 패턴을 사용한다. 실제 운영 적용은 코드 배포 후다.
