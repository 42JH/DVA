# 기업 직원 JSON 등록·관리 API

모든 경로는 ACTIVE 관리자 세션을 요구하며 쓰기는 허용 Origin을 검사한다.
`ORG_ADMIN`은 대표자 표시로 관리자 계정을 만들거나 권한을 부여하지 않는다.

| 메서드·경로 | 요청 | 성공 |
| --- | --- | --- |
| GET /api/companies/{id}/members | status, limit, offset | 200, `{data, hasNext, total_count}` |
| POST /api/companies/{id}/members | 직원 단건 객체 또는 `{items:[직원,...]}` | 204, 본문 없음 |
| PATCH /api/members/{id} | role, status, departmentSeq 중 하나 이상 | 204 |
| DELETE /api/members | `{ "membershipSeqs": [1] }` | 204 |

## 등록 입력

기존 고객 연결은 기존 단건 형식을 유지한다. employeeNo, customerSeq, role은 필수다.

```json
{"employeeNo":"001A","customerSeq":123,"role":"MEMBER"}
```

프론트에서 파일을 읽었다면 사번·이름·전화번호를 JSON으로 보낸다. 서버 파일 업로드와 CSV 파싱은 제거했다.

```json
{"items":[{"employeeNo":"001A","name":"홍길동","phoneNumber":"01012345678"},{"employeeNo":"002B","name":"김직원","phoneNumber":"01098765432","departmentSeq":5}]}
```

두 형식을 한 items 배열에 섞어도 된다. 이름·전화번호 형식에서는 customerSeq와 role을 받지 않는다.
신규 구성원은 MEMBER/ACTIVE다. 같은 기업·사번이 있으면 이름·전화번호를 갱신하며 고객/소속 ID·대표자 표시·상태와 과거 주문 스냅샷은 유지한다.
기존 미소속 전화번호는 그 고객을 연결한다. 다른 기업 소속·다른 사번의 전화번호·탈퇴 고객은 거절한다.
기존 고객 번호 형식은 기존과 같이 중복 연결 시 409다. 자동 기업 이동은 없다.

items는 1~1,000건, JSON 본문 전체 최대 1MiB다. 이는 한 요청의 제한이며 누적 직원 수 제한이 아니다.
같은 요청의 사번·고객 번호·전화번호 중복, 알 수 없는 필드, 잘못된 숫자·빈 이름은 400이다.
DB 충돌은 409, 소속·전화번호 업무 충돌과 다른 기업 부서는 422다. 오류 응답에 이름·전화번호를 되돌려주지 않는다.
모든 고객·소속 변경과 성공 감사는 요청 전체를 한 트랜잭션으로 저장하거나 롤백한다. 잠금 대기 2초 초과는 409 REQUEST_IN_PROGRESS다.
기존 Idempotency-Key는 사용하지 않는다. JSON 반복 등록도 기존 사번의 고객/소속 ID를 유지한다.

## 부서·주소와 조회

departmentSeq는 선택이다. 신규 생략/null은 부서 없음이다. 기존 직원 JSON 갱신과 PATCH에서 생략하면 유지하고 null이면 연결을 해제한다.
제공한 양의 정수는 같은 기업의 실제 부서여야 한다. 부서가 없어도 기업 소속과 기업 월결제 자격은 유지한다. 부서 그룹결제는 사용할 수 없다.
부서 생성 자체를 요청하면 이름은 필수다. 부서가 없는 기업은 부서를 생성하지 않는다.

조회는 membership와 customer를 반환한다. membership.departmentSeq는 부서 없으면 null이며 customer.address는 PIN과 독립된 내 주소 또는 null이다.
목록은 membershipSeq 내림차순, limit 기본20·1~100, offset 기본0이다. status는 ACTIVE/INACTIVE다.
total_count는 같은 검색·권한·필터의 페이지 적용 전 전체 건수다. 범위를 넘는 페이지도 총건수를 유지한다.
소속 해제는 고객·개인 PIN·주문 이력을 지우지 않는다. 기업·부서 실제 삭제는 [삭제 계약](company-deletion.md)을 따른다.

`POST /api/companies/{id}/members/import`는 삭제되어 404이며 Swagger에서도 제거한다.
새 앱 실행 전에 028 migration을 적용한다. 실제 DB 적용·배포는 별도다.
