# 기업 삭제 API 통합 — 프론트 전달

전체 DELETE의 최신 경로·배열 필드·권한은 [통합 명세](delete-array-contracts.md)를 우선합니다. 아래는 기업 삭제 부분의 상세 전환 안내입니다.

기업 삭제는 `DELETE /api/companies` 하나만 사용합니다. 단건도 배열로 보냅니다.

```http
DELETE /api/companies
Content-Type: application/json
```

```json
{ "organizationSeqs": [123] }
```

다건은 `[123, 124]`처럼 전달합니다. 중복 없는 양의 int32 번호 1~100개, 기존 활성 관리자 세션·허용 Origin, 성공 204와 빈 본문을 유지합니다. soft delete·연관 소속/부서 정리·과거 기록 보존·감사·전체 롤백은 기존 배열 API와 같습니다. 새 환경변수·migration은 없습니다.

`DELETE /api/companies/{id}`는 제거되어 404입니다. 같은 경로의 GET 상세·PATCH 수정과 부서 삭제·기업 카드 해제는 유지합니다.

## 현재 프론트 사용과 수정 위치

원격 `develop-fe`의 `511ac245` 기준으로 기업 상세 삭제 버튼이 이 구형 API를 사용합니다.

- `frontend/src/features/company/api/companyApi.ts:201`의 `deleteCompany(id)`가 구형 URL을 호출합니다.
- `frontend/src/features/company/hooks/useCompanyDetail.ts:212`에서 이 함수를 호출하고 `CompanyPage.tsx`의 삭제 확인 버튼과 연결합니다.
- 공통 `api.delete(path, { body })`가 JSON 본문을 지원하므로, 기존 함수 이름·반환값과 화면의 호출 방식은 유지하고 다음처럼 요청만 바꾸면 됩니다.

```ts
export const deleteCompany = (id: number): Promise<void> =>
  api.delete('/companies', { body: { organizationSeqs: [id] } })
```

프론트 MSW에는 배열 DELETE mock이 이미 있으므로 전환한 호출은 그 경로로 검증할 수 있고, 사용하지 않는 단건 mock은 함께 제거하면 됩니다. 이번 백엔드 MR에서는 프론트 코드를 수정하지 않았습니다. **배포 전에 프론트 호출을 전환해야 하며, 기존 프론트에 백엔드만 먼저 배포하면 기업 상세의 삭제가 404로 실패합니다.** 위 사용 여부는 원격 소스 확인이며 현재 배포된 프론트의 실행 검증은 아닙니다.
