# DELETE 배열 통합 — AI팀 전달 명세

적용 대상: 모놀리식 백엔드 MR !560. **백엔드 배포 시점에 맞춰 전환**합니다. AI가 사용할 수 있는 DELETE 중 변경된 API는 아래 **카드 등록 해제 2개**입니다. 카드 조회·등록·주문 확정·취소 API와 인증 방식은 유지합니다.

| 용도 | 기존 DELETE — 제거됨 | 변경 후 DELETE | JSON 본문 |
| --- | --- | --- | --- |
| 개인 카드 등록 해제 | `/api/customers/{id}/card` | `/api/customers/cards` | `{ "customerSeqs": [50] }` |
| 기업 카드 등록 해제 | `/api/companies/{id}/group-card` | `/api/companies/group-cards` | `{ "organizationSeqs": [10] }` |

배열에는 **카드 번호/paymentCardSeq가 아닌 소유 고객·기업의 번호**를 넣습니다. 단건도 한 원소 배열로 보냅니다. 기존 DELETE URL은 배포 후 404이며 같은 단건 URL의 GET·PUT은 유지합니다.

## 요청 예시

아래 예시의 번호는 실제 통화·고객·기업 번호로 바꿉니다. `AI_BUSINESS_TOKEN`은 기존 업무용 서비스 토큰입니다.

```http
DELETE /api/customers/cards
Authorization: Bearer <AI_BUSINESS_TOKEN>
Content-Type: application/json
call_session_seq: <진행 중인 통화 번호>

{ "customerSeqs": [50] }
```

```http
DELETE /api/companies/group-cards
Authorization: Bearer <AI_BUSINESS_TOKEN>
Content-Type: application/json
call_session_seq: <진행 중인 통화 번호>

{ "organizationSeqs": [10] }
```

- AI 호출은 관리자 세션 쿠키 없이 보냅니다. 유효하지 않은 `dva_session` 쿠키를 함께 보내면 Bearer로 대체 인증하지 않습니다. Bearer 경로에는 관리자용 Origin이 필요하지 않습니다.
- `call_session_seq`는 필수이며, 존재하는 **종료 전 통화**여야 합니다. 개인 카드는 통화 고객 본인, 기업 카드는 통화 고객이 소속된 기업만 해제할 수 있습니다. 기존 범위를 다건 요청으로 확대하지 않습니다.
- 배열은 1~100개의 중복 없는 양의 int32 정수(1~2147483647)입니다. 문자열 숫자·빈 배열·중복·추가 필드는 400입니다.
- 배열의 **모든 소유자**를 검사합니다. 다른 고객·기업을 섞으면 전체 실패하며, 일부만 해제되지 않습니다.
- 성공은 **204 No Content**입니다. 응답 본문을 JSON으로 파싱하지 않습니다. DELETE에는 카드 등록용 `Idempotency-Key`가 필요하지 않습니다.
- 활성 소유자가 존재하고 해제할 카드가 이미 없으면 204입니다. 없는 소유자/통화는 404, 비활성 소유자/종료된 통화는 409, 인증 실패는 401, 통화 고객 범위 위반은 403입니다. 업무 토큰 미설정은 503입니다.
- 해제는 기존 soft delete 및 후속 PG 키 해제 워커를 사용합니다. 기존 결제의 취소·환불 API가 아닙니다.

고객·주소록·주문·통화·초안 등 나머지 DELETE는 관리자 세션용입니다. 이번 변경으로 AI Bearer 권한을 추가하지 않았으므로 AI에 전체 DELETE 전환을 요구하지 않습니다. 새 토큰·환경변수·DB migration은 없습니다.

전체 관리자 DELETE 변경은 [프론트 전달 명세](delete-array-contracts.md)를 참고합니다. 이 문서는 구현·기존 PostgreSQL/HTTP 회귀 검증을 기준으로 작성했으며, 운영 배포 및 실제 PG 카드 해제는 확인하지 않았습니다.
