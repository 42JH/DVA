# 주소 위도·경도 제거

고객·사원·PIN·주문의 주소에서 `latitude`와 `longitude`를 제거한다. 선택값이나 기본값으로 남기지 않으며 디버 접수 요청에도 보내지 않는다. 새 앱 실행 전에 `043-remove-address-coordinates.sql`을 적용한다.

## API 계약

| 대상 | 변경 |
| --- | --- |
| 고객 등록·수정 | `address`는 도로명·지번·동·5자리 우편번호 필수, 상세주소 선택. 좌표 없음 |
| 기업과 사원 동시 등록·기존 기업의 사원 등록 | 고객과 같은 주소 DTO 사용. 좌표 기본값 `1`과 전용 DTO 삭제 |
| 개인 PIN 등록·수정 | `addressData`는 위 주소 필드와 수령인 이름·숫자 전화번호. 좌표 없음 |
| AI 주문·관리자 주문 생성·수정·수기 접수 | `parcels[].origin`·`destination`에서 좌표 제거. 수집 중 부분 주소 허용은 유지 |
| 고객·사원·통화 고객 확인·기업 공유 주소·PIN·주문 상세·과거 주문 주소 조회 | 반환 주소에서도 좌표 제거 |
| 최종 접수·결제 후 디버 자동 접수·접수 재시도 | 좌표 없는 출발·도착 주소를 검증하고 전송. 디버의 선택 좌표는 생략 |

일반 주문 주소는 `name`, `phoneNumber`, `roadAddress`, `jibunAddress`, `detailAddress`, `dongName`, `postalCode`의 7개 필드다. 완료 시 상세주소를 제외한 값이 필요하다. 고객 내 주소에는 이름·전화번호를 중복 저장하지 않는다.

엄격한 기존 입력 검증에 따라 `latitude`·`longitude`를 보내면 숫자·문자열·null 모두 **400 INVALID_REQUEST**다. 프론트와 AI는 필드를 완전히 제거해야 한다. 주소의 다른 필수값·물품·요금·결제·PIN 소유권 검증은 유지한다. Swagger 요청·응답에도 두 필드를 노출하지 않는다.

## DB 전환

새 migration 043만 추가하며 적용된 과거 migration 파일과 체크섬은 보존한다.

- `order_parcels`의 `origin_latitude`, `origin_longitude`, `destination_latitude`, `destination_longitude`와 해당 CHECK를 삭제한다.
- `customers.address_data`, `personal_pins.address_data`, `company_pins.address_data`에서 두 JSON 키를 제거한다. 미설정 SQL NULL은 유지한다.
- 주소 검증 함수와 CHECK를 새 형식으로 교체·재검증한다. 이후 DB 직접 쓰기도 좌표가 포함된 주소를 거절한다.
- PIN의 버전·소유자·중복 판정·검색 내용, 주문 버전·시각·상태·금액·나머지 주소·취소 상세는 보존한다. 좌표 정리 동안 PIN 버전 트리거 두 개만 잠시 정지하고 같은 트랜잭션에서 복구한다.
- 실패 시 JSON 수정·컬럼 삭제·함수·CHECK·트리거 상태가 함께 롤백된다.

좌표가 있던 기존 행은 해당 값이 삭제된다. 원본 복구에는 적용 전 백업이 필요하다. 관련 네 테이블의 배타 잠금과 최대 60초 SQL 제한을 사용하므로 운영 데이터 규모에서의 소요 시간은 별도로 확인한다.

## 적용과 범위 제한

사용자가 허용한 수정 범위는 `backend/`다. 폴더 밖 `docs/api/*`, `docs/database/monolith.dbml`, `infra/database/verify.sql`, `infra/deploy/*`는 이번 변경에서 수정하지 않는다. 좌표에 관한 과거 외부 문서보다 이 계약과 새 Swagger를 우선한다. 운영 DB 적용·앱 배포·AI·프론트 수정도 별도다.

배포할 때는 **기존 백엔드·워커 중지 → 백업 → 043까지 runner 적용·검증 → 새 앱 실행** 순서를 지킨다. 043 이후에는 좌표 컬럼을 조회하고 좌표가 있는 JSON을 쓰는 구버전 앱으로 이미지 단독 복귀할 수 없다. 폴더 밖 배포 스크립트에는 043 전용 중지·백업·구버전 복귀 차단이 추가되지 않았으므로 기존 자동 보호에 의존해 전환하지 않는다. 해당 보호와 외부 ERD·API 문서를 반영한 뒤 배포하거나, 점검 중 수동 절차를 별도로 수행해야 한다.
