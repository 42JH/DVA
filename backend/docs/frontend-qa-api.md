# 프론트 QA 반영 API — S15P31D109-174

backend 모놀리식의 관리자 세션을 사용한다. 쓰기에는 기존 허용 Origin이 필요하다. 기존 삭제·5년 보관·역할 기준을 유지한다. 프론트·AI·MSA·운영 배포는 별도다.

## 1. 주문 탭 건수

`GET /api/admin/orders`의 기존 `data`, `hasNext`, `total_count`를 유지하고 `statusCounts`를 추가한다. 검색 `q`, 생성 기간 `from`(포함)·`to`(미포함), 현재 소속 `organizationSeq`는 집계에도 적용한다. 선택한 `statusGroup`, `limit`, `offset`은 탭별 건수에 적용하지 않는다. 목록과 모든 건수는 같은 읽기 전용 DB 스냅샷에서 조회한다.

| statusCounts 필드 | 대상 |
| --- | --- |
| all | 조회 가능한 실제 주문 전체. 이관 원본 중복 제외 |
| incomplete | INCOMPLETE 배송 초안. 원본 주문·고객·통화 삭제와 독립적인 초안 보관 기준 적용 |
| notPaid | 결제 대기 주문 |
| paid | PAID·SUBMITTING·ACCEPTED 주문 |
| submissionFailed | SUBMITTING_FAILED·SUBMISSION_FAILED 주문 |
| cancelled | CANCELLED 주문 |

`all`은 실제 주문 수이고 `incomplete`는 배송 단건 초안 수이므로 두 값을 더하거나 탭 건수의 합을 전체 주문 수로 해석하지 않는다. 미완료 탭은 `GET /api/parcel-drafts?status=INCOMPLETE`로 이동한다. 이전 `statusGroup=COLLECTING` 요청의 기존 부분 주문 조회와 `total_count` 의미도 유지한다.

초안 목록에도 같은 `from`·`to`·`organizationSeq` 필터를 추가했다. 날짜는 초안 생성 시각 기준이며 시간대가 필요하다. 검색은 NFC·앞뒤 공백 제거 후 최대 200자이며 전화번호의 하이픈을 허용한다. 기존 AI 통화/고객 범위 검사는 유지한다. 미완료 숫자에서 이동할 때 같은 검색·기간·기업 조건을 전달한다.

빈 결과는 모든 집계가 0이다. 페이지 범위를 벗어나 `data=[]`여도 건수는 유지한다. 기존 프론트가 새 필드를 사용하지 않아도 기존 목록은 동일하게 조회할 수 있다.

### 1단계 검증

2026-11-08 격리 PostgreSQL 17·전체 migration 적용 환경에서 신규 집계 5개와 기존 주문·현재 기업 소속·초안 경로를 포함한 HTTP 통합 테스트 131개가 통과했다. 상태 그룹·페이지 범위·검색·기간·기업 조건, 이관 중복·삭제·보관 만료 제외, 별도 연결의 동시 추가 시 스냅샷 일치, 관리자 역할·AI 거절·Swagger 계약을 확인했다. Docker checks의 컴파일·lint·format과 단위 테스트 194개·결제 모듈 21개도 통과했다. 운영 DB·배포·프론트 화면은 검증 대상이 아니다.
