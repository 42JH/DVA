# 기업 공유 배송지 관리자 조회

## 프론트 요청

기존 `GET /api/companies/search`에 관리자 세션 인증을 추가한다. 새 API나 브라우저용 AI 토큰을 만들지 않는다.

```javascript
const query = new URLSearchParams({ q: '예시기업 김사원', limit: '20', offset: '0' });
const response = await fetch(`/api/companies/search?${query}`, { credentials: 'include' });
```

OPERATOR·SUPERVISOR·SYSTEM_ADMIN의 ACTIVE 관리자 세션을 허용한다. `q`는 기존처럼 필수 1~100자이며
기업명·부서명·사원 이름·전화번호·주소를 검색한다. `limit`은 1~100, `offset`은 0 이상이다.
응답은 기존 `{ data, hasNext, total_count }`이고 `data[].addressData`에 현재 이름·전화번호·주소가 들어 있다.
기업·소속·고객이 ACTIVE이고 기본 주소가 있는 사원만 반환한다. 특정 관리자 기업으로 범위를 제한하지 않는다.
주소 없는 사원·사번 검색은 기존 `/api/companies/members/search`를 사용한다.

## AI 요청과 인증 우선순위

AI 서버는 기존 `Authorization: Bearer <AI_BUSINESS_TOKEN>`을 유지한다. 경로·쿼리·응답은 바뀌지 않는다.
`call_session_seq`는 필요 없다. 요청별 인증은 기존 공용 업무 API와 같은 규칙을 사용한다.

| 요청 | 처리 |
| --- | --- |
| 유효한 관리자 세션 | 관리자 조회 허용. AI 토큰 설정·헤더 불필요 |
| 유효한 관리자 세션 + Bearer | 세션을 우선 검증 |
| 잘못된·만료·중복 관리자 세션 + 유효한 Bearer | 401. AI 인증으로 우회하지 않음 |
| 세션 없음 + 유효한 AI Bearer | 기존 AI 조회 허용 |
| 세션 없음 + 토큰 누락·오류·중복 Authorization | 401 |
| 세션 없음 + 서버 AI 토큰 미설정 | 503 |

기존 공통 CORS·no-store·입력 검증과 다른 기업 관리 API의 관리자 전용 권한은 유지한다.
데이터·DB migration·환경변수 변경은 없다. 프론트·AI 코드와 운영 배포·MSA 고정 기준은 이번 변경에 포함하지 않는다.

## 검증

변경 전 인증 테스트에서 관리자 세션이 401로 거절되는 것을 확인한 뒤 기존 공용 인증 데코레이터를 재사용했다.
2026-11-10 `BACKEND_TEST_PROFILE=orders+companies node backend/scripts/check.cjs`를 실행해
단위 215개·결제 모듈 21개·격리 PostgreSQL HTTP 통합 422개·운영 이미지/Nginx/HTTPS 13개,
총 671개를 통과했다. 실패·skip·취소는 0이며 컴파일·lint·format도 통과했다. 총 실행 시간은 약 173초다.
관리자 3개 역할과 AI의 응답 일치, 토큰 미설정 중 관리자 조회, 잘못된·중복 세션의 Bearer 우회 차단,
기존 AI 토큰 검증·CORS·삭제/비활성 주소 제외·사원 검색과 주문 그룹 변경을 회귀 검증했다.
운영 서버 배포·실제 프론트/AI 서버 연동과 MSA 반영은 수행하지 않았다.
