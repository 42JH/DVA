# 페르소나 분류 삭제 — 프론트 연동 명세

관리자 권한은 SYSTEM_ADMIN·OPERATOR 두 개이며 계정 관리 4개만 최상위 전용입니다. DELETE와 권한의 최신 통합 계약은 [프론트 전달 명세](frontend-delete-admin-roles.md)를 우선합니다.

모놀리식 서버 기준. 기존 생성·수정·조회·publish API와 AI 전송 형식은 유지합니다.

## 요청

`DELETE /api/personas`

- 기존 로그인 세션 쿠키(`credentials: 'include'`)를 사용합니다.
- 기존 페르소나 쓰기 권한인 **활성 OPERATOR·SYSTEM_ADMIN**에게 허용합니다. OPERATOR와 AI Bearer만으로는 삭제할 수 없습니다.
- `Content-Type: application/json`. 변경 요청에는 기존과 같이 허용된 Origin이 필요합니다. 브라우저가 자동으로 전송합니다.
- `aiPersonaSeqs`: **분류 번호** 배열, 1~100개, 중복 없는 양의 정수(int32). 버전 번호를 보내지 않습니다.

단건과 다건 모두 같은 API를 호출합니다.

```json
{ "aiPersonaSeqs": [3] }
```

```json
{ "aiPersonaSeqs": [3, 8, 11] }
```

```ts
const response = await fetch('/api/personas', {
  method: 'DELETE',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ aiPersonaSeqs: selectedIds }),
});
if (response.status === 204) {
  // 성공 응답에는 본문이 없습니다. response.json()을 호출하지 않습니다.
  // 선택 상태를 비우고 기존 목록 API를 다시 조회합니다.
}
```

## 삭제 기준과 화면 처리

- **현재 AI가 사용하는 ACTIVE 버전이 하나라도 있는 분류는 삭제할 수 없습니다.** HEAD가 INACTIVE여도 과거 버전이 ACTIVE이면 보호합니다.
- 기존 목록·상세의 `activeVersion !== null`인 분류는 삭제 버튼과 다건 선택을 비활성화합니다. 동시 적용으로 상태가 바뀔 수 있어 서버도 다시 검사합니다.
- 대표 분류를 지우려면 다른 분류를 publish하고 **AI 적용 회신으로 ACTIVE 전환이 완료된 뒤** 요청합니다. publish 요청의 202 PENDING만으로는 기존 대표 분류를 삭제할 수 없습니다.
- 삭제하면 분류와 **소속 전체 버전·초안**을 같은 트랜잭션에서 soft delete합니다. PENDING이 있으면 취소합니다. 한 항목이라도 실패하면 아무 항목도 삭제하지 않습니다.
- 삭제된 분류는 기존 목록·건수에서 제외됩니다. 상세·버전 이력·편집·확정·publish는 404가 됩니다. 복원·코드 재사용 API는 제공하지 않습니다.
- 과거 통화의 페르소나 이름·버전과 참조는 보존합니다. 통화·분석 데이터는 삭제하지 않습니다.

## 응답

| HTTP | error.code | 의미·처리 |
| --- | --- | --- |
| 204 | 없음 | 전체 삭제 성공. 본문 없음. 목록 재조회 |
| 400 | INVALID_REQUEST | 빈 배열, 100개 초과, 중복, 문자열·잘못된 번호 등 |
| 401 | UNAUTHORIZED | 로그인 필요 |
| 403 | FORBIDDEN | 권한 또는 Origin 오류 |
| 404 | NOT_FOUND | 없는 분류 또는 이미 삭제된 분류 포함. 전체 미삭제, 목록 재조회 |
| 409 | INVALID_STATE | ACTIVE 버전이 있는 분류 포함. 전체 미삭제, 최신 목록 재조회 |
| 500 | INTERNAL_ERROR | DB·감사 기록 실패 등. 삭제·성공 감사 기록 전체 롤백 |

오류 본문은 기존 `{ error: { code, message }, meta: { requestId } }` 형식입니다.

## 배포·AI 영향

- 신규 환경변수나 AI 요청 변경은 없습니다. 기존 AI ACTIVE 설정은 계속 유지됩니다.
- 새 앱 실행 전에 `065-persona-soft-delete.sql`을 적용합니다. 기존 데이터는 모두 유지하고 nullable `deleted_at` 3개와 삭제 버전의 INACTIVE 제약만 추가합니다.
- 삭제·적용 요청은 기존 공통 잠금으로 직렬화합니다. 삭제된 PENDING에 대한 늦은 적용 회신은 409이며 재활성화하지 않습니다. 진행 중·과거 통화 분석의 기존 버전 참조는 계속 수신할 수 있습니다.
- 배포 스크립트는 새 이미지의 환경변수를 먼저 검사하고, 최초 065 전환 시 기존 앱 중지·백업·이관을 수행합니다. 065 적용 후 삭제 필터가 없는 구형 앱으로 자동·수동 롤백하지 못하게 차단합니다. 실패 시 호환 앱으로 전진 복구하거나 점검 시간에 백업 복구가 필요합니다.
