# 개인 PIN 주소록 관리 API

개인 PIN은 자주 보내는 상대나 추가 배송지를 저장하는 주소록이다. 고객 기본 이름·전화번호·주소는 고객 정보에서 읽으며 개인 PIN과 자동 동기화하지 않는다.

기업 공유 배송지는 [활성 기업 사원의 현재 고객 주소 검색](company-directory.md)으로 제공한다. 기업 PIN의 GET/POST `/api/companies/{id}/pins`, PATCH `/api/company-pins/{id}`는 폐기되어 404를 반환한다. 기존 company_pins 테이블과 과거 주문의 COMPANY 논리 참조는 보존한다.

## HTTP 계약

모든 경로는 `/api`로 시작한다. 성공·오류 모두 Cache-Control: no-store를 사용한다.

| 메서드·경로 | 권한 | 성공 응답 |
| --- | --- | --- |
| GET /api/customers/{id}/pins | 관리자 또는 현재 통화 고객 | 200, `{ data: PersonalPin[], hasNext, total_count }` |
| POST /api/customers/{id}/pins | 관리자 또는 현재 통화 고객 | 201, `{ data: { personalPinSeq, version }, meta }` |
| PATCH /api/pins/{id} | 관리자 또는 현재 통화 고객 | 200, `{ data: { version }, meta }` |

PersonalPin은 `{ personalPinSeq, customerSeq, label, addressData, version }`이다. label은 null일 수 있다. 소유 고객 변경과 PIN 단독 삭제 API는 제공하지 않는다.

q는 별칭·수령인·전화번호·도로명·지번·상세주소의 부분 검색이다. 앞뒤 공백·NFC를 정리하고 대소문자를 구분하지 않는다. `%`·`_`는 일반 문자다. 검색어가 없거나 공백이면 해당 고객의 전체 주소록을 페이지 조회한다. limit 기본 20·범위 1~100, offset 기본 0이며 PIN 번호 오름차순이다. total_count는 같은 조건의 페이지 적용 전 전체 건수다. 결과 없음은 `{ "data": [], "hasNext": false, "total_count": 0 }`다.

통화 시작 시 [고객 초기 조회](caller-context.md)의 personalPins가 본인의 개인 PIN 전체를 반환한다. 과거 주문의 주소는 PIN과 무관한 [이전 주문 주소 조회](order-address-history.md)로 읽는다.

## 인증과 범위

모든 ACTIVE 관리자 역할은 관리 기능을 사용할 수 있다. 기존 dva_session 쿠키와 쓰기 요청의 허용 Origin 검증을 유지한다.

AI 호출은 기존 MVP 계약에 따라 서비스 토큰을 요구하지 않는다. call_session_seq 헤더의 진행 중 통화 발신번호와 PIN 소유 고객의 전화번호가 같아야 하고 고객이 ACTIVE여야 한다. 다른 고객의 PIN은 같은 기업의 사원이어도 접근할 수 없다. 통화 번호는 인증 토큰이 아니며 전화번호 본인인증을 수행하지 않는다.

잘못된 관리자 쿠키를 AI 호출로 전환하지 않는다. 허용되지 않은 Origin, 종료된 통화, 탈퇴 고객의 주소록 사용은 거절한다. 관리자도 탈퇴 고객의 PIN을 사용할 수 없다. 기존 소유자·고객·통화 잠금과 감사 트랜잭션을 유지한다.

## 등록·수정

```json
{
  "label": "자주 보내는 곳",
  "addressData": {
    "name": "김수령",
    "phoneNumber": "01012345678",
    "roadAddress": "서울특별시 중구 세종대로 110",
    "jibunAddress": "서울특별시 중구 태평로1가 31",
    "detailAddress": "101호",
    "dongName": "태평로1가",
    "postalCode": "04524",
    "latitude": 37.5663,
    "longitude": 126.9779
  }
}
```

등록은 label 선택·addressData 필수다. 고객 확인이 끝난 완성 주소를 받으며 수집 중 정보는 주문에 보관한다. 이름·도로명·지번·동명은 NFC와 앞뒤 공백 정리 후 빈 문자열을 거절한다. 전화번호는 숫자 문자열, 우편번호는 숫자 5자리 문자열이다. 위도·경도는 실제 숫자와 기존 범위 검증을 적용한다. 상세주소는 생략·빈 문자열을 허용하며 null은 거절한다. 없는 필수 값을 자동 생성하지 않는다. 알 수 없는 필드·소유자 변경·결제 필드는 400이다.

등록은 Idempotency-Key를 요구하지 않으며 기존 고객별 pin_identity 고유 제약으로 동시 중복을 거절한다. 별칭·좌표는 주소 중복 판정에 포함하지 않는다. 동일 주소 재등록은 기존 PIN을 덮어쓰지 않고 409 DUPLICATE_RESOURCE다.

수정은 label·addressData 중 하나 이상이 필요하다. 생략한 필드는 유지하고 label:null은 별칭을 지운다. addressData는 전달 시 전체 교체이며 부분 주소 객체는 400이다. expectedVersion은 선택 호환값으로, 오래된 버전도 반영하며 현재 version을 반환한다. 지정 필드는 UPDATE 시점의 값과 합쳐 동시 부분 변경을 보존한다.

PIN 변경은 기존 주문에 복사된 주소나 주문 버전을 변경하지 않는다. 성공 감사와 쓰기는 같은 트랜잭션이며 실패 시 모두 롤백한다. 감사·요청 로그에 주소·전화번호·검색어를 남기지 않는다.

## 오류와 검증

입력 오류 400, 잘못된 관리자 인증 401, 다른 고객 접근 403, 없는 고객·통화·PIN 404, 중복 주소·사용 불가 상태 409를 기존 error/meta 형식으로 반환한다. DB 장애를 빈 성공으로 바꾸지 않는다.

개인 PIN 회귀 테스트는 기존 등록·검색·수정·권한·중복·동시 수정·감사 롤백·과거 주문 주소 보존을 검사한다. 폐기된 기업 PIN API의 404와 기존 DB 행 보존도 확인한다. 배포 환경·실제 통화는 [AI 인계](company-address-directory-handoff.md)의 별도 확인 대상이다.
