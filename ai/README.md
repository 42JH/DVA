# 재구성용 모듈

디바콜 전화 접수 서버(`S15P31D109/ai`, 2026-11-03 `exp/no-speech-injection` 기준)에서 통화 흐름과 상관없는 기능만 떼어 낸 모듈 네 개다. 통화 흐름(단계, 진행 상태, 판별기, sideband, Live 세션 설정, 관제, 페르소나 관리)은 가져오지 않았다. 그 부분은 새로 만들 서버가 이 모듈들을 조합해 구현한다.

BE 통신 규약은 `docs/be-contract/`에 있다(BE 원문 + AI 쪽 사용 문서). **BE 구조는 바꾸지 않는다.** 어긋나면 AI 모듈이 맞춘다.
지켜야 할 통화 흐름(받는 순서, 확인 관문, 문구, 다이어그램)은 `docs/call-flow/`에 있다(README에 우선순위와 BE와 부딪히는 곳).

```
pbx_webhook/       PBX·OpenAI 웹훅 수신        (의존: 없음)
app/address/       주소 보정(주소DB)            (의존: 없음)
backend_client/    BE 서버 API 클라이언트·가짜  (의존: app.address의 자모 비교)
tools/             도구 5개·실행기            (의존: backend_client, app.integrations.address, app.rag.schemas)
app/rag/ 등        RAG — 원본 그대로, 수정 금지 (아래 'RAG' 절)
```

## 사용법

```
uv sync
docker compose up -d --build   # Qdrant + AI 서버. docs/ops/docker.md
```

## pbx_webhook: 전화 수신

- `create_incoming_router(client, on_incoming)`: OpenAI SIP 수신 웹훅(`/api/webhooks/openai/call-incoming`)을 받는다.
  - 서명을 검증하고, 같은 webhook-id는 무시하고, 바로 200을 돌려준다.
  - `IncomingCall(session_id, caller, incoming_at, data)`를 백그라운드로 콜백에 넘긴다.
  - accept·reject는 콜백이 직접 한다(`client.live.sessions.accept/reject`).
- `create_call_ended_router(on_call_ended)`: PBX 통화 종료 웹훅(`/pbx/webhook/call-ended`)을 받는다.
  - `PBX_WEBHOOK_SECRET` Bearer 토큰이 맞아야 하고, 본문을 `CallEnded`로 검증한다.
  - 같은 번호로 다시 건 통화를 끊지 않게, 콜백은 `ended_at` 전에 시작한 통화만 끝내야 한다.
- `hangup_quietly`: 세션이 이미 끝났으면(404) 오류로 보지 않는다.
- 발신번호 처리: `caller_from_headers`, `normalize_caller`, `mask_phone`. 발신번호는 미신뢰 값이다.
- 원본 `app/webhooks/openai.py`에 있던 통화 등록, 동시 통화 상한, 페르소나, 세션 설정, sideband 시작은 빠졌다.

## backend_client: BE 서버 통신

- `api.BackendAPI`: 원본 `app/backend_api.py` 그대로다.
  - 고객 확인, 주소 이력, 주소록 저장, 고객 등록, 기업 배송지 검색, 조회·취소, 통화 결과 접수(Idempotency-Key), 통화 기록·분석, 페르소나, FAQ 원문.
- `order.py`: 임시 주문 `Order`, 배송지 `Place`, 기업 후보 `CompanyPlace`, 배송지 매칭 `match_places`, 후보 이름표 `pin_labels`.
- `mock.MockBackend`: 메모리 가짜 백엔드. `BackendAPI`의 공개 메서드를 모두 갖는지 테스트가 검사한다.
- 원본과 다른 점:
  - **FAQ 조회**: 원본과 같은 `faq_entries(ids)`·`initial_faq_entries()`(원본 RAG가 부른다, 파싱은 `app.rag.faq_source`).
  - **가짜 백엔드 지시문**: `MockBackend.use_voice_prompt()`는 `use_prompt(prompt)`로 바꿨다. 원본 설정 파일을 읽지 않는다.
  - **위도·경도 제거**: BE 최신 계약(develop-backend a629c60, `address-coordinates-removal.md`)에 맞춰 주소 요청·응답에서 뺐다. 보내면 400이다. 가짜 백엔드도 좌표가 오면 400으로 거절한다.
  - **고객 확인 2단계**: 전화 수신 직후에는 `caller_context(phone)`로 조회만 하고, 업무 의도를 확인한 뒤 `caller_context(phone, call)`로 통화를 등록한다(`meaningful-call-registration-handoff.md`). 이 순서는 새 서버가 지킨다. `call`의 `providerCallId`·`incomingAt`은 최초 수신 이벤트 값으로 고정한다.

## app/address: 주소 보정

- `gazetteer.open_db(path)`로 행안부 주소DB(SQLite, 읽기 전용)를 연다. 파일이 없으면 None → `AddressService(None)`은 보정 없이 들은 그대로(`off`).
- `matcher.resolve(db, text)` → `Resolution(status, address, candidates)`: `confirmed`(확정)·`ambiguous`(애매함)·`not_found`(없음). 들은 그대로 못 찾았을 때만 `parse.readings`(말끝·붙인 길 번호·건물명·붙인 '다시'·"N가")의 표기로 적게 고친 것부터 다시 본다(묶음 8개·1초 상한).
- 나눔: `numbers`(한글 숫자) · `phonetic`(소리 비교, `backend_client.place_score`도 씀) · `parse`(말 다듬기) · `matcher`(찾기·판정) · `gazetteer`(조회·빌드). 스레드마다 SQLite 연결 — 전역 락 없음.
- `app/integrations/address.py` `AddressService`: 전용 스레드풀·예산 3초·카카오. `app/integrations/kakao.py` `geocode()`는 지번·동명·우편번호(`app.domain.state.Geo`), 키가 없거나 못 찾으면 None.
- BE 모양 `Geo`(pydantic)는 `backend_client/order.py`에 있다.
- 주소DB 만들기: `uv run python -X utf8 -m app.address.gazetteer <주소DB 텍스트 폴더> data/address.db`

## tools: 도구와 RAG

- 실행: `run_tool(ctx, name, arguments_json, call_id, allowed=None)` 한 곳에서 한다(원본 `app/dispatcher.py`).
  - 인수를 strict 스키마로 검증하고, 허용 목록을 확인하고, 시간 제한을 건다.
  - 오류는 모두 `{"ok": false, "error", "retry"}`로 돌려준다.
- 함수 도구 정의: `tools.registry.TOOLS[name].spec()`
- 컨텍스트 `ToolContext`: 원본 통화 객체(`Call`)에서 도구가 쓰던 값만 남겼다.
  - 통화 값: 주문, 발신번호, 통화 번호, 받는 곳 후보, RAG 함수.
  - 설정: 시간 제한, 후보 수 등.

| 도구 | 하는 일 | 원본에서 뺀 것 (새 서버의 몫) |
|---|---|---|
| `record_order` | 값을 기록한다. 전화번호와 수거 시각을 검증하고, 주소는 보정하고 좌표를 붙인다. 결과에 정정된 항목(`changed`), 확인할 번호(`phones_to_confirm`), 주소 결과(`addresses`)를 담는다. | 주소록에 비슷한 받는 곳이 있으면 먼저 확인하기, 정정·번호 확인 문구, 신규 고객 자동 등록 |
| `match_pins` | 받는 곳을 찾는다. 개인 주소록(최근 N개 먼저)에서 찾고, 없으면 기업 배송지를 검색한다. 결과는 `status`(one, many, more, none, ask_place, ask_name)와 후보 이름표다. | 여러 턴에 들은 조건 합치기, 아니라고 한 후보 빼기, `restart` 인수 |
| `lookup_orders` | 이 통화 고객의 최근 택배를 받는 분 성함으로 찾는다. | 흐름 사건 |
| `cancel_order` | 서버만 부르는 취소. `customer_confirmed`와 작업 번호가 필요하고, 재시도 전에 이미 취소됐는지 조회로 확인한다. 결과는 `outcome`(done, already, locked, failed)이다. | 흐름 사건 |
| `search_manual` | 매뉴얼을 검색한다. 결과는 근거와 `answerable`(임계값)이다. | 흐름 사건 |

- 원본의 `answer`, `switch_task`, `get_state`는 흐름 엔진 전용이라 가져오지 않았다. `modify_order`는 원본에서 사용을 보류한 도구라 가져오지 않았다.
- RAG는 아래 'RAG' 절.
  - **FAQ 변경 알림 웹훅**: `faq_webhook.create_faq_router(cfg, get_store, get_processor)`
  - **FAQ 소비자**: `FaqProcessor(events, BackendFaqSource(backend_api), index, ...)`
  - **`faq_sync.db_path`**: 상대 경로다. 원래는 서버 루트 기준이었으므로 새 서버가 기준을 정한다.

## 가져오지 않은 테스트

- 운영 스크립트·배포 파일을 시험하던 것: `test_faq_crud_validation`, `test_validation_embeddings`, `test_faq_deploy_runtime`, 그리고 점검 CLI 시험 2개.
- 원본 `app/main.py`의 기동 연결을 시험하던 것: FAQ 앱 팩토리 3개.
- 통화 객체·흐름 엔진에 묶인 도구 시험: 새 인터페이스로 다시 썼다(`tools/tests/test_tools.py`, `pbx_webhook/tests/test_webhooks.py`).

## 환경변수

| 변수 | 쓰는 곳 |
|---|---|
| `OPENAI_WEBHOOK_SECRET` | 웹훅 서명 검증. `AsyncOpenAI(webhook_secret=...)`에 넣는다 |
| `PBX_WEBHOOK_SECRET` | PBX 종료 웹훅 |
| `BACKEND_API_URL`, `AI_PERSONA_TOKEN`, `AI_INSIGHTS_TOKEN` | `BackendAPI`를 만들 때 |
| `KAKAO_REST_API_KEY` | 주소 좌표 |
| `QDRANT_URL`, `QDRANT_API_KEY`, `RAG_RERANKER_URL`, `RAG_RERANKER_API_KEY`, `AI_FAQ_TOKEN` | RAG와 FAQ 동기화 |
| `CONFIG_DIR`, `PROMPTS_DIR` | RAG 설정(`config/`)·템플릿(`prompts/`) 위치 바꾸기(원본과 같음) |

## RAG (원본 그대로, 수정 금지)

RAG는 다른 담당자의 구현이다. 원본 `S15P31D109/ai`(`exp/no-speech-injection` 59d1def)에서 **경로·내용 그대로** 복사했고 이 저장소에서 고치지 않는다(`docs/architecture/decisions.md` RAG).

| 원본 그대로 | 내용 |
|---|---|
| `app/rag/` | 하이브리드 검색(Kiwi BM25 + Qdrant), 리랭커 호출(`remote.py`), GPU 리랭커 서버(`gpu.py`·`qwen.py`), FAQ 동기화 큐·색인·소비자 |
| `app/webhooks/faqs.py` | BE → AI FAQ 변경 알림 `POST /internal/faqs/refresh` |
| `manuals/`, `config/rag-search-descriptions.json`, `config/faq-bm25-descriptions.json`, `prompts/rag_context.md` | 매뉴얼 원문·검색 설명·RAG 템플릿 |
| `config/server.toml`의 `[rag]`·`[faq_sync]` | RAG 설정(원본 섹션 그대로) |
| `gpu/` | 리랭커 서버 이미지(`docker build -f gpu/Dockerfile .`) |
| `scripts/`(라이브 랩 전용 3개 제외), `spec/rag.md`, `spec/faq-sync.md`, `docs/rag-handoff.md` | 색인·진단·평가 스크립트와 문서 |

원본 RAG가 import하는 원본 서버 공용 모듈은 **우리 쪽 호환판**으로 둔다(RAG 파일은 건드리지 않음):

| 호환판 | 원본에서 RAG가 쓰는 것 |
|---|---|
| `app/config.py` | `ROOT`, `config_dir()`, `prompts_dir()`, `RagConfig`·`FaqSyncConfig`(원본 정의 그대로), `load_server_config().rag/.faq_sync/.backend.timeout_sec` |
| `app/backend_api.py` | `BackendAPI`, `BackendError` → `backend_client.api` (FAQ 메서드 `faq_entries`·`initial_faq_entries`는 원본 그대로 옮김) |
| `app/webhooks/pbx.py` | `token_ok` → `pbx_webhook.sip.token_ok` |
| `app.state.svc` | `faqs.py`가 읽는 `cfg.faq_sync`·`faq_events`·`faq_processor` — 라우터를 붙이는 쪽이 만든다(`app/tests/test_rag_compat.py`) |
