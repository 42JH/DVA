# BE 통신 규약

재구성할 AI 서버는 백엔드(BE)의 현재 구조를 그대로 쓴다. **BE에 변경을 요구하지 않는다.** 계약이 어긋나면 AI 쪽이 맞춘다.

- `backend/`: BE 원문이다. `origin/develop-backend` a629c60(2026-11-03 10:28)의 `docs/api/`와 `backend/docs/`에서 AI가 쓰는 것만 복사했다.
  - 문서끼리의 링크는 같은 폴더를 가리키게 고쳤다.
  - 관리자·프론트 전용 문서(calls, manual-orders, unanswered-questions 관리·조회 등)는 복사하지 않아서, 그 문서를 가리키는 링크는 열리지 않는다.
- `ai/`: AI 쪽에서 위 계약을 어떻게 쓰는지 적은 문서다. `S15P31D109/ai`의 `spec/`·`docs/`에서 복사했다. 구현 경로는 원래 저장소 기준(`app/...`)이다.

## 문서가 서로 다를 때

1. `backend/` 안에서는 날짜가 늦은 `backend/docs` 문서가 이긴다.
   - `address-coordinates-removal.md`: `docs/api/*`의 위도·경도 예시는 낡은 것이다. 좌표를 보내면 400이다.
   - `meaningful-call-registration-handoff.md`: 고객 확인을 두 단계로 호출한다.
   - `empty-ai-order-results.md`: 주문 정보가 없으면 통화 결과를 보내지 않는다.
   - `persona-read-payment-null-handoff.md`: 결제수단을 모르면 필드를 생략한다(null을 보내면 400).
2. `ai/` 문서와 `backend/` 원문이 다르면 원문이 이긴다. 예외는 수거 시각뿐이다(AI 팀 결정, `ai/backend-api.md` 4번).

## AI가 부르는 API와 근거 문서

| 호출 | 근거 | rebuild 구현 |
|---|---|---|
| `POST /api/customers/context` (call 없이 조회 → 업무 의도 확인 후 call 붙여 등록) | caller-context, meaningful-call-registration-handoff | `BackendAPI.caller_context(phone, call=None)`. 두 번 부르는 순서는 새 서버가 지킨다 |
| `POST /api/customers` | customers | `create_customer` |
| `POST /api/customers/{id}/pins` | pins | `create_pin` |
| `GET /api/customers/addresses` (이전 주문 출발·도착지) | order-address-history | `address_history` |
| `GET /api/companies/search` | company-directory, company-address-directory-handoff | `search_company_places` |
| `GET /api/orders`, `GET /api/orders/{id}` | order-read | `find_parcels`, `order_detail`, `parcel` |
| `POST /api/orders/{id}/parcels/cancel` | order-cancel | `cancel_parcels` |
| `POST /api/orders` (통화 결과 한 번, Idempotency-Key) | ai-order-billing-integration, order-submit, orders, order-billing, ai-pbx-recordings, empty-ai-order-results | `submit_result`, `result_body` |
| `POST /api/ai/calls/{id}/events`, `/analysis` | call-events, call-analysis, `ai/insights.md` | `send_call_events`, `send_call_analysis` |
| `GET /api/ai/config`, `POST /api/ai/config/apply-result` | ai-persona-next-call, persona-head-management | `persona_config`, `persona_result` |
| `GET /api/ai/faqs` + BE→AI `POST /internal/faqs/refresh` | ai-faq-integration, faqs, `ai/faq-sync.md` | `faq_entries`·`initial_faq_entries`, `app/webhooks/faqs.py`(원본 RAG) |
| `POST /api/ai/unanswered-questions` | unanswered-questions | **없음.** 원래 AI 코드에도 없다. 쓰려면 클라이언트에 추가한다 |
| `PATCH` 주문 수정(COLLECTING만) | order-update | 없음(원래 AI에서도 수정 보류) |
| PBX 종료 웹훅(BE와 같은 본문을 AI도 받음) | ai-pbx-recordings, active-call-count, `ai/pbx-sip.md` | `pbx_webhook.create_call_ended_router` |

## rebuild에서 BE 최신 계약에 맞춘 것 (2026-11-03)

- **위도·경도 제거**: 주문 주소, 주소록 저장, 응답 파싱, 가짜 백엔드에서 뺐다. `Geo`는 지번·동명·우편번호만 담는다.
  - 원래 AI 코드(`S15P31D109/ai`, develop-ai df93338)는 아직 좌표를 보낸다.
  - BE a629c60이 배포된 서버에서는 `POST /api/orders`와 주소록 저장이 400이 된다.
