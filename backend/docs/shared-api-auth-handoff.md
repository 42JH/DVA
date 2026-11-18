# 공용 API 12개 인증 전환 — AI·프론트 전달 명세

2026-11-09. 이번 변경은 아래 12개 API의 인증에만 적용한다. URL·업무 요청 본문·성공 응답·관리자 권한·통화/고객 범위·구형 통화 호환 조건은 유지한다. DB migration과 신규 환경변수는 없다.

## 적용 API

| 메서드 | URL | AI가 추가할 헤더 |
|---|---|---|
| GET | /api/orders | Authorization + 기존 call_session_seq |
| POST | /api/orders | Authorization. 기존 call 본문·Idempotency-Key·선택 통화 헤더 유지 |
| GET | /api/orders/{id} | Authorization + 기존 call_session_seq |
| PATCH | /api/orders/{id} | Authorization + 기존 call_session_seq |
| POST | /api/orders/{id}/cancel | Authorization + 기존 call_session_seq |
| POST | /api/orders/{id}/parcels/cancel | Authorization + 기존 call_session_seq |
| POST | /api/orders/{id}/submit | Authorization + 기존 call_session_seq |
| GET | /api/customers/{id}/addresses | Authorization + 기존 call_session_seq |
| GET | /api/customers/{id}/pins | Authorization + 기존 call_session_seq |
| POST | /api/customers/{id}/pins | Authorization + 기존 call_session_seq |
| PATCH | /api/pins/{id} | Authorization + 기존 call_session_seq |
| GET | /api/ai/faqs | Authorization. 통화 헤더 불필요 |

## AI 담당자가 변경할 곳

위 URL을 호출하는 백엔드 업무 API 클라이언트에서 다음 헤더를 추가한다. 이미 고객 확인·배송 초안에 쓰는 **기존 AI_BUSINESS_TOKEN**을 재사용한다. FAQ 최초 동기화·변경 후 재조회·주기적 조회에도 적용한다.

원격 develop-ai `03601c6b`에서 확인한 실제 수정 위치는 **ai/backend_client/api.py의 BackendAPI**다. ai/app/backend_api.py는 이 클래스를 다시 내보내므로 동일 구현을 별도로 추가하지 않는다.

| 메서드 | 헤더 변경 |
|---|---|
| create_pin, address_history, find_parcels, order_detail, cancel_parcels | 기존 `headers=_call(call_session_seq)`를 `headers=_call(call_session_seq) \| self._business_headers()`로 변경 |
| submit_result | 기존 Idempotency-Key 헤더에 `self._business_headers()` 병합. 재시도에도 동일하게 전송 |
| initial_faq_entries, faq_entries | 직접 생성하는 httpx2.Request의 Accept 헤더에 `self._business_headers()` 병합 |

위 클래스에 기존 business_token과 _business_headers()가 이미 있다. 새 토큰 생성이나 전용 HTTP 클라이언트 추가 대신 이를 재사용한다. 다른 파일에서 위 표의 API를 직접 호출하는 경우도 같은 헤더를 적용한다. 페르소나·통화 분석의 전용 토큰을 공통 기본 헤더로 덮어쓰지 않는다.

```http
Authorization: Bearer <AI_BUSINESS_TOKEN 값>
```

BE와 AI 서버의 비밀 환경변수에 동일한 AI_BUSINESS_TOKEN 값이 있어야 한다. 값에 Bearer 접두사를 저장하지 않는다. 키를 코드·Git·로그·프롬프트·프론트 환경변수에 넣지 않는다. 기존 AI_PERSONA_TOKEN·AI_INSIGHTS_TOKEN·AI_FAQ_TOKEN·PBX_WEBHOOK_TOKEN을 이 값으로 교체하지 않는다. AI_FAQ_TOKEN은 BE→AI 변경 알림용이며 AI→BE FAQ 조회에는 AI_BUSINESS_TOKEN을 사용한다.

```python
import os

headers = {
    "Authorization": f"Bearer {os.environ['AI_BUSINESS_TOKEN']}",
    "call_session_seq": str(call_session_seq),
}
response = await client.get(f"{backend_url}/api/orders", headers=headers)

# FAQ 조회는 통화번호 없이 같은 업무 토큰만 전송한다.
response = await client.get(
    f"{backend_url}/api/ai/faqs",
    headers={"Authorization": f"Bearer {os.environ['AI_BUSINESS_TOKEN']}"},
)
```

통화번호는 인증 토큰을 대체하지 않는다. Bearer 인증을 통과해도 기존 통화·고객·보관·상태 조건을 충족해야 한다. 신규 AI 통화에서 기존 주문 생성/수정/취소/최종 접수 쓰기를 거절하는 조건도 유지하며, 배송 초안 → order-intake/complete 흐름을 계속 사용한다.

## 프론트 담당자가 확인할 곳

관리자 호출은 기존 로그인으로 발급받은 dva_session 쿠키를 계속 전송한다. **AI Bearer 키를 추가하지 않는다.** 관리자 권한과 쓰기 요청의 허용 Origin 검사는 유지한다.

- fetch 공통 API 클라이언트: 기존 쿠키 전송을 유지한다. API와 웹의 origin이 다른 구성이면 `credentials: 'include'`를 사용한다.
- Axios 공통 API 클라이언트: 같은 구성에서 `withCredentials: true`를 유지한다.
- URL·요청 본문·응답 타입·성공 후 화면 처리는 변경하지 않는다. 기존 쿠키 전송이 정상이라면 추가 코드 수정은 없다.
- Swagger 인증 표시는 관리자 세션 **또는** Bearer다. 둘을 동시에 요구하지 않는다. 브라우저가 실제 관리자 쿠키를 보내야 세션으로 인증된다.

관리자 쿠키가 있으면 세션 검증을 우선한다. 잘못되거나 만료·중복된 관리자 쿠키는 유효한 AI Bearer가 함께 있어도 관리자 인증 실패로 거절한다. 정상 관리자 세션은 AI 토큰 누락·오류·서버의 AI 키 미설정과 무관하게 허용한다.

## 오류와 반영 순서

| 조건 | 응답 |
|---|---|
| 정상 관리자 세션 | 기존 권한·업무 검사 및 성공 응답 유지 |
| 관리자 쿠키 없음 + 정상 AI Bearer | 기존 AI 통화·고객·업무 검사 및 성공 응답 유지 |
| 관리자 쿠키 없음 + Bearer 누락·오류·중복(서버 키 설정됨) | 401 UNAUTHORIZED |
| 잘못되거나 만료·중복된 관리자 쿠키 | 401 UNAUTHORIZED. 쓰기는 기존 Origin 검사도 적용 |
| AI 호출인데 BE의 AI_BUSINESS_TOKEN 미설정 | 503 DEPENDENCY_UNAVAILABLE |
| 관리자 쓰기에서 Origin 누락·미허용 | 403 FORBIDDEN |

1. BE·AI에 기존 AI_BUSINESS_TOKEN이 동일하게 설정되어 있는지 값을 노출하지 않고 확인한다.
2. AI 클라이언트가 위 12개 호출에 Bearer를 추가하도록 먼저 반영한다. 기존 백엔드도 추가 헤더를 받을 수 있다.
3. 백엔드를 배포해 인증을 필수화한다. 먼저 백엔드만 전환하면 기존 무토큰 AI 요청은 401이 된다.
4. 관리자 세션만 사용한 주문·PIN·FAQ 조회/쓰기와 AI 토큰 호출을 각각 확인한다. 401·503을 업무 실패로 무한 재시도하지 않는다.

AI·프론트 소스 수정이나 실제 메시지 발송·운영 배포는 이 백엔드 작업에 포함하지 않는다. 본 문서를 각 담당자에게 전달한다. 페르소나·분석·PBX 전용 인증과 공개 로그인·가입·로그아웃·헬스체크·결제 링크 경로는 이번 전환 대상이 아니다.

## 백엔드 검증

`BACKEND_TEST_PROFILE=full node backend/scripts/check.cjs` 종료 코드 0. 로컬 전체 912개(단위 215·결제 모듈 21·격리 PostgreSQL/HTTP 663·운영 이미지/Nginx/HTTPS 13)가 통과했으며 실패·건너뜀 0개다. 빌드·ESLint·Prettier도 통과했다. 실행 시간은 211,371ms(약 3분 31초)이며 Jenkins 측정값은 아니다.

12개 전부의 무토큰·오류/중복 토큰 차단, 잘못된 관리자 쿠키의 AI 토큰 우회 차단, Swagger OR 계약, 기존 업무 데이터 보존을 확인했다. AI 키가 비어 있어도 관리자 3개 역할이 쿠키만으로 인증되고, 관리자 쓰기는 기존 Origin 검사를 유지한다. 정상 토큰을 추가한 기존 주문·결제·주소·PIN·FAQ 회귀도 확인했다. 실제 AI·프론트 코드 반영과 운영 배포는 별도다.
