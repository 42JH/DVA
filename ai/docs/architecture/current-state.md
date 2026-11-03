# 현재 상태 분석 (Current State)

> 2026-11-03 이후: 이 문서의 `tools/rag/`는 원본 그대로인 `app/rag/`로 교체됐다(RAG는 다른 담당자 구현, 수정 금지 — `decisions.md` RAG). 본문은 분석 당시 기록이다.

작성일: 2026-11-03 · 대상: 이 저장소(원본 `S15P31D109/ai` `exp/no-speech-injection`에서 통화 흐름을 뺀 모듈 4개)
검증: `uv run pytest -q` → **364 passed** (외부 서비스 미호출)

> 결론 먼저: 이 저장소는 **"통화 흐름이 빠진 부품 모음"**이다. 서버 진입점(`main.py`), GPT-Live-1 세션 설정, Responses Delegation,
> sideband, 통화 상태(Call), 흐름 엔진, 통화 결과 전송 조립, 인사이트 본문 생성, 페르소나 적용은 **코드에 존재하지 않는다**.
> 따라서 아래 "문제"의 상당수는 부품의 문제이고, 생명주기·동시성 문제는 "누락"으로 기록한다.

---

## 1. 모듈 구조와 의존성

```
pbx_webhook/        (의존: fastapi, pydantic, openai 클라이언트 duck-typing)
address_resolver/   (의존: sqlite3, httpx2)                     ← 전역 _db, 전역 threading.Lock
backend_client/     (의존: httpx2, address_resolver.kakao.Geo, address_resolver.corrector(jamo, lev, to_number))
tools/              (의존: openai(pydantic_function_tool), backend_client, address_resolver)
tools/rag/          (의존: langchain-*, qdrant-client, kiwipiepy, rank-bm25, httpx)   ← tools/와 독립
```

| 모듈 | 파일 | 책임 | 외부 I/O |
|---|---|---|---|
| `pbx_webhook` | `incoming.py`, `call_ended.py`, `sip.py` | OpenAI SIP 수신 웹훅 검증·중복 제거·백그라운드 콜백, PBX 종료 웹훅 인증·파싱, 발신번호 정규화, hangup | OpenAI REST(hangup) |
| `address_resolver` | `__init__.py`, `corrector.py`(436줄), `db.py`, `kakao.py`, `stt_preprocess.py` | STT 주소 → 행안부 주소DB 도로명 보정, 카카오 지번·동·우편번호 | SQLite(ro), Kakao REST |
| `backend_client` | `api.py`(454줄), `order.py`, `mock.py` | BE REST 클라이언트, 임시 주문 `Order`/`Place` 모델, 핀 매칭 알고리즘, 메모리 가짜 BE | BE REST |
| `tools` | `base.py`, `runner.py`, `context.py`, 도구 5개 | 도구 등록·스키마·실행기, 통화별 도구 컨텍스트 | 위 모듈 경유 |
| `tools/rag` | 29파일 | 하이브리드 검색(BM25+Qdrant)·리랭커·FAQ 동기화(큐·색인·웹훅)·GPU 리랭커 서버 | OpenAI Embeddings, Qdrant, Reranker, SQLite |

의존 방향 관찰:
- `backend_client.order`(도메인 모델)가 `address_resolver.corrector`의 자모 함수를 **함수 내부 import**로 사용(`order.py:128,146`) → 도메인 모델이 주소 보정 구현에 결합.
- `tools/base.py:9`가 `openai`를 import → 도메인 계층(도구 정의)이 SDK에 결합.
- `tools/__init__.py`는 의도적으로 비어 있음(RAG 단독 사용 시 백엔드 의존성 차단, `tools/__init__.py:3`).
- 순환 의존 없음.

## 2. 외부 연동 요약

| 연동 | 방향 | 계약 문서 | 구현 |
|---|---|---|---|
| OpenAI SIP 수신 웹훅 | OpenAI→AI | `docs/contracts/pbx-webhooks.md` §1 | `pbx_webhook/incoming.py` |
| OpenAI Live 세션 제어(accept/reject/refer/sideband) | AI→OpenAI | 同 §1.3 | **hangup만** |
| PBX 종료 웹훅 | PBX→AI | 同 §2 | `pbx_webhook/call_ended.py` |
| BE REST | AI→BE | `docs/contracts/be-api.md` | `backend_client/api.py` |
| BE FAQ 변경 알림 | BE→AI | `be-api.md` §14 | `tools/rag/faq_webhook.py` (기동 연결 없음) |
| BE 페르소나 알림/옵션 | BE→AI | `be-api.md` §13 | **없음** |
| Kakao Local | AI→Kakao | — | `address_resolver/kakao.py` |
| Qdrant/Embeddings/Reranker | AI→인프라 | — | `tools/rag/*` |

## 3. GPT-Live-1 세션 및 Responses Delegation 구성

**코드에 없음.** 저장소에서 확인되는 것은 다음뿐이다.

- `client.webhooks.unwrap`, `client.live.sessions.hangup` 호출(`pbx_webhook/incoming.py:60,84`).
- 도구 정의 생성기 `Tool.spec()` — docstring상 "live.toml에 이름만 적은 함수 도구를 채운다"(`tools/base.py:84`). `live.toml`은 저장소에 없음.
- `tools/rag/text_agent.py`의 `client.responses.create` 루프 — **실험용**(전화 세션 미사용, docstring `:1`). Responses Delegation과 무관.
- 문서 서술(`docs/call-flow/flow.md`, `voice.md`, `flow.toml`): Live-1이 대화를 이끌고 `<|SpawnThinking|>`로 백엔드 모델에 위임, 백엔드가 보고하는 도구 `record_order`·`answer`·`switch_task`·`search_manual`·`match_pins`·`lookup_orders`·`get_state`. `thinking.append`/`commentary.append`/`session.update`/`session.instructions.append`/위임 안전망(`delegate_wait_sec`)은 **옛 구현 장치**로 표시됨(`docs/call-flow/README.md:5`).
- "Responses Delegation"이라는 용어, Live 세션 파라미터(voice·VAD·모델), 위임 모델 설정은 저장소 문서·코드 **어디에도 정의가 없다 → 확인 필요.** 운영 지시문은 BE 페르소나 ACTIVE `promptText`(`docs/call-flow/README.md:20`).

## 4. Tool Calling

상세 계약은 `docs/contracts/tool-contracts.md`. 구조 요약:

```
(모델/서버) ─ name, arguments_json, call_id ─▶ run_tool(ctx, ..., allowed)
     TOOLS[name] → Args.model_validate_json (strict) → allowed 확인 → wait_for(tool.run(ctx,args))
     ◀─ {"ok": true, ...} | {"ok": false, "error", "retry", ...}
     ctx.records[call_id] 기록
```

- 도구가 결과를 `ctx`에 남기고(`pin_candidates`, `orders`, `running_ops`) 다음 도구·서버가 읽는 **암묵적 상태 전달** 구조.
- 판단(모델)과 실행(서버)의 구분은 `allowed` 인수 하나에 의존. 서버 전용 `cancel_order`도 모델 스키마로 노출 가능.

## 5. Address Resolver 인터페이스

| 함수 | 시그니처 | 동작 |
|---|---|---|
| `load(path)` | `Path -> bool` | 전역 `_db = AddressDB(path)`. 없으면 보정 끔 (`__init__.py:18-28`) |
| `correct(text)` | `async str -> dict|None` | `to_thread` + **전역 `threading.Lock`** 하에 `corrector.correct(_db, text)`. 결과 `{"status": confirmed|ambiguous|not_found, "address", "candidates"[≤3], ("weak")}` (`__init__.py:31-41`, `corrector.py:396-436`) |
| `kakao.geocode(address, timeout_sec, transport=None)` | `async -> Geo|None` | 호출마다 **새 `httpx2.AsyncClient`** 생성, 모든 예외 → None (`kakao.py:67-86`) |
| `db.build(src, out)` | CLI | 주소DB 생성 |

- 확정 규칙: 1등만 `MARGIN` 안에 있고 거리 ≤`CONFIRM_MAX`, 번호 거리 ≤`NUM_CONFIRM_MAX`이면 confirmed(`corrector.py:432-436`). 연음 길 번호(`unlink_gil`) 1회 재시도.
- `AddressDB`: 읽기 전용 SQLite, `check_same_thread=False`, 지역별 도로 지연 캐시(`_LazyRoads`, 가변 dict) — 락이 필요한 이유(`db.py:84-106`).
- 한계: 지하 건물 미처리(`db.py:113` shortcut).

## 6. RAG 인터페이스

| 항목 | 내용 | 근거 |
|---|---|---|
| 호출 | `await RagService(cfg, faq_index=?, reranker=?)(question)` | `tools/rag/service.py:117-119` |
| 반환 | `{"context": {status: found|no_evidence, question, evidence[≤3]{rank,chunk_id,source_id,title,content}}, "reranked": [...reranker_score...], "timings", + 진단 키(rrf_candidates, bm25_results, dense_results, search_timings, ...)}` | `service.py:111-115`, `schemas.py` |
| 파이프라인 | Kiwi 토큰화+BM25 → OpenAI Embedding(`text-embedding-3-large`, 5s, 재시도 0) → Qdrant(5s) → RRF(0.4, c=60) → 원격 리랭커 Top5(5s) — **모두 순차, 스레드 내 동기** | `hybrid.py`, `service.py:57-73`, `remote.py` |
| 생성형 LLM | 검색 경로엔 **없음** | `text_agent.py`·`prompts.py`는 테스트 전용 |
| FAQ 동기화 | 웹훅(202 영속 후) → SQLite WAL 큐 → 단일 소비자 `FaqProcessor`(FIFO, 지수 백오프 5~300s) → `BackendFaqSource` → `FaqIndex`(임베딩 캐시, Qdrant stage/verify, 세대 커밋) | `faq_webhook.py`, `faq_events.py`, `faq_processor.py`, `faq_index.py` |
| 기동 연결 | **없음**(라우터·프로세서·부트스트랩을 마운트하는 코드 부재) | 저장소 전체 |
| 설정 | `tools/rag/data/rag.toml` `[rag]`, `[faq_sync]`(`receive_enabled=false`, `process_enabled=false`, `db_path` 상대경로) | `config.py` |

## 7. 업무 상태 관리

| 상태 | 보관 위치 | 수명 | 문제 |
|---|---|---|---|
| 임시 주문(택배 1개) | `ToolContext.order` (mutable pydantic) | 통화(호출자가 관리) | 여러 택배·담기 목록 없음 |
| 수거 시각·고객명 | `ToolContext.pickup_at/customer_name` | 통화 | — |
| 핀 후보 / 조회 결과 | `ctx.pin_candidates`, `ctx.orders` | 다음 호출이 덮어씀 | 도구 간 암묵 전달 |
| 쓰기 작업 기록 | `ctx.running_ops[operation_id]` | 통화 | 메모리, 재시작 시 소실 |
| 도구 실행 기록 | `ctx.records[call_id]` | 통화 | PII, 무제한 증가 |
| 웹훅 중복 제거 | `_Dedupe.seen` (라우터 클로저) | 프로세스, TTL 1h | 다중 인스턴스 미지원, 매 요청 O(n) 정리 |
| 백그라운드 작업 | `tasks` set (라우터 클로저) | 프로세스 | shutdown 처리 없음 |
| 주소DB | 모듈 전역 `_db`, `_lock` | 프로세스 | 테스트 monkeypatch 필요 |
| 도구 레지스트리 | 모듈 전역 `TOOLS` | 프로세스 | import 부작용 |
| 통화 결과 키·본문 | **없음** | — | `result_body`는 순수 함수만 존재 |
| 흐름 단계·확인 관문·두 열쇠 | **없음** | — | 새 서버의 몫 |

## 8. 예외 처리 현황

| 위치 | 방식 | 평가 |
|---|---|---|
| `tools/runner.py:42-49` | `ToolError`/`TimeoutError`/`Exception` → 오류 dict | 통화 유지는 좋으나 업무/시스템 오류 구분 코드 없음 |
| `backend_client/api.py` | 비정상 상태 → `BackendError(문자열)` | 상태코드·error.code를 구조로 노출하지 않음. TransportError 래핑이 메서드마다 제각각(`search_company_places`·`faq_page`·`persona_result`만 래핑) |
| `api.py:244-251` | 이전 주소 조회 실패 → 경고 후 진행 | 의도된 저하 |
| `api.py:268` | pins 409 전부 성공 | 상태 오류 삼킴 |
| `pbx_webhook/incoming.py:53-57` | 콜백 예외 `log.exception`만 | 통화가 accept/reject 없이 방치될 수 있음 |
| `pbx_webhook/incoming.py:59-62` | `unwrap` 모든 예외 → 400 | 비밀값 미설정 등 설정 오류도 400으로 보임 |
| `pbx_webhook/call_ended.py:48` | 콜백 예외 처리 없음 | 500 응답 |
| `address_resolver/kakao.py:77` | 모든 예외 → None | 장애와 "못 찾음" 구분 불가 |
| `tools/match_pins.py:46` | 모든 예외 → ToolError | 업무 메시지는 적절 |
| `tools/cancel_order.py:43-46` | `BaseException` → unknown 후 재발생 | 좋음(불확실 상태 기록) |
| `tools/rag/service.py:31-35`, `faq_processor.py:134,141,146` | 넓은 except + 로그 | 백그라운드 루프 유지 목적 |

## 9. 테스트 현황

- 364 테스트, 외부 호출 없음. `conftest.py`가 주소DB 끄기(autouse), 가짜 카카오, 서명 웹훅 생성기 제공.
- `MockBackend`가 `BackendAPI` 공개 메서드 동치 여부를 테스트로 검사(`backend_client/tests/test_company_and_mock.py`).
- 계약 테스트(BE 원문 스키마 기준 검증) 없음. Mock은 BE 검증 일부만 흉내.
- 통화 시나리오(E2E)·지연 측정 테스트 없음.

---

## 10. 아키텍처 문제 목록 (근거 포함)

### 10.1 모듈 간 강한 결합
| # | 문제 | 근거 |
|---|---|---|
| C1 | 도메인 모델(`backend_client.order`)이 주소 보정 내부 함수(`jamo`, `lev`, `to_number`)를 import | `backend_client/order.py:128,146` |
| C2 | `Geo`가 `address_resolver.kakao`에 정의되고 `backend_client`가 재수출 → BE DTO가 외부 API 어댑터 모듈에 묶임 | `order.py:7`, `kakao.py:56` |
| C3 | 도구 정의가 `openai.pydantic_function_tool`에 의존 | `tools/base.py:9,85` |
| C4 | `ToolContext.backend: Any`, `rag: Callable` — 인터페이스(Protocol) 부재로 결합이 암묵적 | `tools/context.py:14,21` |
| C5 | `record_order`가 모듈 전역 `address_resolver.correct`·`kakao.geocode`를 직접 호출(주입 불가, 테스트는 monkeypatch) | `tools/record_order.py:10-11,74,85`, `conftest.py:33-44` |
| C6 | `BackendAPI` 한 클래스가 고객·주문·FAQ·페르소나·인사이트·옛 계약까지 담당(인증 방식 3종 혼재) | `backend_client/api.py` |

### 10.2 중복된 책임
| # | 문제 | 근거 |
|---|---|---|
| D1 | 전화번호 정규화 3벌: `normalize_caller`(SIP), `normalize_phone`(도구), BE 규칙(3~20자리) — 규칙 상이 | `pbx_webhook/sip.py:22`, `tools/base.py:140` |
| D2 | 한글 숫자 변환 2벌 | `tools/base.py:133-137`, `address_resolver/stt_preprocess.py`, `corrector.to_number` |
| D3 | `search_manual` 도구 2벌(스키마·반환 계약 상이) | `tools/search_manual.py`, `tools/rag/text_agent.py:16-20` |
| D4 | 타임아웃 이중: runner 12s + RagService 12s | `tools/runner.py:39`, `tools/rag/service.py:119` |
| D5 | `Args`/`strict` 모델 패턴이 `text_agent.ManualQuery`에 재정의 | `text_agent.py:10-13` |
| D6 | 이름 부분 일치 로직이 `lookup_orders`와 `order._contains`에 따로 존재 | `lookup_orders.py:31-32`, `order.py:106-111` |

### 10.3 암묵적 상태 관리
| # | 문제 | 근거 |
|---|---|---|
| S1 | 도구가 결과를 `ctx`에 써서 다음 도구에 전달(`pin_candidates`→선택, `orders`→취소) — 계약에 드러나지 않음 | `match_pins.py:36,60`, `lookup_orders.py:31,42` |
| S2 | `record_order`가 부분 반영 후 실패(`ok:false`) — 실제 상태와 모델 인식 불일치 | `record_order.py:44-60` |
| S3 | ambiguous 주소를 1순위로 **확정 기록** | `record_order.py:83-84` |
| S4 | 주소 변경 시 상세주소를 조용히 지움 | `record_order.py:41-43` |
| S5 | 모듈 전역 상태(`_db`, `_lock`, `TOOLS`, `get_kiwi` lru_cache) | `address_resolver/__init__.py:14-15`, `tools/base.py:90`, `tools/rag/tokenization.py` |

### 10.4 세션·통화 생명주기 관리 누락
| # | 문제 | 근거 |
|---|---|---|
| L1 | 통화 객체·레지스트리 없음: 수신→accept→sideband→종료→결과 전송→인사이트 전송 흐름 전체 부재 | 저장소 전체(README "가져오지 않았다") |
| L2 | PBX 종료 웹훅 ↔ 진행 통화 매칭(발신번호 + `endedAt` 이전 시작) 미구현 | `call_ended.py:4` docstring만 |
| L3 | "accept 중 종료 → accept 직후 hangup, sideband 미개시" 미구현 | `docs/be-contract/ai/pbx-sip.md` |
| L4 | 고객 확인 2단계(조회 → 의도 확인 후 등록, 30분 시한) 순서 강제 장치 없음 | `be-api.md` §1 |
| L5 | 앱 shutdown 시 백그라운드 작업·HTTP 클라이언트·RAG 정리 없음 | `incoming.py:51`, `api.py:185` |
| L6 | 동시 통화 상한·세션 만료(`expires_at`)·컨텍스트 엔진 교체 대응 없음 | `pbx-sip.md` 한도 절 |
| L7 | 통화 결과 Idempotency-Key·최초 본문 보관(재시작 내구성) 없음 | `be-api.md` §8 |

### 10.5 예외 처리 누락
| # | 문제 | 근거 |
|---|---|---|
| E1 | `submit_result` 503 즉시 실패(BE는 같은 키 확인 권고) | `api.py:26,337`, `B/ai-order-billing-integration.md:220` |
| E2 | `caller_context` 등 다수 메서드가 `TransportError` 미래핑, `resp.json()["data"]` KeyError 가능 | `api.py:228-231, 256, 265, 273, 288, 297, 312, 376` |
| E3 | BE 오류 코드(400/403/409 INVALID_STATE/422)를 구조화하지 않아 "BE 장애 vs 고객 입력 오류" 구분 불가(AGENTS.md §6) | `api.py:41`, `runner.py:47-49` |
| E4 | 카카오 장애를 "주소 없음"과 같은 None으로 처리 | `kakao.py:77-79` |
| E5 | 수신 콜백 예외 시 통화 방치(reject/hangup 없음) | `incoming.py:53-57` |
| E6 | `cancel_order` 409 후 재조회 실패 시 `outcome` 없는 내부 오류 | `cancel_order.py:54` |
| E7 | `persona_token=None` → `Bearer None` | `api.py:372` |

### 10.6 동시성·Race Condition 위험
| # | 문제 | 근거 |
|---|---|---|
| R1 | 주소 보정 전역 `threading.Lock` — 모든 통화의 주소 보정이 직렬화(동시 통화 시 지연 누적) | `address_resolver/__init__.py:15,40` |
| R2 | 같은 통화에서 도구 병렬 실행 시 `ctx.order`/`pin_candidates`/`orders` 경합(보호 장치 없음) | `tools/context.py` |
| R3 | `cancel_order`의 중복 방지(`running_ops`)는 동시 두 호출 사이에 체크-후-기록 경합 가능(await 사이) | `cancel_order.py:30-42` |
| R4 | `wait_for(to_thread)` 타임아웃 후에도 스레드 지속 → 기본 executor 포화 | `service.py:119`, `address_resolver/__init__.py:36` |
| R5 | 웹훅 중복 제거가 프로세스 메모리 — 다중 워커/인스턴스에서 같은 통화 중복 accept 가능 | `incoming.py:30-46` |
| R6 | PBX 종료 웹훅 매칭이 발신번호 기반 — 같은 번호 동시 통화·시계 오차 시 오종료 | `pbx-sip.md` |
| R7 | Kiwi 전역 인스턴스 스레드 안전성 확인 필요 | `tokenization.get_kiwi` |

### 10.7 불필요한 LLM 호출
- 이 저장소의 운영 경로에는 생성형 LLM 호출이 없다(RAG는 임베딩 1회/질의). 
- 문서상 옛 구조의 문제(참고): 서버 판별기(별도 분류 호출) + Live 보고의 이중 판정(두 열쇠), 위임 안전망에 의한 추가 위임, `answer`/`switch_task`/`get_state` 같은 흐름 보고용 도구 호출 — 이는 **모델 왕복을 늘리는 구조**다(`docs/call-flow/flow.md:20-24,63,102`). 새 설계에서 측정 후 판단 필요.
- `lookup_orders`가 개수만 반환 → 모델이 상세를 얻기 위해 추가 왕복이 필요할 수 있는 계약(`lookup_orders.py:43`).

### 10.8 지연을 늘리는 순차 실행
| # | 문제 | 근거 |
|---|---|---|
| P1 | `caller_context` 후 ORIGIN·DESTINATION 이력 2건 **순차** | `api.py:246-249` |
| P2 | `record_order`가 sender·receiver 주소를 순차 보정·지오코딩(최대 2×(보정+카카오 3s)) | `record_order.py:72-90` |
| P3 | 카카오 호출마다 새 HTTP 클라이언트(연결·TLS 재사용 없음) | `kakao.py:73` |
| P4 | RAG 임베딩→Qdrant→리랭크 순차, 단계별 5s ×3 > 전체 12s | `service.py`, `remote.py` |
| P5 | `find_parcels` N+1(병렬이지만 상한 없음, 1건 실패 시 전체 실패) | `api.py:288-293` |
| P6 | 주소 보정 전역 락(R1)으로 통화 간 직렬화 | `address_resolver/__init__.py` |
| P7 | 지연 측정 지표(첫 유효 음성 응답, P50/P95) 수집 코드 없음 | 저장소 전체 |

### 10.9 테스트하기 어려운 구조
| # | 문제 | 근거 |
|---|---|---|
| T1 | 전역 함수·모듈 상태 의존 → monkeypatch 필수 | `conftest.py:32-44` |
| T2 | `RagService` 레거시 경로·`create_faq_runtime`이 env·클라이언트 직접 생성 | `service.py:57-69`, `faq_runtime.py:40-71` |
| T3 | `future_time`·`is_past`가 `datetime.now()` 직접 호출(시계 주입 없음) | `tools/base.py:111-128` |
| T4 | `submit_result`가 `time.monotonic`·`asyncio.sleep` 직접 사용 | `api.py:324-345` |
| T5 | 도구 등록이 import 부작용 | `tools/registry.py` |
| T6 | 오류가 한국어 문자열 → 테스트가 문구에 의존 | `runner.py`, 각 도구 |
