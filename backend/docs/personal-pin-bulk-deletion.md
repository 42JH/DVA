# 관리자 개인 주소록 단건·다건 soft delete

`DELETE /api/pins`는 모든 ACTIVE 관리자 세션과 허용 Origin 전용이다. call_session_seq는 필요하지 않으며 AI 통화 헤더·서비스 토큰으로는 사용할 수 없다.

```json
{ "personalPinSeqs": [123, 124] }
```

배열은 서로 다른 양의 int32 개인 PIN ID 1~100개다. 단건은 한 개 배열로 보낸다. 여러 고객의 PIN을 함께 선택할 수 있다. 빈 배열·중복·문자열·0·음수·소수·범위 초과·미지정·다른 필드는 400이며 Content-Type은 application/json이다.

개인 PIN의 deleted_at만 설정한다. 고객 기본 주소(address_data), 고객·소속·통화, 주문에 복사된 과거 주소·PIN 참조는 보존한다. 삭제된 PIN은 기존 주소록 목록·검색·고객 확인에서 제외된다. 삭제된 동일 주소를 다시 등록하면 기존 활성 주소 중복 제약에 따라 새 PIN을 생성할 수 있다.

미존재·기삭제 PIN이 하나라도 있으면 404 NOT_FOUND로 전체 롤백한다. 감사 저장 실패도 전체 롤백한다. 성공은 본문 없는 204이며 대상별 PERSONAL_PIN_DELETED 성공 감사를 같은 트랜잭션에 저장한다. 기존 쓰기와 같은 고객 우선 잠금을 ID 순서로 취하며 잠금 대기 2초 초과·데드락은 409 REQUEST_IN_PROGRESS다. 기삭제 재요청으로 삭제 시각을 갱신하지 않는다.

추가 migration·환경변수는 없다. 실제 폐기는 기존 deleted_at 기준 5년 보관 정책을 따른다. 기업 공용 PIN은 폐기된 기능이므로 이 API 대상에 포함하지 않는다.
